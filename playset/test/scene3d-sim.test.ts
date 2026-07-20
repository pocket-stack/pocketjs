// scene3d sim host (playset/scene3d/sim.ts) — handle lifecycle, batched
// writes, pool replace semantics, canonical serialization and the
// determinism golden. Runs renderless: no wasm core, no bundle, just ops.
import { expect, test } from "bun:test";
import { BEAM_STRIDE, POSE_STRIDE, SPRITE_STRIDE } from "../scene3d/ops.ts";
import { createScene3dSim } from "../scene3d/sim.ts";
import type { Scene3dOps } from "../scene3d/ops.ts";

/** FNV-1a 32-bit over an (ASCII) string — hashes serialized scenes so the
 *  end-to-end golden compares a compact sequence, host-sim/sim.ts style. */
function fnvStr(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function ser(ops: Scene3dOps, scene: number): string {
  return ops.__serialize!(scene);
}

// ---------------------------------------------------------------------------
// handle lifecycle
// ---------------------------------------------------------------------------

test("handles: per-kind monotonic ids, never reused after destroy", () => {
  const { ops } = createScene3dSim();
  // Each kind has its own counter starting at 1.
  const s = ops.sceneCreate();
  expect(s).toBe(1);
  expect(ops.nodeCreate(s, 0)).toBe(1);
  expect(ops.geomBox(1, 1, 1)).toBe(1);
  expect(ops.material(0xff0000ff, 0)).toBe(1);
  expect(ops.spritePool(s, 8, 1)).toBe(1);
  expect(ops.beamPool(s, 8, 1)).toBe(2); // pools share one namespace

  // Destroyed ids are never minted again within a run.
  ops.nodeDestroy(1);
  expect(ops.nodeCreate(s, 0)).toBe(2);
  ops.geomFree(1);
  expect(ops.geomSphere(1, 8)).toBe(2);
  ops.materialFree(1);
  expect(ops.material(0xffffffff, 0)).toBe(2);
  ops.poolFree(1);
  expect(ops.spritePool(s, 4, 2)).toBe(3);
  ops.sceneDestroy(s);
  expect(ops.sceneCreate()).toBe(2);
});

test("handles: nodeDestroy kills the whole subtree; dead ids are silent no-ops", () => {
  const { ops, worldOf } = createScene3dSim();
  const s = ops.sceneCreate();
  const root = ops.nodeCreate(s, 0);
  const a = ops.nodeCreate(s, root);
  const b = ops.nodeCreate(s, a);
  const keeper = ops.nodeCreate(s, root);
  expect(worldOf(s).nodes.size).toBe(4);

  ops.nodeDestroy(a); // a AND its child b die
  const w = worldOf(s);
  expect(w.nodes.size).toBe(2);
  expect(w.nodes.has(a)).toBe(false);
  expect(w.nodes.has(b)).toBe(false);
  expect(w.nodes.get(root)!.children).toEqual([keeper]);

  // Every op on a dead/unknown handle is a silent no-op — nothing throws,
  // nothing resurrects.
  ops.nodeSetPose(b, 1, 2, 3, 0, 0, 0, 1);
  ops.nodeSetScale(b, 2, 2, 2);
  ops.nodeSetVisible(b, 0);
  ops.nodeSetParent(b, root);
  ops.meshSet(b, 1, 1);
  ops.nodeSetTint(b, 0x80808080);
  ops.nodeDestroy(b);
  ops.nodeDestroy(9999);
  expect(worldOf(s).nodes.size).toBe(2);

  // Creating under a dead parent mints nothing and returns 0 ("none").
  expect(ops.nodeCreate(s, a)).toBe(0);
  expect(worldOf(s).nodes.size).toBe(2);
  // ...and creating in a dead scene too.
  expect(ops.nodeCreate(777, 0)).toBe(0);
});

test("handles: sceneDestroy frees its nodes+pools; geoms/materials survive", () => {
  const { ops } = createScene3dSim();
  const g = ops.geomBox(1, 2, 3);
  const m = ops.material(0xff00ff00, 0);
  const s1 = ops.sceneCreate();
  const n1 = ops.nodeCreate(s1, 0);
  const p1 = ops.spritePool(s1, 4, m);
  ops.sceneDestroy(s1);

  // Ops against the dead scene's handles are silent no-ops.
  ops.nodeSetPose(n1, 1, 1, 1, 0, 0, 0, 1);
  ops.writeSprites(p1, new Float32Array(SPRITE_STRIDE), new Uint32Array(1), 1);
  ops.sceneDestroy(s1);
  expect(() => ser(ops, s1)).toThrow();

  // The geom and material are scene-independent and still usable.
  const s2 = ops.sceneCreate();
  const n2 = ops.nodeCreate(s2, 0);
  ops.meshSet(n2, g, m);
  ops.materialSetColor(m, 0xff0000ff);
  const doc = JSON.parse(ser(ops, s2)) as {
    geoms: { id: number; params: { hx: number; hy: number; hz: number } }[];
    materials: { id: number; color: number; flags: number }[];
  };
  expect(doc.geoms).toHaveLength(1);
  expect(doc.geoms[0].id).toBe(g);
  expect(doc.geoms[0].params).toEqual({ hx: 1, hy: 2, hz: 3 });
  expect(doc.materials).toEqual([{ color: 0xff0000ff, flags: 0, id: m }]);
});

// ---------------------------------------------------------------------------
// writePoses
// ---------------------------------------------------------------------------

test("writePoses: batch apply, unknown ids ignored, f32 ids round", () => {
  const { ops, worldOf } = createScene3dSim();
  const s = ops.sceneCreate();
  const n1 = ops.nodeCreate(s, 0);
  const n2 = ops.nodeCreate(s, 0);

  const buf = new Float32Array(3 * POSE_STRIDE);
  // entry 0 → n1, exact id
  buf.set([n1, 1, 2, 3, 0, 0.6, 0, 0.8, 1, 1, 1], 0 * POSE_STRIDE);
  // entry 1 → unknown id, must be ignored without aborting the batch
  buf.set([999, 9, 9, 9, 0, 0, 0, 1, 9, 9, 9], 1 * POSE_STRIDE);
  // entry 2 → n2, id arrives as an imprecise f32 and must Math.round back
  buf.set([n2 + 1e-7, 4, 5, 6, 0, 0, 0, 1, 2, 2, 2], 2 * POSE_STRIDE);
  ops.writePoses(buf, 3);

  const w = worldOf(s);
  expect(w.nodes.get(n1)!.p).toEqual([1, 2, 3]);
  expect(w.nodes.get(n1)!.q).toEqual([0, Math.fround(0.6), 0, Math.fround(0.8)]);
  expect(w.nodes.get(n2)!.p).toEqual([4, 5, 6]);
  expect(w.nodes.get(n2)!.s).toEqual([2, 2, 2]);

  // count beyond the buffer never reads garbage; only whole entries apply.
  ops.writePoses(buf, 50);
  expect(worldOf(s).nodes.get(n2)!.p).toEqual([4, 5, 6]);
});

// ---------------------------------------------------------------------------
// pools
// ---------------------------------------------------------------------------

test("pools: writes REPLACE the live set, clamp to capacity, count drops", () => {
  const { ops, worldOf } = createScene3dSim();
  const s = ops.sceneCreate();
  const m = ops.material(0xffffffff, 0);
  const p = ops.spritePool(s, 4, m);

  const sprites = (n: number, base: number) => {
    const buf = new Float32Array(n * SPRITE_STRIDE);
    const colors = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      buf.set([base + i, 0, 0, 1], i * SPRITE_STRIDE);
      colors[i] = 0xff000000 + i;
    }
    return { buf, colors };
  };

  let w = sprites(3, 10);
  ops.writeSprites(p, w.buf, w.colors, 3);
  let pool = worldOf(s).pools.get(p)!;
  expect(pool.live).toHaveLength(3);
  expect(pool.live[0]).toEqual([10, 0, 0, 1]);
  expect(pool.colors).toEqual([0xff000000, 0xff000001, 0xff000002]);
  expect(pool.droppedWrites).toBe(0);

  // Over capacity: clamped, drops counted.
  w = sprites(6, 20);
  ops.writeSprites(p, w.buf, w.colors, 6);
  pool = worldOf(s).pools.get(p)!;
  expect(pool.live).toHaveLength(4);
  expect(pool.live[3]).toEqual([23, 0, 0, 1]);
  expect(pool.droppedWrites).toBe(2);

  // Replace, not append: a smaller write shrinks the live set.
  w = sprites(2, 30);
  ops.writeSprites(p, w.buf, w.colors, 2);
  pool = worldOf(s).pools.get(p)!;
  expect(pool.live).toHaveLength(2);
  expect(pool.live[1]).toEqual([31, 0, 0, 1]);
  expect(pool.droppedWrites).toBe(2); // unchanged

  // Beams: same contract, BEAM_STRIDE entries.
  const bp = ops.beamPool(s, 2, m);
  const bbuf = new Float32Array(3 * BEAM_STRIDE);
  for (let i = 0; i < 3; i++) bbuf.set([i, 0, 0, i, 1, 0, 0.5], i * BEAM_STRIDE);
  ops.writeBeams(bp, bbuf, new Uint32Array([1, 2, 3]), 3);
  const beams = worldOf(s).pools.get(bp)!;
  expect(beams.live).toHaveLength(2);
  expect(beams.live[1]).toEqual([1, 0, 0, 1, 1, 0, 0.5]);
  expect(beams.droppedWrites).toBe(1);

  // Kind mismatch and dead pools are silent no-ops.
  ops.writeBeams(p, bbuf, new Uint32Array(3), 3);
  expect(worldOf(s).pools.get(p)!.live).toHaveLength(2);
  ops.poolFree(p);
  ops.writeSprites(p, w.buf, w.colors, 2);
  expect(worldOf(s).pools.has(p)).toBe(false);
});

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

/** One fixed op sequence; `nudge` perturbs a single pose component. */
function buildScene(ops: Scene3dOps, nudge = 0): number {
  const s = ops.sceneCreate();
  const g = ops.geomBox(0.5, 0.5, 0.5);
  const m = ops.material(0xff3366cc, 0);
  const root = ops.nodeCreate(s, 0);
  const child = ops.nodeCreate(s, root);
  ops.meshSet(child, g, m);
  ops.nodeSetPose(child, 1 + nudge, 2, 3, 0, 0, 0, 1);
  ops.nodeSetScale(child, 1, 2, 1);
  ops.nodeSetTint(child, 0x80ffffff);
  ops.sun(s, -1, -2, -0.5, 0xffffeecc);
  ops.ambient(s, 0xff445566, 0xff223344);
  ops.fog(s, 0xffaabbcc, 5, 50);
  ops.sky(s, 0xffff8800, 0xff220044);
  ops.camera(s, 0, 3, 8, 0, 0.1961161, 0, 0.9805807, Math.PI / 4, 0.5, 200);
  return s;
}

test("serialize: byte-identical across fresh sims; any input change shows up", () => {
  const a = createScene3dSim();
  const b = createScene3dSim();
  const jsonA = ser(a.ops, buildScene(a.ops));
  const jsonB = ser(b.ops, buildScene(b.ops));
  expect(jsonA).toBe(jsonB);

  const c = createScene3dSim();
  const jsonC = ser(c.ops, buildScene(c.ops, 0.001)); // one pose nudge
  expect(jsonC).not.toBe(jsonA);
});

test("serialize: fresh scene carries the documented env defaults", () => {
  const { ops } = createScene3dSim();
  const s = ops.sceneCreate();
  const doc = JSON.parse(ser(ops, s)) as {
    env: {
      camera: { p: number[]; q: number[]; fovY: number; znear: number; zfar: number };
      sun: unknown;
      ambient: unknown;
      fog: unknown;
      sky: unknown;
    };
    nodes: unknown[];
    viewports: unknown[];
  };
  expect(doc.env.camera.p).toEqual([0, 0, 10]);
  expect(doc.env.camera.q).toEqual([0, 0, 0, 1]);
  expect(doc.env.camera.fovY).toBeCloseTo(Math.PI / 3, 4);
  expect(doc.env.camera.znear).toBeCloseTo(0.1, 6);
  expect(doc.env.camera.zfar).toBe(1000);
  expect(doc.env.fog).toBeNull(); // no fog until set
  expect(doc.env.sun).toBeNull();
  expect(doc.env.ambient).toBeNull();
  expect(doc.env.sky).toBeNull();
  expect(doc.nodes).toEqual([]);
  expect(doc.viewports).toEqual([]);

  // far <= near disables fog again.
  ops.fog(s, 0xffffffff, 1, 100);
  expect((JSON.parse(ser(ops, s)) as { env: { fog: unknown } }).env.fog).not.toBeNull();
  ops.fog(s, 0xffffffff, 100, 100);
  expect((JSON.parse(ser(ops, s)) as { env: { fog: unknown } }).env.fog).toBeNull();
});

test("serialize: large arrays are digested as {len, fnv}; buffers are copied", () => {
  type HfDoc = {
    geoms: { params: { heights: { fnv: string; len: number }; colors: unknown } }[];
  };
  const heights = () => new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const build = (h: Float32Array) => {
    const sim = createScene3dSim();
    const s = sim.ops.sceneCreate();
    const g = sim.ops.geomHeightfield(12, 12, 4, 3, h, null);
    const n = sim.ops.nodeCreate(s, 0);
    sim.ops.meshSet(n, g, sim.ops.material(0xffffffff, 0));
    return { sim, s };
  };

  const same1 = build(heights());
  const same2 = build(heights()); // distinct array object, equal contents
  const diffH = heights();
  diffH[5] = 99;
  const diff = build(diffH);

  const doc1 = JSON.parse(ser(same1.sim.ops, same1.s)) as HfDoc;
  const doc2 = JSON.parse(ser(same2.sim.ops, same2.s)) as HfDoc;
  const doc3 = JSON.parse(ser(diff.sim.ops, diff.s)) as HfDoc;
  expect(doc1.geoms[0].params.heights).toEqual({ fnv: doc1.geoms[0].params.heights.fnv, len: 12 });
  expect(doc1.geoms[0].params.heights.fnv).toBe(doc2.geoms[0].params.heights.fnv);
  expect(doc1.geoms[0].params.heights.fnv).not.toBe(doc3.geoms[0].params.heights.fnv);
  expect(doc1.geoms[0].params.colors).toBeNull();

  // Copy semantics: mutating the caller's buffer after creation changes nothing.
  const src = heights();
  const copied = build(src);
  const before = ser(copied.sim.ops, copied.s);
  src.fill(1234);
  expect(ser(copied.sim.ops, copied.s)).toBe(before);
});

// ---------------------------------------------------------------------------
// end-to-end determinism golden
// ---------------------------------------------------------------------------

test("end-to-end: 10-frame serialized-hash sequence is stable across runs", () => {
  const run = (): string[] => {
    const { ops } = createScene3dSim();
    const s = ops.sceneCreate();
    // 3-node hierarchy: rig group → box + sphere.
    const rig = ops.nodeCreate(s, 0);
    const boxN = ops.nodeCreate(s, rig);
    const sphN = ops.nodeCreate(s, rig);
    const boxG = ops.geomBox(1, 1, 1);
    const sphG = ops.geomSphere(0.75, 12);
    const matA = ops.material(0xffcc8833, 0);
    const matB = ops.material(0xff3388cc, 2); // MAT.unlit
    ops.meshSet(boxN, boxG, matA);
    ops.meshSet(sphN, sphG, matB);
    ops.sun(s, -0.4, -1, -0.3, 0xffffeedd);
    ops.fog(s, 0xff8899aa, 10, 80);
    ops.camera(s, 0, 4, 12, 0, 0, 0, 1, Math.PI / 3, 0.1, 500);
    const pool = ops.spritePool(s, 8, matB);

    const poses = new Float32Array(3 * POSE_STRIDE);
    const hashes: string[] = [];
    for (let f = 0; f < 10; f++) {
      const t = f / 10;
      const c = Math.cos(t * Math.PI);
      const n = Math.sin(t * Math.PI);
      poses.set([rig, 0, 0, -t * 4, 0, n, 0, c, 1, 1, 1], 0 * POSE_STRIDE);
      poses.set([boxN, -2, 1 + t, 0, 0, 0, 0, 1, 1, 1, 1], 1 * POSE_STRIDE);
      poses.set([sphN, 2, 1, t * 2, 0, 0, n, c, 1 + t, 1, 1], 2 * POSE_STRIDE);
      ops.writePoses(poses, 3);

      const count = (f % 8) + 1;
      const sbuf = new Float32Array(count * SPRITE_STRIDE);
      const scol = new Uint32Array(count);
      for (let i = 0; i < count; i++) {
        sbuf.set([i - count / 2, t * 3 + i * 0.25, -t, 0.5 + i * 0.1], i * SPRITE_STRIDE);
        scol[i] = (0xff000000 + i * 0x1010) >>> 0;
      }
      ops.writeSprites(pool, sbuf, scol, count);
      hashes.push(fnvStr(ops.__serialize!(s)));
    }
    return hashes;
  };

  const a = run();
  const b = run();
  expect(a).toHaveLength(10);
  expect(b).toEqual(a); // byte-stable golden across fresh runs
  expect(new Set(a).size).toBe(10); // and every frame actually differs
});

// ---------------------------------------------------------------------------
// viewport binding
// ---------------------------------------------------------------------------

test("bindViewport: recorded per scene; scene 0 unbinds; rebind moves", () => {
  const { ops } = createScene3dSim();
  const s1 = ops.sceneCreate();
  const s2 = ops.sceneCreate();
  const vps = (s: number) => (JSON.parse(ser(ops, s)) as { viewports: number[] }).viewports;

  ops.bindViewport(42, s1);
  ops.bindViewport(7, s1);
  expect(vps(s1)).toEqual([7, 42]); // sorted, stable
  expect(vps(s2)).toEqual([]);

  ops.bindViewport(7, s2); // a ui node shows one scene at a time
  expect(vps(s1)).toEqual([42]);
  expect(vps(s2)).toEqual([7]);

  ops.bindViewport(42, 0); // scene 0 unbinds
  expect(vps(s1)).toEqual([]);

  ops.bindViewport(9, 12345); // unknown scene: silent no-op
  expect(vps(s1)).toEqual([]);
  expect(vps(s2)).toEqual([7]);
});
