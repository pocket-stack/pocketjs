// playset/scene3d/sim.ts — the renderless reference host for the `scene3d`
// surface (ops.ts). The 3D sibling of host-sim/sim.ts: no GPU, no screen,
// just retained state, so a guest's op stream can be replayed headlessly and
// probed with __serialize() — the golden-trace hook for deterministic tests.
//
// Determinism rules (DETERMINISM.md applied to handles and state):
//   - Handle ids are monotonically increasing positive integers PER KIND
//     (scene/node/geom/material/pool). Destroyed ids are never reused within
//     a run, so a stale handle can never silently alias a new object and two
//     identical op sequences always mint identical ids.
//   - Ops on dead/unknown handles are SILENT no-ops (ops.ts: a destroy may
//     race a staged write inside one guest turn — last write wins, no throw).
//     Creation ops that would need a dead owner return 0 ("none") instead of
//     creating an orphan. geom/material creation always succeeds.
//   - geomMesh/geomHeightfield COPY their arrays (callers may reuse buffers).
//   - __serialize emits canonical JSON: recursively sorted keys, nodes/pools/
//     geoms/materials in ascending id order, spatial floats quantized to f32
//     then 6 significant decimals (platform-stable goldens), and large arrays
//     digested as {fnv, len} (FNV-1a, the host-sim/sim.ts pattern) so goldens
//     stay small. u32 payloads (colors, flags, ids) pass through unquantized.
//
// This module is dependency-free by design: nothing beyond ops.ts constants
// and types, so it runs anywhere a guest does (bun test, browser, worker).

import { BEAM_STRIDE, GEOM_KIND, POSE_STRIDE, SPRITE_STRIDE } from "./ops.ts";
import type { Scene3dOps } from "./ops.ts";

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface SimNode {
  id: number;
  scene: number;
  /** Parent node id; 0 = scene root. */
  parent: number;
  /** Child ids in insertion order. */
  children: number[];
  p: Vec3;
  q: Quat;
  s: Vec3;
  visible: boolean;
  /** 0 = bare group. May dangle after geomFree — the node draws nothing. */
  geomId: number;
  matId: number;
  /** u32 ABGR; 0xffffffff = no tint. */
  tint: number;
}

/** Geometries are stored as their creation params, never tessellated. */
export type SimGeom =
  | { kind: typeof GEOM_KIND.box; hx: number; hy: number; hz: number }
  | { kind: typeof GEOM_KIND.sphere; radius: number; segments: number }
  | {
      kind: typeof GEOM_KIND.cylinder;
      radiusTop: number;
      radiusBottom: number;
      height: number;
      segments: number;
    }
  | { kind: typeof GEOM_KIND.cone; radius: number; height: number; segments: number }
  | { kind: typeof GEOM_KIND.plane; w: number; d: number }
  | {
      kind: typeof GEOM_KIND.torus;
      radius: number;
      tube: number;
      segments: number;
      tubeSegments: number;
    }
  | {
      kind: typeof GEOM_KIND.mesh;
      positions: Float32Array;
      indices: Uint32Array;
      colors: Float32Array | null;
    }
  | {
      kind: typeof GEOM_KIND.heightfield;
      w: number;
      d: number;
      cols: number;
      rows: number;
      heights: Float32Array;
      colors: Float32Array | null;
    };

export interface SimMaterial {
  color: number;
  flags: number;
}

export interface SimPool {
  id: number;
  scene: number;
  kind: "sprite" | "beam";
  capacity: number;
  matId: number;
  /** Live entries (SPRITE_STRIDE or BEAM_STRIDE floats each), REPLACED per write. */
  live: number[][];
  /** One u32 ABGR per live entry. */
  colors: number[];
  /** Entries clamped away because a write's count exceeded capacity. */
  droppedWrites: number;
}

export interface SimEnv {
  /** null until sun() — the scene has no directional light yet. */
  sun: { dir: Vec3; color: number } | null;
  sky: { zenith: number; horizon: number } | null;
  ambient: { sky: number; ground: number } | null;
  /** null = disabled (fog() with far <= near also disables). */
  fog: { color: number; near: number; far: number } | null;
  camera: { p: Vec3; q: Quat; fovY: number; znear: number; zfar: number };
}

export interface SimScene {
  id: number;
  /** Root-level child node ids in creation order. */
  root: number[];
  nodes: Map<number, SimNode>;
  pools: Map<number, SimPool>;
  env: SimEnv;
}

/** FNV-1a 32-bit (host-sim/sim.ts pattern) over raw bytes. */
function fnv1aBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Digest a large typed array for serialization: length + content hash. */
function digest(arr: Float32Array | Uint32Array): { fnv: string; len: number } {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return { fnv: fnv1aBytes(bytes), len: arr.length };
}

/** Quantize a spatial float for goldens: f32, then 6 significant decimals
 *  (absorbs sub-f32 libm differences across platforms). -0 folds to 0. */
function q(n: number): number {
  const f = Math.fround(n);
  if (!Number.isFinite(f)) return f;
  if (f === 0) return 0;
  return Number(f.toPrecision(6));
}

function q3(v: Vec3): number[] {
  return [q(v[0]), q(v[1]), q(v[2])];
}

function q4(v: Quat): number[] {
  return [q(v[0]), q(v[1]), q(v[2]), q(v[3])];
}

/** Canonical JSON: recursively sorted object keys; non-finite numbers → null
 *  (JSON semantics, but reached deterministically). */
function canonJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonJson(o[k])).join(",") + "}";
}

function defaultEnv(): SimEnv {
  return {
    sun: null,
    sky: null,
    ambient: null,
    fog: null,
    // ops.ts conventions: -Z forward, radians. Default camera sits at
    // (0,0,10) looking down -Z with a 60° vertical FOV.
    camera: { p: [0, 0, 10], q: [0, 0, 0, 1], fovY: Math.PI / 3, znear: 0.1, zfar: 1000 },
  };
}

export function createScene3dSim(): {
  ops: Scene3dOps;
  worldOf(scene: number): SimScene;
} {
  const scenes = new Map<number, SimScene>();
  // Node/pool ids are host-global (nodeDestroy/writePoses/poolFree carry no
  // scene), so global registries dispatch; each scene keeps its own view.
  const nodes = new Map<number, SimNode>();
  const pools = new Map<number, SimPool>();
  const geoms = new Map<number, SimGeom>();
  const materials = new Map<number, SimMaterial>();
  /** uiNodeId → scene (bindViewport bookkeeping). */
  const viewports = new Map<number, number>();

  let nextScene = 1;
  let nextNode = 1;
  let nextGeom = 1;
  let nextMat = 1;
  let nextPool = 1;

  /** The sibling list a node lives in (parent's children or the scene root). */
  function siblingsOf(node: SimNode): number[] | undefined {
    if (node.parent !== 0) return nodes.get(node.parent)?.children;
    return scenes.get(node.scene)?.root;
  }

  function unlink(node: SimNode): void {
    const list = siblingsOf(node);
    if (!list) return;
    const i = list.indexOf(node.id);
    if (i >= 0) list.splice(i, 1);
  }

  /** Remove `node` and its whole subtree from the registries (link to the
   *  parent list must already be cut). */
  function reap(node: SimNode): void {
    for (const cid of node.children) {
      const child = nodes.get(cid);
      if (child) reap(child);
    }
    nodes.delete(node.id);
    scenes.get(node.scene)?.nodes.delete(node.id);
  }

  function poolCreate(scene: number, capacity: number, matId: number, kind: "sprite" | "beam"): number {
    const sc = scenes.get(scene);
    if (!sc) return 0;
    const id = nextPool++;
    const pool: SimPool = {
      id,
      scene,
      kind,
      capacity: Math.max(0, Math.floor(capacity)),
      matId,
      live: [],
      colors: [],
      droppedWrites: 0,
    };
    pools.set(id, pool);
    sc.pools.set(id, pool);
    return id;
  }

  function poolWrite(
    poolId: number,
    kind: "sprite" | "beam",
    stride: number,
    buf: Float32Array,
    colors: Uint32Array,
    count: number,
  ): void {
    const pool = pools.get(poolId);
    if (!pool || pool.kind !== kind) return;
    const requested = Math.max(0, Math.floor(count));
    // Never read past what the caller actually supplied.
    const present = Math.min(requested, Math.floor(buf.length / stride), colors.length);
    const kept = Math.min(present, pool.capacity);
    pool.droppedWrites += Math.max(0, requested - pool.capacity);
    pool.live = [];
    pool.colors = [];
    for (let i = 0; i < kept; i++) {
      const entry: number[] = [];
      for (let j = 0; j < stride; j++) entry.push(buf[i * stride + j]);
      pool.live.push(entry);
      pool.colors.push(colors[i] >>> 0);
    }
  }

  function geomJson(id: number, g: SimGeom): Record<string, unknown> {
    switch (g.kind) {
      case GEOM_KIND.box:
        return { id, kind: g.kind, params: { hx: q(g.hx), hy: q(g.hy), hz: q(g.hz) } };
      case GEOM_KIND.sphere:
        return { id, kind: g.kind, params: { radius: q(g.radius), segments: g.segments } };
      case GEOM_KIND.cylinder:
        return {
          id,
          kind: g.kind,
          params: {
            height: q(g.height),
            radiusBottom: q(g.radiusBottom),
            radiusTop: q(g.radiusTop),
            segments: g.segments,
          },
        };
      case GEOM_KIND.cone:
        return {
          id,
          kind: g.kind,
          params: { height: q(g.height), radius: q(g.radius), segments: g.segments },
        };
      case GEOM_KIND.plane:
        return { id, kind: g.kind, params: { d: q(g.d), w: q(g.w) } };
      case GEOM_KIND.torus:
        return {
          id,
          kind: g.kind,
          params: {
            radius: q(g.radius),
            segments: g.segments,
            tube: q(g.tube),
            tubeSegments: g.tubeSegments,
          },
        };
      case GEOM_KIND.mesh:
        return {
          id,
          kind: g.kind,
          params: {
            colors: g.colors ? digest(g.colors) : null,
            indices: digest(g.indices),
            positions: digest(g.positions),
          },
        };
      case GEOM_KIND.heightfield:
        return {
          id,
          kind: g.kind,
          params: {
            colors: g.colors ? digest(g.colors) : null,
            cols: g.cols,
            d: q(g.d),
            heights: digest(g.heights),
            rows: g.rows,
            w: q(g.w),
          },
        };
    }
  }

  function serialize(scene: number): string {
    const sc = scenes.get(scene);
    if (!sc) throw new Error(`scene3d-sim: __serialize(${scene}): unknown scene`);
    const refGeoms = new Set<number>();
    const refMats = new Set<number>();
    const nodeIds = [...sc.nodes.keys()].sort((a, b) => a - b);
    const nodesJson = nodeIds.map((nid) => {
      const n = sc.nodes.get(nid)!;
      if (n.geomId !== 0 && geoms.has(n.geomId)) refGeoms.add(n.geomId);
      if (n.matId !== 0 && materials.has(n.matId)) refMats.add(n.matId);
      return {
        geom: n.geomId,
        id: n.id,
        mat: n.matId,
        p: q3(n.p),
        parent: n.parent,
        q: q4(n.q),
        s: q3(n.s),
        tint: n.tint,
        visible: n.visible,
      };
    });
    const poolIds = [...sc.pools.keys()].sort((a, b) => a - b);
    const poolsJson = poolIds.map((pid) => {
      const p = sc.pools.get(pid)!;
      if (p.matId !== 0 && materials.has(p.matId)) refMats.add(p.matId);
      return {
        capacity: p.capacity,
        colors: p.colors,
        dropped: p.droppedWrites,
        entries: p.live.map((e) => e.map(q)),
        id: p.id,
        kind: p.kind,
        mat: p.matId,
      };
    });
    const geomsJson = [...refGeoms].sort((a, b) => a - b).map((id) => geomJson(id, geoms.get(id)!));
    const matsJson = [...refMats]
      .sort((a, b) => a - b)
      .map((id) => {
        const m = materials.get(id)!;
        return { color: m.color, flags: m.flags, id };
      });
    const vps = [...viewports.entries()]
      .filter(([, s]) => s === scene)
      .map(([ui]) => ui)
      .sort((a, b) => a - b);
    const env = sc.env;
    return canonJson({
      env: {
        ambient: env.ambient ? { ground: env.ambient.ground, sky: env.ambient.sky } : null,
        camera: {
          fovY: q(env.camera.fovY),
          p: q3(env.camera.p),
          q: q4(env.camera.q),
          zfar: q(env.camera.zfar),
          znear: q(env.camera.znear),
        },
        fog: env.fog ? { color: env.fog.color, far: q(env.fog.far), near: q(env.fog.near) } : null,
        sky: env.sky ? { horizon: env.sky.horizon, zenith: env.sky.zenith } : null,
        sun: env.sun ? { color: env.sun.color, dir: q3(env.sun.dir) } : null,
      },
      geoms: geomsJson,
      id: sc.id,
      materials: matsJson,
      nodes: nodesJson,
      pools: poolsJson,
      viewports: vps,
    });
  }

  const ops: Scene3dOps = {
    // -- scenes ---------------------------------------------------------------
    sceneCreate(): number {
      const id = nextScene++;
      scenes.set(id, { id, root: [], nodes: new Map(), pools: new Map(), env: defaultEnv() });
      return id;
    },
    sceneDestroy(scene: number): void {
      const sc = scenes.get(scene);
      if (!sc) return;
      for (const id of sc.nodes.keys()) nodes.delete(id);
      for (const id of sc.pools.keys()) pools.delete(id);
      for (const [ui, s] of viewports) if (s === scene) viewports.delete(ui);
      scenes.delete(scene);
    },

    // -- node tree ------------------------------------------------------------
    nodeCreate(scene: number, parentOr0: number): number {
      const sc = scenes.get(scene);
      if (!sc) return 0;
      let parent: SimNode | undefined;
      if (parentOr0 !== 0) {
        parent = nodes.get(parentOr0);
        if (!parent || parent.scene !== scene) return 0; // dead/foreign parent: no orphan
      }
      const id = nextNode++;
      const node: SimNode = {
        id,
        scene,
        parent: parentOr0,
        children: [],
        p: [0, 0, 0],
        q: [0, 0, 0, 1],
        s: [1, 1, 1],
        visible: true,
        geomId: 0,
        matId: 0,
        tint: 0xffffffff,
      };
      nodes.set(id, node);
      sc.nodes.set(id, node);
      (parent ? parent.children : sc.root).push(id);
      return id;
    },
    nodeDestroy(id: number): void {
      const node = nodes.get(id);
      if (!node) return;
      unlink(node);
      reap(node);
    },
    nodeSetParent(id: number, parentOr0: number): void {
      const node = nodes.get(id);
      if (!node || node.parent === parentOr0) return;
      const sc = scenes.get(node.scene);
      if (!sc) return;
      let newList: number[];
      if (parentOr0 === 0) {
        newList = sc.root;
      } else {
        const parent = nodes.get(parentOr0);
        if (!parent || parent.scene !== node.scene) return; // no cross-scene adoption
        // Cycle guard: adopting under self or a descendant is a no-op.
        for (
          let a: SimNode | undefined = parent;
          a;
          a = a.parent !== 0 ? nodes.get(a.parent) : undefined
        ) {
          if (a.id === id) return;
        }
        newList = parent.children;
      }
      unlink(node);
      node.parent = parentOr0;
      newList.push(id);
    },
    nodeSetVisible(id: number, on: number): void {
      const node = nodes.get(id);
      if (node) node.visible = on !== 0;
    },
    nodeSetPose(
      id: number,
      px: number, py: number, pz: number,
      qx: number, qy: number, qz: number, qw: number,
    ): void {
      const node = nodes.get(id);
      if (!node) return;
      node.p = [px, py, pz];
      node.q = [qx, qy, qz, qw];
    },
    nodeSetScale(id: number, sx: number, sy: number, sz: number): void {
      const node = nodes.get(id);
      if (node) node.s = [sx, sy, sz];
    },
    writePoses(buf: Float32Array, count: number): void {
      const n = Math.max(0, Math.min(count, Math.floor(buf.length / POSE_STRIDE)));
      for (let i = 0; i < n; i++) {
        const b = i * POSE_STRIDE;
        const node = nodes.get(Math.round(buf[b])); // id rides as f32
        if (!node) continue; // ops.ts: unknown ids are ignored
        node.p = [buf[b + 1], buf[b + 2], buf[b + 3]];
        node.q = [buf[b + 4], buf[b + 5], buf[b + 6], buf[b + 7]];
        node.s = [buf[b + 8], buf[b + 9], buf[b + 10]];
      }
    },

    // -- geometry (creation always succeeds; params stored, never tessellated) --
    geomBox(hx: number, hy: number, hz: number): number {
      const id = nextGeom++;
      geoms.set(id, { kind: GEOM_KIND.box, hx, hy, hz });
      return id;
    },
    geomSphere(radius: number, segments: number): number {
      const id = nextGeom++;
      geoms.set(id, { kind: GEOM_KIND.sphere, radius, segments });
      return id;
    },
    geomCylinder(radiusTop: number, radiusBottom: number, height: number, segments: number): number {
      const id = nextGeom++;
      geoms.set(id, { kind: GEOM_KIND.cylinder, radiusTop, radiusBottom, height, segments });
      return id;
    },
    geomCone(radius: number, height: number, segments: number): number {
      const id = nextGeom++;
      geoms.set(id, { kind: GEOM_KIND.cone, radius, height, segments });
      return id;
    },
    geomPlane(w: number, d: number): number {
      const id = nextGeom++;
      geoms.set(id, { kind: GEOM_KIND.plane, w, d });
      return id;
    },
    geomTorus(radius: number, tube: number, segments: number, tubeSegments: number): number {
      const id = nextGeom++;
      geoms.set(id, { kind: GEOM_KIND.torus, radius, tube, segments, tubeSegments });
      return id;
    },
    geomMesh(positions: Float32Array, indices: Uint32Array, colors: Float32Array | null): number {
      const id = nextGeom++;
      geoms.set(id, {
        kind: GEOM_KIND.mesh,
        positions: positions.slice(), // COPY — callers may reuse buffers
        indices: indices.slice(),
        colors: colors ? colors.slice() : null,
      });
      return id;
    },
    geomHeightfield(
      w: number, d: number,
      cols: number, rows: number,
      heights: Float32Array,
      colors: Float32Array | null,
    ): number {
      const id = nextGeom++;
      geoms.set(id, {
        kind: GEOM_KIND.heightfield,
        w,
        d,
        cols,
        rows,
        heights: heights.slice(), // COPY
        colors: colors ? colors.slice() : null,
      });
      return id;
    },
    geomFree(id: number): void {
      geoms.delete(id); // nodes still referencing it draw nothing
    },

    // -- materials --------------------------------------------------------------
    material(color: number, flags: number): number {
      const id = nextMat++;
      materials.set(id, { color: color >>> 0, flags: flags >>> 0 });
      return id;
    },
    materialSetColor(id: number, color: number): void {
      const m = materials.get(id);
      if (m) m.color = color >>> 0;
    },
    materialFree(id: number): void {
      materials.delete(id);
    },

    // -- mesh attachment ----------------------------------------------------------
    meshSet(nodeId: number, geomId: number, matId: number): void {
      const node = nodes.get(nodeId);
      if (!node) return;
      // Ids are stored verbatim (no liveness check): geomFree semantics say a
      // dangling reference draws nothing, it is not an error.
      node.geomId = geomId;
      node.matId = geomId === 0 ? 0 : matId; // geom 0 clears — back to a bare group
    },
    nodeSetTint(nodeId: number, color: number): void {
      const node = nodes.get(nodeId);
      if (node) node.tint = color >>> 0;
    },

    // -- environment -----------------------------------------------------------------
    sun(scene: number, dx: number, dy: number, dz: number, color: number): void {
      const sc = scenes.get(scene);
      if (!sc) return;
      // "normalized by host" — sqrt is IEEE-exact, so this is platform-stable.
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const dir: Vec3 = len > 0 ? [dx / len, dy / len, dz / len] : [0, 0, 0];
      sc.env.sun = { dir, color: color >>> 0 };
    },
    ambient(scene: number, skyColor: number, groundColor: number): void {
      const sc = scenes.get(scene);
      if (sc) sc.env.ambient = { sky: skyColor >>> 0, ground: groundColor >>> 0 };
    },
    fog(scene: number, color: number, near: number, far: number): void {
      const sc = scenes.get(scene);
      if (!sc) return;
      sc.env.fog = far <= near ? null : { color: color >>> 0, near, far };
    },
    sky(scene: number, zenithColor: number, horizonColor: number): void {
      const sc = scenes.get(scene);
      if (sc) sc.env.sky = { zenith: zenithColor >>> 0, horizon: horizonColor >>> 0 };
    },

    // -- camera -------------------------------------------------------------------------
    camera(
      scene: number,
      px: number, py: number, pz: number,
      qx: number, qy: number, qz: number, qw: number,
      fovYRad: number, znear: number, zfar: number,
    ): void {
      const sc = scenes.get(scene);
      if (!sc) return;
      sc.env.camera = { p: [px, py, pz], q: [qx, qy, qz, qw], fovY: fovYRad, znear, zfar };
    },

    // -- pooled billboards & ribbons --------------------------------------------------------
    spritePool(scene: number, capacity: number, matId: number): number {
      return poolCreate(scene, capacity, matId, "sprite");
    },
    writeSprites(pool: number, buf: Float32Array, colors: Uint32Array, count: number): void {
      poolWrite(pool, "sprite", SPRITE_STRIDE, buf, colors, count);
    },
    beamPool(scene: number, capacity: number, matId: number): number {
      return poolCreate(scene, capacity, matId, "beam");
    },
    writeBeams(pool: number, buf: Float32Array, colors: Uint32Array, count: number): void {
      poolWrite(pool, "beam", BEAM_STRIDE, buf, colors, count);
    },
    poolFree(pool: number): void {
      const p = pools.get(pool);
      if (!p) return;
      scenes.get(p.scene)?.pools.delete(pool);
      pools.delete(pool);
    },

    // -- viewport binding ------------------------------------------------------------------------
    bindViewport(uiNodeId: number, scene: number): void {
      if (scene === 0) {
        viewports.delete(uiNodeId);
        return;
      }
      if (!scenes.has(scene)) return; // dead/unknown scene: silent no-op
      viewports.set(uiNodeId, scene);
    },

    // -- test/debug ------------------------------------------------------------------------------
    __serialize: serialize,
    __host: "sim3d",
  };

  return {
    ops,
    /** Direct (mutable) view of a scene's retained state — the test probe.
     *  Throws on unknown/destroyed scenes: worldOf is not an op, and a test
     *  poking a dead scene is a bug worth hearing about. */
    worldOf(scene: number): SimScene {
      const sc = scenes.get(scene);
      if (!sc) throw new Error(`scene3d-sim: worldOf(${scene}): unknown scene`);
      return sc;
    },
  };
}
