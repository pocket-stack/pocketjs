// compiler/fig.ts — compile-time .fig (Figma file) decoder + rasterizer.
//
// Feeds offline bakers (demos/figma/gen-assets.ts): open a .fig export, expand
// its component instances, and rasterize any page region at any scale into RGBA
// pixels — which the baker then quantizes into TILESET pak entries (spec.ts).
// Build-time ONLY: runs under Bun, uses @napi-rs/canvas (Skia) for rasterizing
// and kiwi-schema for the container schema. Nothing here ships to a device.
//
// .fig container format (reverse-engineered, stable across recent exports):
//   * The .fig itself is a plain ZIP: canvas.fig (the scene), meta.json,
//     thumbnail.png, images/<sha1-hex> (fill bitmaps, PNG/JPEG).
//   * canvas.fig = 8-byte magic "fig-kiwi", u32 LE version, then chunks of
//     u32 LE byteLength + compressed payload. Payloads are zstd (magic
//     0x28 b5 2f fd) in current exports, raw-deflate in older ones.
//   * chunk 0 is a kiwi BINARY SCHEMA (fig ships its own schema per file so
//     old readers skip fields they don't know); chunk 1 is the kiwi message:
//     { nodeChanges: [...], blobs: [{ bytes }] }. Nodes reference geometry by
//     blob index.
//   * Path blobs: repeated [u8 cmd, f32 LE coords]: 0=Z close, 1=M moveTo(2),
//     2=L lineTo(2), 3=Q quadTo(4), 4=C cubicTo(6). Page coordinates.
//   * TEXT nodes carry derivedTextData: pre-shaped glyphs, each with a path
//     blob in Y-UP EM UNITS — draw with ctx.scale(fontSize, -fontSize).
//   * INSTANCE overrides are keyed by guidPath; nodes copied from a library
//     carry overrideKey = their ORIGINAL guid, which is what guidPaths keep
//     referencing (see buildRenderTree — the remap is subtle and load-bearing).
//   * Scaled instances: derivedSymbolData carries POST-SCALE transforms and
//     geometry. Never apply symbolData.uniformScaleFactor yourself or scaled
//     components render double-scaled.
//
// The renderer is intentionally a "good enough for wireframe kits" subset:
// solid + linear-gradient + image fills, MULTIPLY blend, drop shadows on own
// geometry, frame clipping and mask children. It was validated visually
// against every page of the Paper Wireframe Kit; extend as source files need.

import { inflateRawSync } from "node:zlib";
import { decodeBinarySchema, compileSchema } from "kiwi-schema";
import {
  createCanvas,
  loadImage,
  DOMMatrix,
  Path2D,
  type Canvas,
  type Image,
  type SKRSContext2D,
} from "@napi-rs/canvas";

/** Decoded fig scene node — schema-defined, so dynamically shaped. */
// deno-lint-ignore no-explicit-any
type FigNode = any;

export interface FigColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FigPage {
  /** Index into FigDoc.pages (== renderRegion's pageIndex). */
  index: number;
  name: string;
  /** Canvas background (defaults to Figma's light gray when unset). */
  background: FigColor;
  /** Union AABB of visible top-level children, page coords; null if empty. */
  bounds: FigBounds | null;
}

interface TopLevel {
  tree: RNode;
  aabb: FigBounds;
}

export interface FigDoc {
  pages: FigPage[];
  /** @internal scene guts (guid-keyed nodes, blobs, decoded fill images). */
  nodes: Map<string, FigNode>;
  childrenOf: Map<string, FigNode[]>;
  blobs: { bytes: Uint8Array }[];
  images: Map<string, Image | null>;
  /** @internal per-page expanded render trees (lazy; expansion is pure). */
  topLevelCache: Map<number, TopLevel[]>;
  /** @internal page CANVAS nodes, document order. */
  pageNodes: FigNode[];
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------
// A .fig is small (a few MB) and always a vanilla non-zip64 archive, so a
// 40-line central-directory reader beats a dependency: find the end-of-
// central-directory record, walk the central entries (their sizes are
// authoritative — LOCAL headers may carry zeros for streamed writes), and
// inflate method-8 payloads.

function unzip(file: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let eocd = -1;
  // EOCD = 22 bytes + optional comment (<= 64 KiB); scan back for its magic.
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("fig: not a ZIP archive (no end-of-central-directory)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("fig: bad central directory entry");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(file.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory marker
    // Local-header name/extra lengths can differ from the central copy
    // (extra fields are per-header); recompute the data offset from local.
    const dataOff = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    const raw = file.subarray(dataOff, dataOff + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`fig: unsupported ZIP compression method ${method} for ${name}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fig-kiwi scene decode
// ---------------------------------------------------------------------------

function decodeCanvasFig(bytes: Uint8Array): FigNode {
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 8)) !== "fig-kiwi") {
    throw new Error("fig: canvas.fig missing fig-kiwi magic");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  let off = 12; // magic (8) + u32 version (4)
  while (off < bytes.length) {
    const size = dv.getUint32(off, true);
    off += 4;
    const raw = bytes.subarray(off, off + size);
    off += size;
    // zstd frame magic 0x28 b5 2f fd (current exports); else raw deflate.
    chunks.push(
      raw[0] === 0x28 && raw[1] === 0xb5
        ? new Uint8Array(Bun.zstdDecompressSync(raw))
        : new Uint8Array(inflateRawSync(raw)),
    );
  }
  // chunk 0: this file's own kiwi schema; chunk 1: the message it describes.
  const schema = compileSchema(decodeBinarySchema(chunks[0]));
  return schema.decodeMessage(chunks[1]);
}

/** Stable string key for a fig guid { sessionID, localID }. */
const gid = (g: FigNode): string => `${g.sessionID}:${g.localID}`;

// ---------------------------------------------------------------------------
// openFig
// ---------------------------------------------------------------------------

export async function openFig(figPath: string): Promise<FigDoc> {
  const zip = unzip(new Uint8Array(await Bun.file(figPath).arrayBuffer()));
  const canvasFig = zip.get("canvas.fig");
  if (!canvasFig) throw new Error(`fig: ${figPath} has no canvas.fig entry`);
  const msg = decodeCanvasFig(canvasFig);

  // Index nodes by guid and group children under their parent, ordered by the
  // fractional-index `position` string (plain string compare IS the order).
  const nodes = new Map<string, FigNode>();
  for (const n of msg.nodeChanges as FigNode[]) {
    if (n.isSoftDeleted) continue;
    nodes.set(gid(n.guid), n);
  }
  const childrenOf = new Map<string, FigNode[]>();
  for (const n of nodes.values()) {
    if (!n.parentIndex) continue;
    const p = gid(n.parentIndex.guid);
    let kids = childrenOf.get(p);
    if (!kids) childrenOf.set(p, (kids = []));
    kids.push(n);
  }
  for (const kids of childrenOf.values()) {
    kids.sort((a, b) => (a.parentIndex.position < b.parentIndex.position ? -1 : 1));
  }

  // Decode fill bitmaps up front (they are few and shared): images/<sha1-hex>.
  // Paints reference them by 20-byte hash. Undecodable entries map to null and
  // render as a gray placeholder fill.
  const images = new Map<string, Image | null>();
  for (const [name, data] of zip) {
    if (!name.startsWith("images/")) continue;
    const hash = name.slice("images/".length);
    try {
      images.set(hash, await loadImage(Buffer.from(data)));
    } catch {
      images.set(hash, null);
    }
  }

  // Pages = children of the DOCUMENT node, document order.
  const docNode = [...nodes.values()].find((n) => n.type === "DOCUMENT");
  if (!docNode) throw new Error("fig: no DOCUMENT node");
  const pageNodes = (childrenOf.get(gid(docNode.guid)) ?? []).filter((n) => n.type === "CANVAS");

  const doc: FigDoc = {
    pages: [],
    nodes,
    childrenOf,
    blobs: msg.blobs ?? [],
    images,
    topLevelCache: new Map(),
    pageNodes,
  };
  doc.pages = pageNodes.map((pg, index) => {
    const kids = (childrenOf.get(gid(pg.guid)) ?? []).filter((k) => k.visible !== false);
    let bounds: FigBounds | null = null;
    for (const k of kids) {
      const box = nodeAabb(k);
      if (!box) continue;
      bounds = bounds ? unionBounds(bounds, box) : box;
    }
    const bg = pg.backgroundColor as FigColor | undefined;
    return {
      index,
      name: String(pg.name ?? ""),
      background: bg ?? { r: 0.898, g: 0.898, b: 0.898, a: 1 },
      bounds,
    };
  });
  return doc;
}

/** AABB of a node's own box (size run through its transform), page coords. */
function nodeAabb(n: FigNode): FigBounds | null {
  const t = n.transform;
  if (!t) return null;
  const w = n.size?.x ?? 0;
  const h = n.size?.y ?? 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ]) {
    const x = t.m00 * cx + t.m01 * cy + t.m02;
    const y = t.m10 * cx + t.m11 * cy + t.m12;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function unionBounds(a: FigBounds, b: FigBounds): FigBounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

// ---------------------------------------------------------------------------
// Instance expansion
// ---------------------------------------------------------------------------
// An INSTANCE node has no children of its own in the scene tree — it points at
// a SYMBOL whose subtree we re-render with the instance's overrides applied.
// Overrides live in symbolData.symbolOverrides + derivedSymbolData, each keyed
// by a guidPath.
//
// Scoping rule (subtle, port-verbatim from the validated prototype): within
// one symbol expansion, every descendant is addressed by a SINGLE-ELEMENT
// guidPath (its own guid) no matter how deep it sits in the tree. Path
// elements only accumulate across NESTED INSTANCE boundaries:
// [nestedInstanceGuid, innerNodeGuid, ...]. So one override map is shared by
// the whole expansion context and re-scoped (prefix-stripped) when we descend
// into a nested instance.

type OverrideMap = Map<string, FigNode[]>; // "g1/g2" -> override objects, merge order

function pathKey(guidPath: FigNode): string {
  return ((guidPath?.guids ?? []) as FigNode[]).map(gid).join("/");
}

interface RNode {
  /** Source node with overrides already merged over its fields. */
  src: FigNode;
  children: RNode[];
}

function buildRenderTree(doc: FigDoc, node: FigNode, overrides: OverrideMap): RNode {
  // Library components get FRESH guids when copied between files; overrideKey
  // preserves the original library guid — which is what override guidPaths
  // keep referencing. Missing this remap silently drops most overrides.
  const myKey = node.overrideKey ? gid(node.overrideKey) : gid(node.guid);
  let src = node;
  const ovs = overrides.get(myKey);
  if (ovs) {
    src = { ...node };
    for (const o of ovs) {
      for (const [k, v] of Object.entries(o)) {
        if (k !== "guidPath") src[k] = v;
      }
    }
  }

  if (node.type === "INSTANCE") {
    const symID = src.overriddenSymbolID ?? src.symbolData?.symbolID;
    const sym = symID && doc.nodes.get(gid(symID));
    if (!sym) return { src, children: [] };
    // Child context: the instance's own overrides first, then outer overrides
    // re-scoped under this instance (outer wins — applied later in merge order).
    const scoped: OverrideMap = new Map();
    const add = (key: string, o: FigNode) => {
      let list = scoped.get(key);
      if (!list) scoped.set(key, (list = []));
      list.push(o);
    };
    // derivedSymbolData carries post-scale geometry/transforms for scaled
    // instances — merged AFTER symbolOverrides so the derived values win.
    for (const list of [src.symbolData?.symbolOverrides, src.derivedSymbolData]) {
      for (const o of list ?? []) {
        const k = pathKey(o.guidPath);
        if (k) add(k, o);
      }
    }
    const prefix = `${myKey}/`;
    for (const [k, list] of overrides) {
      if (k.startsWith(prefix)) {
        for (const o of list) add(k.slice(prefix.length), o);
      }
    }
    const kids = doc.childrenOf.get(gid(sym.guid)) ?? [];
    return { src, children: kids.map((k) => buildRenderTree(doc, k, scoped)) };
  }

  const kids = doc.childrenOf.get(gid(node.guid)) ?? [];
  return { src, children: kids.map((k) => buildRenderTree(doc, k, overrides)) };
}

/** Expanded render trees for a page's visible top-level children (cached —
 *  expansion is pure, and strip-based bakers call renderRegion many times). */
function topLevels(doc: FigDoc, pageIndex: number): TopLevel[] {
  const cached = doc.topLevelCache.get(pageIndex);
  if (cached) return cached;
  const pg = doc.pageNodes[pageIndex];
  if (!pg) throw new Error(`fig: page index ${pageIndex} out of range`);
  const kids = (doc.childrenOf.get(gid(pg.guid)) ?? []).filter((k) => k.visible !== false);
  const out: TopLevel[] = [];
  for (const k of kids) {
    const aabb = nodeAabb(k);
    if (!aabb) continue;
    out.push({ tree: buildRenderTree(doc, k, new Map()), aabb });
  }
  doc.topLevelCache.set(pageIndex, out);
  return out;
}

// ---------------------------------------------------------------------------
// Geometry + paints
// ---------------------------------------------------------------------------

// Path blob commands: opcode -> coord count (see format notes at the top).
const PATH_COORDS: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };

function blobToPath(doc: FigDoc, blobIdx: number): Path2D {
  const b = doc.blobs[blobIdx].bytes;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const path = new Path2D();
  let p = 0;
  while (p < b.length) {
    const c = b[p++];
    const n = PATH_COORDS[c];
    if (n === undefined) break; // unknown opcode: stop rather than misparse
    const v: number[] = [];
    for (let i = 0; i < n; i++) {
      v.push(dv.getFloat32(p, true));
      p += 4;
    }
    if (c === 0) path.closePath();
    else if (c === 1) path.moveTo(v[0], v[1]);
    else if (c === 2) path.lineTo(v[0], v[1]);
    else if (c === 3) path.quadraticCurveTo(v[0], v[1], v[2], v[3]);
    else path.bezierCurveTo(v[0], v[1], v[2], v[3], v[4], v[5]);
  }
  return path;
}

function cssColor(c: FigColor, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

type Ctx = SKRSContext2D;

function applyPaintFill(doc: FigDoc, ctx: Ctx, paint: FigNode, path: Path2D, windingRule: string, node: FigNode): void {
  if (paint.visible === false) return;
  const rule = windingRule === "ODD" ? "evenodd" : "nonzero";
  const prevAlpha = ctx.globalAlpha;
  const prevComp = ctx.globalCompositeOperation;
  if (paint.blendMode === "MULTIPLY") ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = prevAlpha * (paint.opacity ?? 1);
  if (paint.type === "SOLID") {
    ctx.fillStyle = cssColor(paint.color);
    ctx.fill(path, rule);
  } else if (paint.type === "GRADIENT_LINEAR") {
    // paint.transform maps the node's unit square INTO gradient space, so the
    // on-node gradient axis is the INVERSE transform applied to the unit
    // segment (0,0.5)->(1,0.5), scaled up by the node size.
    const w = node.size?.x ?? 1;
    const h = node.size?.y ?? 1;
    const t = paint.transform;
    const det = t.m00 * t.m11 - t.m01 * t.m10;
    const inv = {
      m00: t.m11 / det,
      m01: -t.m01 / det,
      m02: (t.m01 * t.m12 - t.m11 * t.m02) / det,
      m10: -t.m10 / det,
      m11: t.m00 / det,
      m12: (t.m10 * t.m02 - t.m00 * t.m12) / det,
    };
    const ap = (x: number, y: number): [number, number] => [
      (inv.m00 * x + inv.m01 * y + inv.m02) * w,
      (inv.m10 * x + inv.m11 * y + inv.m12) * h,
    ];
    const [x0, y0] = ap(0, 0.5);
    const [x1, y1] = ap(1, 0.5);
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const s of paint.stops) g.addColorStop(s.position, cssColor(s.color));
    ctx.fillStyle = g;
    ctx.fill(path, rule);
  } else if (paint.type === "IMAGE") {
    const hash = paint.image?.hash;
    const img = hash ? doc.images.get(Buffer.from(hash).toString("hex")) ?? null : null;
    if (!img) {
      // Missing/undecodable bitmap: flat gray beats a hole in the bake.
      ctx.fillStyle = "rgba(200,200,200,1)";
      ctx.fill(path, rule);
    } else {
      ctx.save();
      ctx.clip(path, rule);
      const w = node.size?.x ?? 1;
      const h = node.size?.y ?? 1;
      const iw = img.width;
      const ih = img.height;
      const mode = paint.imageScaleMode;
      if (mode === "TILE") {
        const pat = ctx.createPattern(img, "repeat");
        pat.setTransform(new DOMMatrix().scale(paint.scale ?? 1));
        ctx.fillStyle = pat;
        ctx.fill(path, rule);
      } else {
        // FILL (cover) is the fallback; STRETCH's crop transform is
        // approximated as cover too — close enough for kit thumbnails.
        const s = mode === "FIT" ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
        const dw = iw * s;
        const dh = ih * s;
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
      ctx.restore();
    }
  }
  // Unsupported paint types (radial/angular gradients, video) draw nothing —
  // the wireframe kit doesn't use them; extend when a source file does.
  ctx.globalAlpha = prevAlpha;
  ctx.globalCompositeOperation = prevComp;
}

// ---------------------------------------------------------------------------
// Node drawing
// ---------------------------------------------------------------------------

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

function drawNode(doc: FigDoc, ctx: Ctx, rn: RNode): void {
  const n = rn.src;
  if (n.visible === false) return;
  if (n.mask) return; // mask nodes clip siblings (handled by the parent), never paint
  const t = n.transform ?? IDENTITY;
  ctx.save();
  ctx.transform(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
  ctx.globalAlpha = ctx.globalAlpha * (n.opacity ?? 1);
  if (n.blendMode === "MULTIPLY") ctx.globalCompositeOperation = "multiply";

  // Drop shadow, approximated on the node's OWN geometry only (no subtree
  // compositing) — matches how the kit uses it (cards, buttons).
  const shadow = (n.effects ?? []).find((e: FigNode) => e.type === "DROP_SHADOW" && e.visible !== false);

  const drawGeom = (geoms: FigNode[], paints: FigNode[]) => {
    for (const g of geoms ?? []) {
      const path = blobToPath(doc, g.commandsBlob);
      for (const p of paints ?? []) {
        if (shadow) {
          ctx.save();
          ctx.shadowColor = cssColor(shadow.color);
          ctx.shadowBlur = shadow.radius;
          ctx.shadowOffsetX = shadow.offset?.x ?? 0;
          ctx.shadowOffsetY = shadow.offset?.y ?? 0;
          applyPaintFill(doc, ctx, p, path, g.windingRule, n);
          ctx.restore();
        } else {
          applyPaintFill(doc, ctx, p, path, g.windingRule, n);
        }
      }
    }
  };

  if (n.type === "TEXT" && n.derivedTextData?.glyphs) {
    // Pre-shaped glyph outlines: position is the baseline origin in node
    // coords; the outline itself is y-up em units, hence the negated scale.
    for (const gl of n.derivedTextData.glyphs) {
      if (gl.commandsBlob === undefined) continue;
      const path = blobToPath(doc, gl.commandsBlob);
      ctx.save();
      ctx.translate(gl.position.x, gl.position.y);
      const fs = gl.fontSize ?? n.fontSize ?? 12;
      ctx.scale(fs, -fs);
      for (const p of n.fillPaints ?? []) applyPaintFill(doc, ctx, p, path, "NONZERO", n);
      ctx.restore();
    }
  } else {
    drawGeom(n.fillGeometry, n.fillPaints);
  }
  drawGeom(n.strokeGeometry, n.strokePaints);

  // Frame-likes clip children to their box unless "clip content" is off.
  const clips =
    (n.type === "FRAME" || n.type === "SYMBOL" || n.type === "INSTANCE" || n.type === "SECTION") &&
    !n.frameMaskDisabled;
  if (clips) {
    const clip = new Path2D();
    clip.rect(0, 0, n.size?.x ?? 0, n.size?.y ?? 0);
    ctx.clip(clip);
  }

  // NOTE: symbolData.uniformScaleFactor is deliberately NOT applied here —
  // derivedSymbolData overrides already carry post-scale transforms/geometry
  // for scaled instances (see the format notes at the top).

  // Children in paint order; a child with mask:true clips all LATER siblings.
  // Masks are often empty frames whose shape lives in child vectors, so the
  // clip path is collected recursively from the mask subtree's fill geometry.
  let maskDepth = 0;
  for (const c of rn.children) {
    if (c.src.mask && c.src.visible !== false) {
      const clip = new Path2D();
      let has = false;
      const collect = (m: RNode, base: DOMMatrix) => {
        const mt = m.src.transform ?? IDENTITY;
        const mat = base.multiply(new DOMMatrix([mt.m00, mt.m10, mt.m01, mt.m11, mt.m02, mt.m12]));
        if (m.src.visible !== false) {
          for (const g of m.src.fillGeometry ?? []) {
            clip.addPath(blobToPath(doc, g.commandsBlob), mat);
            has = true;
          }
          for (const mc of m.children) collect(mc, mat);
        }
      };
      collect(c, new DOMMatrix());
      if (has) {
        ctx.save();
        maskDepth++;
        ctx.clip(clip);
      }
      continue;
    }
    drawNode(doc, ctx, c);
  }
  while (maskDepth-- > 0) ctx.restore();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// renderRegion
// ---------------------------------------------------------------------------

export interface RenderedRegion {
  width: number;
  height: number;
  /** RGBA, 4 bytes/px, row-major, opaque (background is filled first). */
  rgba: Uint8Array;
}

/**
 * Rasterize the page rect (x, y, w, h) — PAGE coordinates — at `scale` into an
 * RGBA buffer of round(w*scale) x round(h*scale) pixels (bakers pass w/h that
 * are exact binary multiples of 1/scale, so rounding never drifts). The page
 * background is filled first; top-level subtrees whose AABB misses the region
 * (padded for shadow bleed) are culled so strip-based baking stays O(visible).
 */
export function renderRegion(
  doc: FigDoc,
  pageIndex: number,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  canvasFactory: (w: number, h: number) => Canvas = createCanvas,
): RenderedRegion {
  const page = doc.pages[pageIndex];
  if (!page) throw new Error(`fig: page index ${pageIndex} out of range`);
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const canvas = canvasFactory(W, H);
  const ctx = canvas.getContext("2d") as Ctx;
  ctx.fillStyle = cssColor(page.background);
  ctx.fillRect(0, 0, W, H);
  ctx.scale(scale, scale);
  ctx.translate(-x, -y);

  // Shadows/blurs can paint outside a subtree's AABB; pad the cull test
  // rather than tracking per-effect extents (cheap, and never drops content).
  const PAD = 128;
  for (const { tree, aabb } of topLevels(doc, pageIndex)) {
    if (
      aabb.x + aabb.w + PAD < x ||
      aabb.x - PAD > x + w ||
      aabb.y + aabb.h + PAD < y ||
      aabb.y - PAD > y + h
    ) {
      continue;
    }
    drawNode(doc, ctx, tree);
  }
  const data = ctx.getImageData(0, 0, W, H).data;
  return { width: W, height: H, rgba: new Uint8Array(data.buffer, data.byteOffset, W * H * 4) };
}
