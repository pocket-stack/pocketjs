// playset/scene3d/client.ts — the guest-side retained mirror over Scene3dOps.
//
// Port affordance: a SceneNode carries mutable `position` / `quaternion` /
// `scale` value objects (playset/math, three-compatible), so GameBlocks-style
// model controllers port verbatim: `node.position.copy(p)`,
// `node.quaternion.setFromRotationMatrix(m)`. Nothing crosses the FFI when
// you mutate — `scene.flush()` once per frame diffs every node against its
// last-sent pose and issues ONE batched writePoses op (Law 1: state lives
// guest-side, writes are batched intent).
//
// Degradation: constructed with no ops (host has no 3D), the whole client is
// a pure-state mirror — factories, controllers and flush() all run, nothing
// is emitted. Games stay headless-testable on hosts without a 3D core.

import { Vector3 } from "../math/vector3.ts";
import { Quaternion } from "../math/quaternion.ts";
import { Matrix4 } from "../math/matrix4.ts";
import {
  detectScene3d,
  MAT,
  POSE_STRIDE,
  SPRITE_STRIDE,
  BEAM_STRIDE,
  type Scene3dOps,
} from "./ops.ts";

export { MAT } from "./ops.ts";

const NO_TINT = 0xffffffff;

/** A node in the retained transform hierarchy (three Object3D/Group analog). */
export class SceneNode {
  readonly position = new Vector3();
  readonly quaternion = new Quaternion();
  readonly scale = new Vector3(1, 1, 1);

  /** @internal */ readonly __id: number;
  /** @internal */ __last: Float64Array | null = null; // 10 floats; null = never sent
  /** @internal */ __static = false; // settled scenery: flush() skips the diff
  private __visible = true;
  private __dead = false;

  constructor(
    private readonly scene: Scene3D,
    id: number,
    public parent: SceneNode | null,
  ) {
    this.__id = id;
  }

  get visible(): boolean {
    return this.__visible;
  }

  set visible(on: boolean) {
    if (this.__visible === on) return;
    this.__visible = on;
    this.scene.__ops?.nodeSetVisible(this.__id, on ? 1 : 0);
  }

  /** Reparent `child` under this node (three `group.add(child)` shape). */
  add(child: SceneNode): this {
    if (child.parent === this) return this;
    child.parent = this;
    this.scene.__ops?.nodeSetParent(child.__id, this.__id);
    return this;
  }

  /** Attach geometry+material (handles from Scene3D geometry/material helpers). */
  setMesh(geomId: number, matId: number): this {
    this.scene.__ops?.meshSet(this.__id, geomId, matId);
    return this;
  }

  /** Per-instance ABGR tint; call with no args to clear. */
  setTint(color: number = NO_TINT): this {
    this.scene.__ops?.nodeSetTint(this.__id, color >>> 0);
    return this;
  }

  /** Destroy this node and its subtree (mirrors are dropped on flush). */
  destroy(): void {
    if (this.__dead) return;
    this.__dead = true;
    this.scene.__removeNode(this);
    this.scene.__ops?.nodeDestroy(this.__id);
  }

  /** @internal */
  get __alive(): boolean {
    return !this.__dead;
  }
}

/** The scene camera — a pose plus lens; flushed with the node batch. */
export class Camera3D {
  readonly position = new Vector3(0, 0, 10);
  readonly quaternion = new Quaternion();
  fovY = (60 * Math.PI) / 180;
  znear = 0.1;
  zfar = 1000;
  /** Viewport aspect for guest-side ray math (PSP screen by default). The
   *  host renders with the bound node's real rect; this only feeds
   *  unprojection helpers like rayFromNdc. */
  aspect = 480 / 272;
  /** @internal */ __last: Float64Array | null = null;

  private static readonly _m = new Matrix4();

  /** Aim the camera at a world point (+Y-up look-at, three semantics). */
  lookAt(target: Vector3): this {
    Camera3D._m.lookAt(this.position, target, Camera3D._up);
    this.quaternion.setFromRotationMatrix(Camera3D._m);
    return this;
  }

  /** World-space ray direction through an NDC point (crosshair picking —
   *  the guest-side replacement for Raycaster.setFromCamera). */
  rayFromNdc(ndcX: number, ndcY: number, target = new Vector3()): Vector3 {
    const halfTan = Math.tan(this.fovY / 2);
    return target
      .set(ndcX * halfTan * this.aspect, ndcY * halfTan, -1)
      .applyQuaternion(this.quaternion)
      .normalize();
  }

  private static readonly _up = new Vector3(0, 1, 0);
}

/** A fixed-capacity billboard pool. Refill `pos`/`colors` then set `count`. */
export class SpritePool {
  readonly buf: Float32Array;
  readonly colors: Uint32Array;
  count = 0;

  constructor(
    private readonly scene: Scene3D,
    /** @internal */ readonly __id: number,
    readonly capacity: number,
    stride: number,
  ) {
    this.buf = new Float32Array(capacity * stride);
    this.colors = new Uint32Array(capacity);
  }

  /** @internal */
  __flush(): void {
    const ops = this.scene.__ops;
    if (!ops) return;
    if (this.__id < 0) return;
    // Pools are replace-per-frame by contract; skip only when empty twice.
    if (this.count === 0 && this.__wasEmpty) return;
    this.__wasEmpty = this.count === 0;
    if (this instanceof BeamPool) ops.writeBeams(this.__id, this.buf, this.colors, this.count);
    else ops.writeSprites(this.__id, this.buf, this.colors, this.count);
  }

  private __wasEmpty = false;
}

export class BeamPool extends SpritePool {}

/**
 * The retained scene root. One Scene3D per <Viewport3D>. All handle caches
 * (geometry, material) are per-scene-client but host handles are global —
 * two Scene3D instances sharing one host share dedup'd geoms transparently.
 */
export class Scene3D {
  /** @internal — null when the host has no 3D (pure-mirror mode). */
  readonly __ops: Scene3dOps | null;
  /** @internal */ readonly __scene: number;
  readonly camera = new Camera3D();

  private readonly nodes: SceneNode[] = [];
  /**
   * The nodes `flush()` actually walks. Settled scenery leaves this list, so a
   * 550-node track costs the differ ~20 visits a frame instead of 550 — which
   * on a 333 MHz interpreter is the difference between 5ms and 0.2ms of pure
   * bookkeeping. Rebuilt by markStatic(); new nodes join it on creation.
   */
  private dynamic: SceneNode[] = [];
  private readonly matCache = new Map<string, number>();
  private readonly geomCache = new Map<string, number>();
  private readonly pools: SpritePool[] = [];
  private poseBuf = new Float32Array(64 * POSE_STRIDE);
  /** Set by markStatic; cleared once every static node has been flushed once. */
  private staticPending = false;
  private nextLocalId = 1; // pure-mirror mode id spring

  constructor(injected?: Scene3dOps | null) {
    this.__ops = injected === undefined ? detectScene3d() : injected;
    this.__scene = this.__ops ? this.__ops.sceneCreate() : 0;
  }

  // -- nodes -----------------------------------------------------------------

  node(parent?: SceneNode): SceneNode {
    const pid = parent ? parent.__id : 0;
    const id = this.__ops ? this.__ops.nodeCreate(this.__scene, pid) : this.nextLocalId++;
    const n = new SceneNode(this, id, parent ?? null);
    this.nodes.push(n);
    this.dynamic.push(n);
    return n;
  }

  /** Node with a mesh attached — the `new Mesh(geo, mat)` + `add` shorthand. */
  mesh(geomId: number, matId: number, parent?: SceneNode): SceneNode {
    return this.node(parent).setMesh(geomId, matId);
  }

  /** Nodes the per-frame flush still walks (diagnostics; see markStatic). */
  get dynamicCount(): number {
    return this.dynamic.length;
  }

  /** Every node this scene has ever created and not destroyed. */
  get nodeCount(): number {
    return this.nodes.length;
  }

  /** @internal */
  __removeNode(n: SceneNode): void {
    const i = this.nodes.indexOf(n);
    if (i >= 0) this.nodes.splice(i, 1);
    const d = this.dynamic.indexOf(n);
    if (d >= 0) this.dynamic.splice(d, 1);
  }

  // -- geometry (cached by params — factories can re-request freely) ----------

  box(hx: number, hy: number, hz: number): number {
    return this.geom(`b|${hx}|${hy}|${hz}`, (o) => o.geomBox(hx, hy, hz));
  }
  sphere(radius: number, segments = 12): number {
    return this.geom(`s|${radius}|${segments}`, (o) => o.geomSphere(radius, segments));
  }
  cylinder(rTop: number, rBottom: number, height: number, segments = 12): number {
    return this.geom(`c|${rTop}|${rBottom}|${height}|${segments}`, (o) =>
      o.geomCylinder(rTop, rBottom, height, segments),
    );
  }
  cone(radius: number, height: number, segments = 12): number {
    return this.geom(`k|${radius}|${height}|${segments}`, (o) => o.geomCone(radius, height, segments));
  }
  plane(w: number, d: number): number {
    return this.geom(`p|${w}|${d}`, (o) => o.geomPlane(w, d));
  }
  torus(radius: number, tube: number, segments = 16, tubeSegments = 8): number {
    return this.geom(`t|${radius}|${tube}|${segments}|${tubeSegments}`, (o) =>
      o.geomTorus(radius, tube, segments, tubeSegments),
    );
  }
  /** Uncached (buffers are unique by construction). */
  meshGeom(positions: Float32Array, indices: Uint32Array, colors: Float32Array | null): number {
    return this.__ops ? this.__ops.geomMesh(positions, indices, colors) : this.nextLocalId++;
  }
  heightfield(
    w: number,
    d: number,
    cols: number,
    rows: number,
    heights: Float32Array,
    colors: Float32Array | null,
  ): number {
    return this.__ops
      ? this.__ops.geomHeightfield(w, d, cols, rows, heights, colors)
      : this.nextLocalId++;
  }

  private geom(key: string, make: (o: Scene3dOps) => number): number {
    const hit = this.geomCache.get(key);
    if (hit !== undefined) return hit;
    const id = this.__ops ? make(this.__ops) : this.nextLocalId++;
    this.geomCache.set(key, id);
    return id;
  }

  // -- materials ---------------------------------------------------------------

  material(color: number, flags = 0): number {
    const key = `${color >>> 0}|${flags}`;
    const hit = this.matCache.get(key);
    if (hit !== undefined) return hit;
    const id = this.__ops ? this.__ops.material(color >>> 0, flags) : this.nextLocalId++;
    this.matCache.set(key, id);
    return id;
  }

  // -- environment ----------------------------------------------------------------

  sun(dir: Vector3, color: number): void {
    this.__ops?.sun(this.__scene, dir.x, dir.y, dir.z, color >>> 0);
  }
  ambient(skyColor: number, groundColor: number): void {
    this.__ops?.ambient(this.__scene, skyColor >>> 0, groundColor >>> 0);
  }
  fog(color: number, near: number, far: number): void {
    this.__ops?.fog(this.__scene, color >>> 0, near, far);
  }
  sky(zenithColor: number, horizonColor: number): void {
    this.__ops?.sky(this.__scene, zenithColor >>> 0, horizonColor >>> 0);
  }

  // -- pools --------------------------------------------------------------------------

  spritePool(capacity: number, matId: number): SpritePool {
    const id = this.__ops ? this.__ops.spritePool(this.__scene, capacity, matId) : -1;
    const p = new SpritePool(this, id, capacity, SPRITE_STRIDE);
    this.pools.push(p);
    return p;
  }
  beamPool(capacity: number, matId: number): BeamPool {
    const id = this.__ops ? this.__ops.beamPool(this.__scene, capacity, matId) : -1;
    const p = new BeamPool(this, id, capacity, BEAM_STRIDE);
    this.pools.push(p);
    return p;
  }

  /** An additive unlit material — the pool default (glows, tracers). */
  additiveMaterial(color: number): number {
    return this.material(color, MAT.unlit | MAT.additive);
  }

  /**
   * Declare `root` and all its current descendants — or, with no argument,
   * every node created so far — settled scenery: after each node's next
   * flush the per-frame differ skips it entirely. Pose writes to a static
   * node never reach the host, so mark only what the sim will never
   * animate (environments, track furniture). Nodes created later are
   * unaffected.
   */
  /**
   * Freeze `root`'s subtree (or the whole scene) — a promise that none of
   * these transforms will change again, which lets the host merge scenery that
   * shares geometry and material into far fewer draw calls.
   *
   * STRICTLY STRONGER THAN `markStatic`, which only says the GUEST stops
   * diffing: a car driven by the native sim is static in that sense and must
   * NOT be frozen, or it would bake in place. Freezing implies markStatic.
   *
   * Ported environment factories call this on their own scenery, so a game
   * built on them inherits the batching without knowing it exists.
   */
  freeze(root?: SceneNode): void {
    this.markStatic(root);
    const ops = this.__ops;
    if (!ops?.freeze) return;
    const ids: number[] = [];
    for (const n of this.nodes) {
      if (!n.__alive) continue;
      if (root && !isDescendantOf(n, root)) continue;
      ids.push(n.__id);
    }
    if (ids.length > 0) ops.freeze(Int32Array.from(ids), ids.length);
  }

  markStatic(root?: SceneNode): void {
    this.staticPending = true;
    if (!root) {
      for (const n of this.nodes) n.__static = true;
      return;
    }
    root.__static = true;
    for (const n of this.nodes) {
      for (let p = n.parent; p; p = p.parent) {
        if (p === root) {
          n.__static = true;
          break;
        }
      }
    }
  }

  // -- frame flush -----------------------------------------------------------------------

  /**
   * Push every changed pose (+ camera) and pool in ONE batch. Call once per
   * frame after the sim step — playset's game loop does this for you.
   */
  flush(): void {
    const ops = this.__ops;
    if (!ops) return;
    let count = 0;
    const need = (this.nodes.length + 1) * POSE_STRIDE;
    if (this.poseBuf.length < need) {
      this.poseBuf = new Float32Array(Math.ceil(need * 1.5));
    }
    for (const n of this.dynamic) {
      if (!n.__alive) continue;
      // A static node still needs its FIRST pose pushed; after that it drops
      // out of `dynamic` entirely (see settle() below).
      if (n.__static && n.__last !== null) continue;
      if (!poseDirty(n.__last, n.position, n.quaternion, n.scale)) continue;
      n.__last ??= new Float64Array(10);
      writePose(n.__last, n.position, n.quaternion, n.scale);
      const o = count * POSE_STRIDE;
      this.poseBuf[o] = n.__id;
      this.poseBuf[o + 1] = n.position.x;
      this.poseBuf[o + 2] = n.position.y;
      this.poseBuf[o + 3] = n.position.z;
      this.poseBuf[o + 4] = n.quaternion.x;
      this.poseBuf[o + 5] = n.quaternion.y;
      this.poseBuf[o + 6] = n.quaternion.z;
      this.poseBuf[o + 7] = n.quaternion.w;
      this.poseBuf[o + 8] = n.scale.x;
      this.poseBuf[o + 9] = n.scale.y;
      this.poseBuf[o + 10] = n.scale.z;
      count++;
    }
    if (count > 0) ops.writePoses(this.poseBuf, count);
    // Drop settled scenery from the walk list now that its pose has landed.
    if (this.staticPending) {
      this.dynamic = this.dynamic.filter((n) => !(n.__static && n.__last !== null));
      this.staticPending = this.dynamic.some((n) => n.__static);
    }
    const cam = this.camera;
    if (poseDirty(cam.__last, cam.position, cam.quaternion, LENS.set(cam.fovY, cam.znear, cam.zfar))) {
      cam.__last ??= new Float64Array(10);
      writePose(cam.__last, cam.position, cam.quaternion, LENS);
      ops.camera(
        this.__scene,
        cam.position.x, cam.position.y, cam.position.z,
        cam.quaternion.x, cam.quaternion.y, cam.quaternion.z, cam.quaternion.w,
        cam.fovY, cam.znear, cam.zfar,
      );
    }
    for (const p of this.pools) p.__flush();
  }

  /** Bind to a laid-out `ui` node (Viewport3D does this for you). */
  bindViewport(uiNodeId: number): void {
    this.__ops?.bindViewport(uiNodeId, this.__scene);
  }
  unbindViewport(uiNodeId: number): void {
    this.__ops?.bindViewport(uiNodeId, 0);
  }

  destroy(): void {
    this.__ops?.sceneDestroy(this.__scene);
    this.nodes.length = 0;
    this.dynamic.length = 0;
    this.pools.length = 0;
  }
}

/** `node` is `root` or sits under it. */
function isDescendantOf(node: SceneNode, root: SceneNode): boolean {
  if (node === root) return true;
  for (let p = node.parent; p; p = p.parent) {
    if (p === root) return true;
  }
  return false;
}

// Scratch Vector3 that carries (fovY, znear, zfar) through the pose differ.
const LENS = new Vector3();

function poseDirty(last: Float64Array | null, p: Vector3, q: Quaternion, s: Vector3): boolean {
  if (!last) return true;
  return (
    last[0] !== p.x || last[1] !== p.y || last[2] !== p.z ||
    last[3] !== q.x || last[4] !== q.y || last[5] !== q.z || last[6] !== q.w ||
    last[7] !== s.x || last[8] !== s.y || last[9] !== s.z
  );
}

function writePose(last: Float64Array, p: Vector3, q: Quaternion, s: Vector3): void {
  last[0] = p.x; last[1] = p.y; last[2] = p.z;
  last[3] = q.x; last[4] = q.y; last[5] = q.z; last[6] = q.w;
  last[7] = s.x; last[8] = s.y; last[9] = s.z;
}
