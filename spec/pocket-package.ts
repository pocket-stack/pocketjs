// spec/pocket-package.ts — the `.pocket` package format (PLATFORM.md L2).
//
// One file = one app: its target-neutral manifest plus any subset of TARGET
// VARIANTS. A variant is the target-flavored build — dist bundles are baked
// per target (PSP rasters at density 1, Vita at 2, a desktop widget with a
// live viewport…), so "the app" is modeled as manifest × variants, never as
// one blob. A store can hold the universal file; a memory stick carries a
// thinned single-variant one; both are the same format and hash-stable
// (thinning never changes a variant's identity hash).
//
// Layout (all integers little-endian; payloads 16-aligned):
//
//   header (16 B): magic "PCKT", u32 version = 1,
//                  u32 manifestLen, u32 variantCount
//   manifest     : pocket.json bytes, verbatim (the SAME file the build
//                  resolver admitted), padded to 16
//   variant table: variantCount × 40 B entries
//                  { target[16] NUL-padded, u32 hostAbi, u32 sectionCount,
//                    u32 sectionsOff (absolute), u32 reserved,
//                    u64 variantHash }
//   section table: per variant, sectionCount × 16 B entries
//                  { u32 kind, u32 reserved, u32 off (absolute), u32 len }
//   payloads     : section bytes, 16-aligned
//   footer (8 B) : FNV-1a64 over file[0 .. len-8] (scripts/bundle-hash.ts
//                  algorithm — the stale-embed tripwire, now a file format)
//
// Determinism: variants sort by target id, sections by kind, and the
// manifest travels verbatim — identical inputs produce identical bytes
// (test/pocket-package.test.ts byte-compares a committed fixture, and
// core/src/package.rs parses the SAME fixture: one format, two readers,
// one contract).
//
// Section kinds are APPEND-ONLY, like the op table: never renumber, never
// reuse; readers skip kinds they do not know (forward compatibility).

export const POCKET_PACKAGE_MAGIC = 0x544b4350; // "PCKT" as LE u32
export const POCKET_PACKAGE_VERSION = 1;
export const POCKET_PACKAGE_HEADER_SIZE = 16;
export const POCKET_PACKAGE_VARIANT_SIZE = 40;
export const POCKET_PACKAGE_SECTION_SIZE = 16;
export const POCKET_PACKAGE_ALIGN = 16;
export const POCKET_PACKAGE_TARGET_BYTES = 16;

export const POCKET_SECTION = {
  /** u16-length-prefixed UTF-8 strings: output, id, title. The device-side
   *  registry line — native hosts never parse JSON. */
  identity: 1,
  /** The ResolvedBuildPlan JSON this variant was built from (admission
   *  evidence; devices re-verify target/abi/viewport against their own
   *  profile before booting). */
  plan: 2,
  /** The compiled IIFE bundle. NUL-TERMINATED — length includes the
   *  terminator — so an embedded package evals zero-copy from .rodata
   *  (QuickJS requires input[len] == 0; eval with len - 1). */
  js: 3,
  /** The target-flavored asset pack (compiler/pak.ts container). */
  pak: 4,
  /** Cover PNG for launcher decks (256×128 full-frame, LAUNCHER.md). */
  cover: 5,
  // 6 = qjsc bytecode (PLATFORM.md roadmap) — reserved, not yet emitted.
} as const;

export interface PocketPackageSection {
  kind: number;
  bytes: Uint8Array;
}

export interface PocketPackageVariant {
  /** Target id (spec/platforms.ts POCKET_TARGETS key, ≤ 15 bytes UTF-8). */
  target: string;
  hostAbi: number;
  sections: PocketPackageSection[];
}

export interface PocketPackage {
  /** pocket.json bytes, verbatim. */
  manifest: Uint8Array;
  variants: PocketPackageVariant[];
}

export interface PocketPackageIdentity {
  output: string;
  id: string;
  title: string;
}

// --- FNV-1a64 (lockstep with scripts/bundle-hash.ts + native/build.rs) ----

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

export function fnv1a64(...chunks: Uint8Array[]): bigint {
  let h = FNV_OFFSET;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      h ^= BigInt(chunk[i]);
      h = (h * FNV_PRIME) & FNV_MASK;
    }
  }
  return h;
}

// --- encode ---------------------------------------------------------------

const align = (n: number) => (n + POCKET_PACKAGE_ALIGN - 1) & ~(POCKET_PACKAGE_ALIGN - 1);

export function encodeIdentity(identity: PocketPackageIdentity): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const value of [identity.output, identity.id, identity.title]) {
    const utf8 = new TextEncoder().encode(value);
    if (utf8.length > 0xffff) throw new Error("pocket package: identity string too long");
    const len = new Uint8Array(2);
    new DataView(len.buffer).setUint16(0, utf8.length, true);
    parts.push(len, utf8);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function decodeIdentity(bytes: Uint8Array): PocketPackageIdentity {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: string[] = [];
  let off = 0;
  for (let i = 0; i < 3; i++) {
    if (off + 2 > bytes.length) throw new Error("pocket package: truncated identity");
    const len = dv.getUint16(off, true);
    off += 2;
    if (off + len > bytes.length) throw new Error("pocket package: truncated identity");
    fields.push(new TextDecoder().decode(bytes.subarray(off, off + len)));
    off += len;
  }
  return { output: fields[0], id: fields[1], title: fields[2] };
}

/** Serialize a package. Variants sort by target, sections by kind — the
 *  encoding is deterministic by construction. */
export function encodePocketPackage(pkg: PocketPackage): Uint8Array {
  const variants = [...pkg.variants].sort((a, b) => (a.target < b.target ? -1 : 1));
  for (const v of variants) {
    if (new TextEncoder().encode(v.target).length >= POCKET_PACKAGE_TARGET_BYTES) {
      throw new Error(`pocket package: target id too long: ${v.target}`);
    }
    if (new Set(v.sections.map((s) => s.kind)).size !== v.sections.length) {
      throw new Error(`pocket package: duplicate section kind in ${v.target}`);
    }
    v.sections = [...v.sections].sort((a, b) => a.kind - b.kind);
  }
  if (new Set(variants.map((v) => v.target)).size !== variants.length) {
    throw new Error("pocket package: duplicate variant target");
  }

  const manifestOff = POCKET_PACKAGE_HEADER_SIZE;
  const tableOff = align(manifestOff + pkg.manifest.length);
  const sectionTablesOff = tableOff + variants.length * POCKET_PACKAGE_VARIANT_SIZE;
  let cursor = sectionTablesOff;
  const sectionTableOffs: number[] = [];
  for (const v of variants) {
    sectionTableOffs.push(cursor);
    cursor += v.sections.length * POCKET_PACKAGE_SECTION_SIZE;
  }
  cursor = align(cursor);
  const payloadOffs: number[][] = variants.map((v) =>
    v.sections.map((s) => {
      const off = cursor;
      cursor = align(cursor + s.bytes.length);
      return off;
    }),
  );
  const total = cursor + 8; // footer

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, POCKET_PACKAGE_MAGIC, true);
  dv.setUint32(4, POCKET_PACKAGE_VERSION, true);
  dv.setUint32(8, pkg.manifest.length, true);
  dv.setUint32(12, variants.length, true);
  out.set(pkg.manifest, manifestOff);

  variants.forEach((v, vi) => {
    const entry = tableOff + vi * POCKET_PACKAGE_VARIANT_SIZE;
    out.set(new TextEncoder().encode(v.target), entry); // NUL-padded by zero-init
    dv.setUint32(entry + 16, v.hostAbi, true);
    dv.setUint32(entry + 20, v.sections.length, true);
    dv.setUint32(entry + 24, sectionTableOffs[vi], true);
    dv.setBigUint64(entry + 32, fnv1a64(...v.sections.map((s) => s.bytes)), true);
    v.sections.forEach((s, si) => {
      const se = sectionTableOffs[vi] + si * POCKET_PACKAGE_SECTION_SIZE;
      dv.setUint32(se, s.kind, true);
      dv.setUint32(se + 8, payloadOffs[vi][si], true);
      dv.setUint32(se + 12, s.bytes.length, true);
      out.set(s.bytes, payloadOffs[vi][si]);
    });
  });

  dv.setBigUint64(total - 8, fnv1a64(out.subarray(0, total - 8)), true);
  return out;
}

// --- decode ---------------------------------------------------------------

export interface DecodeOptions {
  /** Skip the footer hash (already verified, or streaming). Default false. */
  skipHashCheck?: boolean;
}

export function decodePocketPackage(bytes: Uint8Array, opts: DecodeOptions = {}): PocketPackage {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < POCKET_PACKAGE_HEADER_SIZE + 8) throw new Error("pocket package: truncated");
  if (dv.getUint32(0, true) !== POCKET_PACKAGE_MAGIC) throw new Error("pocket package: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== POCKET_PACKAGE_VERSION) {
    throw new Error(`pocket package: unsupported version ${version}`);
  }
  if (!opts.skipHashCheck) {
    const stored = dv.getBigUint64(bytes.length - 8, true);
    const actual = fnv1a64(bytes.subarray(0, bytes.length - 8));
    if (stored !== actual) {
      throw new Error(
        `pocket package: hash mismatch (stored ${stored.toString(16)}, actual ${actual.toString(16)})`,
      );
    }
  }
  const manifestLen = dv.getUint32(8, true);
  const variantCount = dv.getUint32(12, true);
  const manifest = bytes.subarray(
    POCKET_PACKAGE_HEADER_SIZE,
    POCKET_PACKAGE_HEADER_SIZE + manifestLen,
  );
  const tableOff = align(POCKET_PACKAGE_HEADER_SIZE + manifestLen);
  const variants: PocketPackageVariant[] = [];
  for (let vi = 0; vi < variantCount; vi++) {
    const entry = tableOff + vi * POCKET_PACKAGE_VARIANT_SIZE;
    if (entry + POCKET_PACKAGE_VARIANT_SIZE > bytes.length) {
      throw new Error("pocket package: truncated variant table");
    }
    let end = entry;
    while (end < entry + POCKET_PACKAGE_TARGET_BYTES && bytes[end] !== 0) end++;
    const target = new TextDecoder().decode(bytes.subarray(entry, end));
    const hostAbi = dv.getUint32(entry + 16, true);
    const sectionCount = dv.getUint32(entry + 20, true);
    const sectionsOff = dv.getUint32(entry + 24, true);
    const sections: PocketPackageSection[] = [];
    for (let si = 0; si < sectionCount; si++) {
      const se = sectionsOff + si * POCKET_PACKAGE_SECTION_SIZE;
      if (se + POCKET_PACKAGE_SECTION_SIZE > bytes.length) {
        throw new Error("pocket package: truncated section table");
      }
      const kind = dv.getUint32(se, true);
      const off = dv.getUint32(se + 8, true);
      const len = dv.getUint32(se + 12, true);
      if (off + len > bytes.length) throw new Error("pocket package: section out of bounds");
      sections.push({ kind, bytes: bytes.subarray(off, off + len) });
    }
    variants.push({ target, hostAbi, sections });
  }
  return { manifest, variants };
}

/** The variant for a target, or null. */
export function findVariant(pkg: PocketPackage, target: string): PocketPackageVariant | null {
  return pkg.variants.find((v) => v.target === target) ?? null;
}

/** A variant's section payload by kind, or null (unknown kinds are data —
 *  callers skip what they do not consume; forward compatible). */
export function findSection(variant: PocketPackageVariant, kind: number): Uint8Array | null {
  return variant.sections.find((s) => s.kind === kind)?.bytes ?? null;
}

/** Re-encode with only the requested targets — the store-to-device "lipo".
 *  Variant hashes are unchanged by construction (payload bytes travel
 *  verbatim); only the container around them shrinks. */
export function thinPocketPackage(pkg: PocketPackage, targets: readonly string[]): PocketPackage {
  const kept = pkg.variants.filter((v) => targets.includes(v.target));
  if (kept.length === 0) {
    throw new Error(`pocket package: no variant for target(s) ${targets.join(", ")}`);
  }
  return { manifest: pkg.manifest, variants: kept };
}
