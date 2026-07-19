// pocket-drive cooker: open map data → a tiled, GE-ready `.pdrv` city pack.
//
// Two modes:
//
//   bun cooker/cook.ts fetch [--raw overpass.json]   # Overpass → data/<city>.json.gz
//   bun cooker/cook.ts [--out x.pdrv] [--svg x.svg]  # data/<city>.json.gz → pack
//
// The trimmed extract in data/ is the pinned source of truth — cooking is
// offline and deterministic. `fetch` only refreshes that pin (network, or
// --raw for an already-downloaded Overpass JSON).
//
// Units: 1 unit = 0.25 m (4 units/m). +X east, +Z south, +Y up — so yaw 0
// (-Z) looks north. Tile-local i16 positions ride the GE's ÷32768 3D-mode
// normalization; the runtime scales back up in the model matrix.

import { existsSync, mkdirSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

// ---- city registry ----------------------------------------------------

interface City {
  /** Overpass bbox: south, west, north, east. */
  bbox: [number, number, number, number];
  /** Projection origin (center-ish). */
  lat0: number;
  lon0: number;
  /** Scenic waypoints (lat, lon); the route is shortest-path legs between
   *  consecutive ones, closed back to the first. */
  waypoints: [number, number][];
}

const CITIES: Record<string, City> = {
  manhattan: {
    bbox: [40.735, -73.998, 40.755, -73.975],
    lat0: 40.745,
    lon0: -73.9865,
    waypoints: [
      [40.7419, -73.9884], // Broadway & W 23rd — Flatiron
      [40.7443, -73.987], // Broadway & W 28th
      [40.7484, -73.9857], // 5th Ave & W 34th — Empire State Building
      [40.7503, -73.9884], // 6th Ave & W 35th — Herald Square
      [40.7527, -73.9857], // 6th Ave & W 39th — Garment District
      [40.7495, -73.9811], // Madison Ave & E 36th — Morgan Library
      [40.7442, -73.9805], // Park Ave S & E 30th
      [40.7404, -73.9857], // 5th Ave & E 23rd — Madison Square south
    ],
  },
};

// ---- tunables ---------------------------------------------------------

const UNITS_PER_M = 4; // 1 unit = 0.25 m
const TILE = 512; // units (128 m)
const LEVEL_M = 3.2; // meters per building:levels
const MIN_FOOTPRINT_M2 = 12;
const SIMPLIFY_M = 0.6; // footprint/road vertex tolerance

/** Road classes: render width (m), y offset (units), drivable, speed factor. */
const ROADS: Record<string, { w: number; y: number; drive: boolean; speed: number }> = {
  motorway: { w: 16, y: 1.8, drive: true, speed: 2.0 },
  motorway_link: { w: 8, y: 1.8, drive: true, speed: 1.3 },
  trunk: { w: 15, y: 1.6, drive: true, speed: 1.6 },
  trunk_link: { w: 8, y: 1.6, drive: true, speed: 1.2 },
  primary: { w: 15, y: 1.4, drive: true, speed: 1.25 },
  primary_link: { w: 8, y: 1.4, drive: true, speed: 1.0 },
  secondary: { w: 13, y: 1.2, drive: true, speed: 1.1 },
  secondary_link: { w: 7, y: 1.2, drive: true, speed: 1.0 },
  tertiary: { w: 11, y: 1.0, drive: true, speed: 1.0 },
  tertiary_link: { w: 6, y: 1.0, drive: true, speed: 0.9 },
  residential: { w: 9, y: 0.8, drive: true, speed: 0.85 },
  unclassified: { w: 8, y: 0.8, drive: true, speed: 0.85 },
  living_street: { w: 7, y: 0.8, drive: true, speed: 0.7 },
  pedestrian: { w: 6, y: 0.6, drive: false, speed: 0 },
};

// Night-navigation palette (ABGR is packed at write time).
const PALETTE = {
  road: [0.215, 0.245, 0.30] as V3,
  pedestrian: [0.16, 0.185, 0.235] as V3,
  wallBase: [0.335, 0.385, 0.485] as V3,
  roof: [0.415, 0.465, 0.565] as V3,
  roofLine: [0.615, 0.70, 0.84] as V3,
};
const SUN = norm3([-0.55, 0.0, -0.45]); // fake sun from the NW, grazing

type V3 = [number, number, number];
type P2 = [number, number];

function norm3(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---- deterministic hash (per OSM id) ----------------------------------

function hash01(id: number): number {
  let x = id >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x / 0xffffffff;
}

// ---- extract schema ---------------------------------------------------

interface Extract {
  meta: { city: string; lat0: number; lon0: number; fetched: string; source: string };
  /** Rings in local meters (x east, z south), closed implicitly. */
  buildings: { id: number; h: number; minH: number; ring: P2[] }[];
  roads: { id: number; cls: string; pts: P2[] }[];
}

// ---- CLI --------------------------------------------------------------

const argv = Bun.argv.slice(2);
const mode = argv[0] === "fetch" ? "fetch" : "cook";
function flag(name: string, def: string): string {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const cityName = flag("city", "manhattan");
const city = CITIES[cityName];
if (!city) {
  console.error(`unknown city ${cityName} (have: ${Object.keys(CITIES).join(", ")})`);
  process.exit(1);
}
const here = new URL(".", import.meta.url).pathname;
const dataGz = `${here}data/${cityName}.json.gz`;

if (mode === "fetch") {
  await fetchExtract();
} else {
  cook();
}

// ---- fetch: Overpass → trimmed extract --------------------------------

async function fetchExtract() {
  const rawPath = flag("raw", "");
  let raw: any;
  if (rawPath) {
    raw = JSON.parse(await Bun.file(rawPath).text());
  } else {
    const [s, w, n, e] = city.bbox;
    const bb = `(${s},${w},${n},${e})`;
    const q = `[out:json][timeout:120];
(
  way["building"]${bb};
  relation["building"]["type"="multipolygon"]${bb};
  way["highway"~"^(${Object.keys(ROADS).join("|")})$"]${bb};
);
(._;>;);
out body;`;
    console.log("cook: fetching from Overpass…");
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: new URLSearchParams({ data: q }),
    });
    if (!res.ok) throw new Error(`overpass: HTTP ${res.status}`);
    raw = await res.json();
  }

  const nodes = new Map<number, P2>();
  for (const el of raw.elements) {
    if (el.type === "node") nodes.set(el.id, project(el.lat, el.lon));
  }
  const ways = new Map<number, any>();
  for (const el of raw.elements) if (el.type === "way") ways.set(el.id, el);

  const buildings: Extract["buildings"] = [];
  const usedInRel = new Set<number>();

  // Multipolygon relations: stitch outer ways into rings.
  for (const el of raw.elements) {
    if (el.type !== "relation" || el.tags?.building === undefined) continue;
    const h = buildingHeight(el.tags, el.id);
    if (h === null) continue;
    const outers = (el.members ?? [])
      .filter((m: any) => m.type === "way" && m.role !== "inner")
      .map((m: any) => ways.get(m.ref))
      .filter(Boolean);
    for (const w of outers) usedInRel.add(w.id);
    for (const ring of stitchRings(outers.map((w: any) => w.nodes as number[]))) {
      pushBuilding(buildings, el.id, h, ring, nodes);
    }
  }

  for (const el of raw.elements) {
    if (el.type !== "way") continue;
    const t = el.tags ?? {};
    if (t.building && t.building !== "no" && !usedInRel.has(el.id)) {
      const h = buildingHeight(t, el.id);
      if (h === null) continue;
      const ids = el.nodes as number[];
      if (ids.length >= 4 && ids[0] === ids[ids.length - 1]) {
        pushBuilding(buildings, el.id, h, ids.slice(0, -1), nodes);
      }
    }
  }

  // Clip roads to the bbox (+margin): Overpass returns whole ways, and a
  // street escaping the cooked area would drive the car into the void.
  const [s0, w0, n0, e0] = city.bbox;
  const m = 60; // meters of slack
  const [clipMinX, clipMinZ] = project(n0, w0);
  const [clipMaxX, clipMaxZ] = project(s0, e0);
  const inBounds = (p: P2) =>
    p[0] > clipMinX - m && p[0] < clipMaxX + m && p[1] > clipMinZ - m && p[1] < clipMaxZ + m;

  const roads: Extract["roads"] = [];
  for (const el of raw.elements) {
    if (el.type !== "way") continue;
    const t = el.tags ?? {};
    if (!t.highway || !(t.highway in ROADS)) continue;
    if (t.tunnel === "yes" || t.covered === "yes" || Number(t.layer ?? 0) < 0) continue;
    if (t.area === "yes") continue; // pedestrian plazas: not linear
    const pts = (el.nodes as number[]).map((id) => nodes.get(id)).filter(Boolean) as P2[];
    let run: P2[] = [];
    const flush = () => {
      if (run.length >= 2) roads.push({ id: el.id, cls: t.highway, pts: run.map(round2) });
      run = [];
    };
    for (const p of pts) {
      if (inBounds(p)) run.push(p);
      else flush();
    }
    flush();
  }

  const extract: Extract = {
    meta: {
      city: cityName,
      lat0: city.lat0,
      lon0: city.lon0,
      fetched: raw.osm3s?.timestamp_osm_base ?? "unknown",
      source: "OpenStreetMap via Overpass API (ODbL)",
    },
    buildings,
    roads,
  };
  mkdirSync(`${here}data`, { recursive: true });
  const gz = gzipSync(JSON.stringify(extract), { level: 9 });
  await Bun.write(dataGz, gz);
  console.log(
    `cook: pinned ${cityName}: ${buildings.length} buildings, ${roads.length} roads → ` +
      `${dataGz} (${(gz.length / 1024).toFixed(0)} KB)`,
  );

  function pushBuilding(
    out: Extract["buildings"],
    id: number,
    h: { h: number; minH: number },
    nodeIds: number[],
    nm: Map<number, P2>,
  ) {
    const ring = nodeIds.map((n) => nm.get(n)).filter(Boolean) as P2[];
    if (ring.length < 3) return;
    const simp = simplifyRing(ring.map(round2), SIMPLIFY_M);
    if (simp.length < 3 || Math.abs(ringArea(simp)) < MIN_FOOTPRINT_M2) return;
    out.push({ id, h: h.h, minH: h.minH, ring: simp });
  }

  function project(lat: number, lon: number): P2 {
    const mPerLon = 111320 * Math.cos((city.lat0 * Math.PI) / 180);
    return [(lon - city.lon0) * mPerLon, -(lat - city.lat0) * 110574];
  }
  function round2(p: P2): P2 {
    return [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
  }
}

function parseLen(v: string | undefined): number | null {
  if (!v) return null;
  const s = String(v).trim();
  const ft = s.match(/^([\d.]+)\s*(?:'|ft)/);
  const n = ft ? parseFloat(ft[1]) * 0.3048 : parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function buildingHeight(t: any, id: number): { h: number; minH: number } | null {
  let h = parseLen(t.height) ?? parseLen(t["building:height"]);
  if (h === null) {
    const lv = parseFloat(t["building:levels"]);
    h = Number.isFinite(lv) ? lv * LEVEL_M + 1.5 : 8 + hash01(id) * 10;
  }
  const minH = Math.max(0, parseLen(t.min_height) ?? 0);
  if (h <= minH + 0.5) return null;
  return { h, minH };
}

/** Join way node-lists sharing endpoints into closed rings. */
function stitchRings(ways: number[][]): number[][] {
  const segs = ways.filter((w) => w.length >= 2).map((w) => [...w]);
  const rings: number[][] = [];
  while (segs.length) {
    const ring = segs.shift()!;
    let grew = true;
    while (grew && ring[0] !== ring[ring.length - 1]) {
      grew = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const tail = ring[ring.length - 1];
        if (s[0] === tail) ring.push(...s.slice(1));
        else if (s[s.length - 1] === tail) ring.push(...s.reverse().slice(1));
        else continue;
        segs.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring.slice(0, -1));
  }
  return rings;
}

// ---- geometry helpers -------------------------------------------------

function ringArea(r: P2[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, z1] = r[i];
    const [x2, z2] = r[(i + 1) % r.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/** Douglas-Peucker on a closed ring (keeps the two extreme anchors). */
function simplifyRing(ring: P2[], tol: number): P2[] {
  const dedup: P2[] = [];
  for (const p of ring) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) dedup.push(p);
  }
  if (dedup.length < 4) return dedup;
  let a = 0;
  let b = 0;
  let best = -1;
  for (let i = 0; i < dedup.length; i++)
    for (const j of [0]) {
      const d = Math.hypot(dedup[i][0] - dedup[j][0], dedup[i][1] - dedup[j][1]);
      if (d > best) {
        best = d;
        a = j;
        b = i;
      }
    }
  const half1 = simplifyLine([...dedup.slice(a, b + 1)], tol);
  const half2 = simplifyLine([...dedup.slice(b), ...dedup.slice(0, a + 1)], tol);
  return [...half1.slice(0, -1), ...half2.slice(0, -1)];
}

function simplifyLine(pts: P2[], tol: number): P2[] {
  if (pts.length <= 2) return pts;
  let maxD = 0;
  let idx = 0;
  const [ax, az] = pts[0];
  const [bx, bz] = pts[pts.length - 1];
  const abx = bx - ax;
  const abz = bz - az;
  const ab2 = abx * abx + abz * abz;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, pz] = pts[i];
    let d: number;
    if (ab2 < 1e-12) d = Math.hypot(px - ax, pz - az);
    else {
      const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / ab2));
      d = Math.hypot(px - (ax + t * abx), pz - (az + t * abz));
    }
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]];
  const l = simplifyLine(pts.slice(0, idx + 1), tol);
  const r = simplifyLine(pts.slice(idx), tol);
  return [...l.slice(0, -1), ...r];
}

/** Ear clipping. Returns index triples into `ring`. Winding-agnostic. */
function earcut(ring: P2[]): number[] {
  const n = ring.length;
  if (n < 3) return [];
  const idx = [...ring.keys()];
  if (ringArea(ring) < 0) idx.reverse(); // make CCW in (x, z)
  const tris: number[] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = ring[ia];
      const b = ring[ib];
      const c = ring[ic];
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 1e-9) continue; // reflex or degenerate
      let inside = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTri(ring[j], a, b, c)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      tris.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate leftovers: fan the rest
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  else for (let i = 1; i + 1 < idx.length; i++) tris.push(idx[0], idx[i], idx[i + 1]);
  return tris;
}

function pointInTri(p: P2, a: P2, b: P2, c: P2): boolean {
  const s = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
  const t = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false;
  const d = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
  return d === 0 || d < 0 === (s + t <= 0);
}

// ---- cook: extract → .pdrv --------------------------------------------

interface TileBuf {
  verts: number[]; // packed: color, x, y, z per vert
  vmap: Map<string, number>;
  idx: number[];
  lines: number[]; // packed line-vert pairs: color, x, y, z
  min: V3;
  max: V3;
}

function cook() {
  if (!existsSync(dataGz)) {
    console.error(`no pinned extract at ${dataGz} — run: bun cooker/cook.ts fetch`);
    process.exit(1);
  }
  const extract: Extract = JSON.parse(
    gunzipSync(new Uint8Array(readFileSyncBytes(dataGz))).toString(),
  );
  const outPath = flag("out", `${repoDist()}/${cityName}.pdrv`);
  const svgPath = flag("svg", `${repoDist()}/${cityName}.svg`);

  // World bounds in units (roads + buildings).
  let wminx = Infinity, wminz = Infinity, wmaxx = -Infinity, wmaxz = -Infinity;
  const touch = (x: number, z: number) => {
    wminx = Math.min(wminx, x); wminz = Math.min(wminz, z);
    wmaxx = Math.max(wmaxx, x); wmaxz = Math.max(wmaxz, z);
  };
  for (const b of extract.buildings) for (const [x, z] of b.ring) touch(x * UNITS_PER_M, z * UNITS_PER_M);
  for (const r of extract.roads) for (const [x, z] of r.pts) touch(x * UNITS_PER_M, z * UNITS_PER_M);

  const originX = Math.floor(wminx / TILE) * TILE;
  const originZ = Math.floor(wminz / TILE) * TILE;
  const nx = Math.ceil((wmaxx - originX) / TILE);
  const nz = Math.ceil((wmaxz - originZ) / TILE);
  const tiles: (TileBuf | null)[] = new Array(nx * nz).fill(null);

  const tileAt = (x: number, z: number): TileBuf => {
    let tx = Math.floor((x - originX) / TILE);
    let tz = Math.floor((z - originZ) / TILE);
    tx = Math.max(0, Math.min(nx - 1, tx));
    tz = Math.max(0, Math.min(nz - 1, tz));
    const i = tz * nx + tx;
    if (!tiles[i]) {
      tiles[i] = {
        verts: [], vmap: new Map(), idx: [], lines: [],
        min: [32767, 32767, 32767], max: [-32768, -32768, -32768],
      };
    }
    (tiles[i] as any)._tx = tx;
    (tiles[i] as any)._tz = tz;
    return tiles[i]!;
  };
  const tileOrigin = (t: TileBuf): P2 => [
    originX + (t as any)._tx * TILE,
    originZ + (t as any)._tz * TILE,
  ];

  const addVert = (t: TileBuf, color: number, x: number, y: number, z: number): number => {
    const [ox, oz] = tileOrigin(t);
    const lx = Math.round(x - ox);
    const ly = Math.round(y);
    const lz = Math.round(z - oz);
    clampCheck(lx); clampCheck(ly); clampCheck(lz);
    const key = `${color},${lx},${ly},${lz}`;
    const got = t.vmap.get(key);
    if (got !== undefined) return got;
    const i = t.verts.length / 4;
    t.verts.push(color, lx, ly, lz);
    t.vmap.set(key, i);
    t.min = [Math.min(t.min[0], lx), Math.min(t.min[1], ly), Math.min(t.min[2], lz)];
    t.max = [Math.max(t.max[0], lx), Math.max(t.max[1], ly), Math.max(t.max[2], lz)];
    return i;
  };
  const addLineVert = (t: TileBuf, color: number, x: number, y: number, z: number) => {
    const [ox, oz] = tileOrigin(t);
    const lx = Math.round(x - ox);
    const ly = Math.round(y);
    const lz = Math.round(z - oz);
    t.lines.push(color, lx, ly, lz);
    t.min = [Math.min(t.min[0], lx), Math.min(t.min[1], ly), Math.min(t.min[2], lz)];
    t.max = [Math.max(t.max[0], lx), Math.max(t.max[1], ly), Math.max(t.max[2], lz)];
  };

  // ---- roads → ribbons ----
  let roadTris = 0;
  for (const road of extract.roads) {
    const spec = ROADS[road.cls];
    const pts = simplifyLine(road.pts.map(([x, z]) => [x * UNITS_PER_M, z * UNITS_PER_M] as P2), SIMPLIFY_M * UNITS_PER_M);
    if (pts.length < 2) continue;
    const half = (spec.w * UNITS_PER_M) / 2;
    const color = packRGB(spec.drive ? PALETTE.road : PALETTE.pedestrian);
    // Per-joint left/right offsets with miter (limited).
    const L: P2[] = [];
    const R: P2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const din = i > 0 ? dir2(pts[i - 1], p) : dir2(p, pts[i + 1]);
      const dout = i < pts.length - 1 ? dir2(p, pts[i + 1]) : din;
      let mx = din[0] + dout[0];
      let mz = din[1] + dout[1];
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) { mx = -din[1]; mz = din[0]; }
      else { mx /= ml; mz /= ml; }
      // Miter normal = perpendicular of the averaged direction, scaled.
      let nxm = -mz;
      let nzm = mx;
      const cosHalf = nxm * -din[1] + nzm * din[0];
      const scale = Math.min(2.5, 1 / Math.max(0.35, Math.abs(cosHalf)));
      L.push([p[0] + nxm * half * scale, p[1] + nzm * half * scale]);
      R.push([p[0] - nxm * half * scale, p[1] - nzm * half * scale]);
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const midx = (pts[i][0] + pts[i + 1][0]) / 2;
      const midz = (pts[i][1] + pts[i + 1][1]) / 2;
      const t = tileAt(midx, midz);
      const y = spec.y;
      const a = addVert(t, color, L[i][0], y, L[i][1]);
      const b = addVert(t, color, R[i][0], y, R[i][1]);
      const c = addVert(t, color, R[i + 1][0], y, R[i + 1][1]);
      const d = addVert(t, color, L[i + 1][0], y, L[i + 1][1]);
      t.idx.push(a, b, c, a, c, d);
      roadTris += 2;
    }
  }

  // ---- buildings → extruded prisms + roof edge lines ----
  let bldTris = 0;
  let skipped = 0;
  for (const b of extract.buildings) {
    const ring = b.ring.map(([x, z]) => [x * UNITS_PER_M, z * UNITS_PER_M] as P2);
    const area = ringArea(ring);
    if (Math.abs(area) < MIN_FOOTPRINT_M2 * UNITS_PER_M * UNITS_PER_M) { skipped++; continue; }
    const ccw = area > 0 ? ring : [...ring].reverse();
    const h = b.h * UNITS_PER_M;
    const y0 = b.minH * UNITS_PER_M;
    let cx = 0, cz = 0;
    for (const [x, z] of ccw) { cx += x; cz += z; }
    cx /= ccw.length; cz /= ccw.length;
    const t = tileAt(cx, cz);

    // Per-building tint (subtle, deterministic).
    const tint = 0.94 + hash01(b.id) * 0.12;
    const aoTop = Math.min(1, 0.55 + (0.45 * h) / 120); // full brightness by ~30 m
    const heightGlow = 1 + 0.12 * Math.min(1, h / 700); // tall towers slightly lighter

    // Walls: split verts per face for flat shading.
    const n = ccw.length;
    for (let i = 0; i < n; i++) {
      const p = ccw[i];
      const q = ccw[(i + 1) % n];
      const ex = q[0] - p[0];
      const ez = q[1] - p[1];
      const el = Math.hypot(ex, ez);
      if (el < 1e-6) continue;
      // Outward normal of a CCW ring in (x, z) with +Z south: (dz, -dx).
      const nrm: V3 = [ez / el, 0, -ex / el];
      const lit = 0.50 + 0.42 * Math.max(0, nrm[0] * SUN[0] + nrm[2] * SUN[2]);
      const shade = lit * tint * heightGlow;
      const cBot = packRGB(scale3(PALETTE.wallBase, shade * 0.52));
      const cTop = packRGB(scale3(PALETTE.wallBase, shade * aoTop));
      const a = addVert(t, cBot, p[0], y0, p[1]);
      const bb = addVert(t, cBot, q[0], y0, q[1]);
      const c = addVert(t, cTop, q[0], h, q[1]);
      const d = addVert(t, cTop, p[0], h, p[1]);
      t.idx.push(a, bb, c, a, c, d);
      bldTris += 2;
    }

    // Roof.
    const roofC = packRGB(scale3(PALETTE.roof, tint * heightGlow));
    const tris = earcut(ccw);
    for (let i = 0; i + 2 < tris.length; i += 3) {
      const a = addVert(t, roofC, ccw[tris[i]][0], h, ccw[tris[i]][1]);
      const bb = addVert(t, roofC, ccw[tris[i + 1]][0], h, ccw[tris[i + 1]][1]);
      const c = addVert(t, roofC, ccw[tris[i + 2]][0], h, ccw[tris[i + 2]][1]);
      t.idx.push(a, bb, c);
      bldTris++;
    }

    // Roof edge lines (the Tesla-style rim light), floated just above the
    // roof plane so they never z-fight it.
    const lineC = packRGB(scale3(PALETTE.roofLine, Math.min(1.15, tint * heightGlow)));
    const lineY = h + 1.5;
    for (let i = 0; i < n; i++) {
      const p = ccw[i];
      const q = ccw[(i + 1) % n];
      addLineVert(t, lineC, p[0], lineY, p[1]);
      addLineVert(t, lineC, q[0], lineY, q[1]);
    }
  }

  // ---- route ----
  const route = buildRoute(extract);

  // ---- write pack ----
  const buf = writePack({ originX, originZ, nx, nz, tiles, route });
  mkdirSync(outPath.slice(0, outPath.lastIndexOf("/")), { recursive: true });
  Bun.write(outPath, buf);

  // ---- stats ----
  const used = tiles.filter(Boolean) as TileBuf[];
  const maxV = Math.max(...used.map((t) => t.verts.length / 4));
  const maxI = Math.max(...used.map((t) => t.idx.length));
  const avgTri = used.reduce((s, t) => s + t.idx.length / 3, 0) / used.length;
  console.log(
    `cook: ${cityName} → ${outPath}\n` +
      `  grid ${nx}×${nz} (${used.length} occupied), tile ${TILE}u (${TILE / UNITS_PER_M} m)\n` +
      `  buildings ${extract.buildings.length - skipped} (+${skipped} skipped), roads ${extract.roads.length}\n` +
      `  tris: buildings ${bldTris}, roads ${roadTris}; per-tile avg ${avgTri.toFixed(0)}, max verts ${maxV}, max idx ${maxI}\n` +
      `  route: ${route.length} pts, ${(route[route.length - 1].s / UNITS_PER_M / 1000).toFixed(2)} km loop\n` +
      `  pack: ${(buf.byteLength / 1024).toFixed(0)} KB`,
  );
  if (maxV > 65535 || maxI > 65535) throw new Error("tile over u16 limit — shrink TILE");

  writeSvg(svgPath, extract, route, { originX, originZ, nx, nz });
  console.log(`cook: preview → ${svgPath}`);
}

function dir2(a: P2, b: P2): P2 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

function scale3(c: V3, s: number): V3 {
  return [c[0] * s, c[1] * s, c[2] * s];
}

function packRGB(c: V3): number {
  const r = Math.max(0, Math.min(255, Math.round(c[0] * 255)));
  const g = Math.max(0, Math.min(255, Math.round(c[1] * 255)));
  const b = Math.max(0, Math.min(255, Math.round(c[2] * 255)));
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

function clampCheck(v: number) {
  if (v < -32768 || v > 32767) throw new Error(`i16 overflow: ${v}`);
}

function readFileSyncBytes(p: string): Buffer {
  return require("node:fs").readFileSync(p);
}

function repoDist(): string {
  return new URL("../../../../dist/drive", import.meta.url).pathname;
}

// ---- route building ---------------------------------------------------

interface RoutePt { x: number; z: number; s: number; speed: number }

function buildRoute(extract: Extract): RoutePt[] {
  // Graph nodes = shared road points (keyed by rounded coordinate).
  const key = (p: P2) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
  const usage = new Map<string, number>();
  const drivable = extract.roads.filter((r) => ROADS[r.cls].drive && r.pts.length >= 2);
  for (const r of drivable) {
    for (const p of r.pts) usage.set(key(p), (usage.get(key(p)) ?? 0) + 1);
    usage.set(key(r.pts[0]), (usage.get(key(r.pts[0])) ?? 0) + 1);
    usage.set(key(r.pts[r.pts.length - 1]), (usage.get(key(r.pts[r.pts.length - 1])) ?? 0) + 1);
  }

  interface Edge { a: string; b: string; pts: P2[]; len: number; cls: string; id: number }
  const edges: Edge[] = [];
  const adj = new Map<string, number[]>();
  let eid = 0;
  for (const r of drivable) {
    let seg: P2[] = [r.pts[0]];
    for (let i = 1; i < r.pts.length; i++) {
      seg.push(r.pts[i]);
      const isNode = (usage.get(key(r.pts[i])) ?? 0) >= 2 || i === r.pts.length - 1;
      if (isNode && seg.length >= 2) {
        let len = 0;
        for (let j = 1; j < seg.length; j++) len += Math.hypot(seg[j][0] - seg[j - 1][0], seg[j][1] - seg[j - 1][1]);
        if (len > 1) {
          const e: Edge = { a: key(seg[0]), b: key(seg[seg.length - 1]), pts: [...seg], len, cls: r.cls, id: eid++ };
          edges.push(e);
          if (!adj.has(e.a)) adj.set(e.a, []);
          if (!adj.has(e.b)) adj.set(e.b, []);
          adj.get(e.a)!.push(edges.length - 1);
          adj.get(e.b)!.push(edges.length - 1);
        }
        seg = [r.pts[i]];
      }
    }
  }

  // Waypoints → nearest real intersections, then shortest-path legs
  // (Dijkstra over edge length) between consecutive waypoints, closed.
  const mPerLon = 111320 * Math.cos((city.lat0 * Math.PI) / 180);
  const nodePos = new Map<string, P2>();
  for (const e of edges) {
    nodePos.set(e.a, e.pts[0]);
    nodePos.set(e.b, e.pts[e.pts.length - 1]);
  }
  const nearestNode = (lat: number, lon: number): string => {
    const px = (lon - city.lon0) * mPerLon;
    const pz = -(lat - city.lat0) * 110574;
    let best = "";
    let bestD = Infinity;
    for (const [k, p] of nodePos) {
      if ((adj.get(k)?.length ?? 0) < 3) continue; // real intersections only
      const d = Math.hypot(p[0] - px, p[1] - pz);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (!best) throw new Error("route: no node near waypoint");
    return best;
  };

  const dijkstra = (from: string, to: string): { edge: number; fwd: boolean }[] => {
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, { from: string; edge: number; fwd: boolean }>();
    const done = new Set<string>();
    while (true) {
      let cur = "";
      let curD = Infinity;
      for (const [k, d] of dist) {
        if (!done.has(k) && d < curD) { curD = d; cur = k; }
      }
      if (!cur) break;
      if (cur === to) break;
      done.add(cur);
      for (const ei of adj.get(cur) ?? []) {
        const e = edges[ei];
        const nb = e.a === cur ? e.b : e.a;
        const nd = curD + e.len;
        if (nd < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, nd);
          prev.set(nb, { from: cur, edge: ei, fwd: e.a === cur });
        }
      }
    }
    const leg: { edge: number; fwd: boolean }[] = [];
    let n = to;
    while (n !== from) {
      const p = prev.get(n);
      if (!p) return []; // unreachable
      leg.unshift({ edge: p.edge, fwd: p.fwd });
      n = p.from;
    }
    return leg;
  };

  const stops = city.waypoints.map(([lat, lon]) => nearestNode(lat, lon));
  const path: { edge: number; fwd: boolean }[] = [];
  for (let i = 0; i < stops.length; i++) {
    const leg = dijkstra(stops[i], stops[(i + 1) % stops.length]);
    if (!leg.length && stops[i] !== stops[(i + 1) % stops.length]) {
      throw new Error(`route: waypoint ${i} unreachable`);
    }
    path.push(...leg);
  }

  // Flatten to a polyline in units.
  const pts: P2[] = [];
  const speeds: number[] = [];
  for (const step of path) {
    const e = edges[step.edge];
    const p = step.fwd ? e.pts : [...e.pts].reverse();
    const spd = ROADS[e.cls].speed;
    for (let i = pts.length ? 1 : 0; i < p.length; i++) {
      pts.push([p[i][0] * UNITS_PER_M, p[i][1] * UNITS_PER_M]);
      speeds.push(spd);
    }
  }

  // Cumulative arclength; drop micro-segments.
  const route: RoutePt[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d < 2) continue;
      s += d;
    }
    route.push({ x: pts[i][0], z: pts[i][1], s, speed: speeds[i] });
  }
  return route;
}

// ---- pack writer ------------------------------------------------------

function writePack(p: {
  originX: number;
  originZ: number;
  nx: number;
  nz: number;
  tiles: (TileBuf | null)[];
  route: RoutePt[];
}): Uint8Array {
  const align16 = (n: number) => (n + 15) & ~15;
  const HDR = 48;
  const dirOff = HDR;
  const dirLen = p.nx * p.nz * 32;
  const routeOff = align16(dirOff + dirLen);
  const routeLen = p.route.length * 16;
  let cursor = align16(routeOff + routeLen);

  const tileSpans: { off: number; v: number; i: number; l: number; t: TileBuf | null }[] = [];
  for (const t of p.tiles) {
    if (!t || t.idx.length === 0) {
      tileSpans.push({ off: 0, v: 0, i: 0, l: 0, t: null });
      continue;
    }
    const v = t.verts.length / 4;
    const i = t.idx.length;
    const l = t.lines.length / 4;
    const bytes = align16(v * 12) + align16(i * 2) + align16(l * 12);
    tileSpans.push({ off: cursor, v, i, l, t });
    cursor += align16(bytes);
  }

  const buf = new ArrayBuffer(cursor);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // Header.
  u8.set([0x50, 0x44, 0x52, 0x56], 0); // "PDRV"
  dv.setUint32(4, 1, true);
  dv.setFloat32(8, UNITS_PER_M, true);
  dv.setFloat32(12, TILE, true);
  dv.setFloat32(16, p.originX, true);
  dv.setFloat32(20, p.originZ, true);
  dv.setUint32(24, p.nx, true);
  dv.setUint32(28, p.nz, true);
  dv.setUint32(32, dirOff, true);
  dv.setUint32(36, routeOff, true);
  dv.setUint32(40, p.route.length, true);
  dv.setUint32(44, 0, true);

  // Tile directory.
  for (let ti = 0; ti < tileSpans.length; ti++) {
    const s = tileSpans[ti];
    const o = dirOff + ti * 32;
    dv.setUint32(o + 0, s.off, true);
    dv.setUint32(o + 4, s.v, true);
    dv.setUint32(o + 8, s.i, true);
    dv.setUint32(o + 12, s.l, true);
    const t = s.t;
    const mn = t ? t.min : [0, 0, 0];
    const mx = t ? t.max : [0, 0, 0];
    dv.setInt16(o + 16, mn[0], true);
    dv.setInt16(o + 18, mn[1], true);
    dv.setInt16(o + 20, mn[2], true);
    dv.setInt16(o + 22, mx[0], true);
    dv.setInt16(o + 24, mx[1], true);
    dv.setInt16(o + 26, mx[2], true);
    dv.setUint32(o + 28, 0, true);
  }

  // Route.
  for (let i = 0; i < p.route.length; i++) {
    const o = routeOff + i * 16;
    dv.setFloat32(o + 0, p.route[i].x, true);
    dv.setFloat32(o + 4, p.route[i].z, true);
    dv.setFloat32(o + 8, p.route[i].s, true);
    dv.setFloat32(o + 12, p.route[i].speed, true);
  }

  // Tile payloads: [verts][idx][lineVerts], each 16-aligned.
  for (const s of tileSpans) {
    if (!s.t) continue;
    let o = s.off;
    const t = s.t;
    for (let vi = 0; vi < s.v; vi++) {
      dv.setUint32(o + vi * 12, t.verts[vi * 4], true);
      dv.setInt16(o + vi * 12 + 4, t.verts[vi * 4 + 1], true);
      dv.setInt16(o + vi * 12 + 6, t.verts[vi * 4 + 2], true);
      dv.setInt16(o + vi * 12 + 8, t.verts[vi * 4 + 3], true);
    }
    o = align16(o + s.v * 12);
    for (let ii = 0; ii < s.i; ii++) dv.setUint16(o + ii * 2, t.idx[ii], true);
    o = align16(o + s.i * 2);
    for (let li = 0; li < s.l; li++) {
      dv.setUint32(o + li * 12, t.lines[li * 4], true);
      dv.setInt16(o + li * 12 + 4, t.lines[li * 4 + 1], true);
      dv.setInt16(o + li * 12 + 6, t.lines[li * 4 + 2], true);
      dv.setInt16(o + li * 12 + 8, t.lines[li * 4 + 3], true);
    }
  }
  return u8;
}

// ---- SVG preview ------------------------------------------------------

function writeSvg(
  path: string,
  extract: Extract,
  route: RoutePt[],
  grid: { originX: number; originZ: number; nx: number; nz: number },
) {
  const u = UNITS_PER_M;
  const parts: string[] = [];
  const vb = `${grid.originX} ${grid.originZ} ${grid.nx * TILE} ${grid.nz * TILE}`;
  const svgH = Math.round((900 * grid.nz) / grid.nx);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="900" height="${svgH}">`,
    `<rect x="${grid.originX}" y="${grid.originZ}" width="${grid.nx * TILE}" height="${grid.nz * TILE}" fill="#131720"/>`,
  );
  for (let tz = 0; tz <= grid.nz; tz++)
    parts.push(`<line x1="${grid.originX}" y1="${grid.originZ + tz * TILE}" x2="${grid.originX + grid.nx * TILE}" y2="${grid.originZ + tz * TILE}" stroke="#1e2430" stroke-width="2"/>`);
  for (let tx = 0; tx <= grid.nx; tx++)
    parts.push(`<line x1="${grid.originX + tx * TILE}" y1="${grid.originZ}" x2="${grid.originX + tx * TILE}" y2="${grid.originZ + grid.nz * TILE}" stroke="#1e2430" stroke-width="2"/>`);
  for (const r of extract.roads) {
    const spec = ROADS[r.cls];
    const d = r.pts.map(([x, z], i) => `${i ? "L" : "M"}${(x * u).toFixed(0)} ${(z * u).toFixed(0)}`).join("");
    parts.push(`<path d="${d}" fill="none" stroke="${spec.drive ? "#39414f" : "#2c3340"}" stroke-width="${spec.w * u}" stroke-linecap="round"/>`);
  }
  for (const b of extract.buildings) {
    const d = b.ring.map(([x, z], i) => `${i ? "L" : "M"}${(x * u).toFixed(0)} ${(z * u).toFixed(0)}`).join("") + "Z";
    const bright = Math.min(255, 70 + b.h * 1.1);
    parts.push(`<path d="${d}" fill="rgb(${bright * 0.72},${bright * 0.8},${bright})" fill-opacity="0.9"/>`);
  }
  const rd = route.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(0)} ${p.z.toFixed(0)}`).join("");
  parts.push(`<path d="${rd}" fill="none" stroke="#3f9bff" stroke-width="14" stroke-opacity="0.9"/>`);
  parts.push(`<circle cx="${route[0].x}" cy="${route[0].z}" r="30" fill="#ffffff"/>`);
  parts.push(`</svg>`);
  Bun.write(path, parts.join("\n"));
}
