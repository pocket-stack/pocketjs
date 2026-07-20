// playset/scene3d/ops.ts — the `scene3d` surface contract (RUNTIMES.md §3).
//
// scene3d is a CLOSED PRESENTATION VOCABULARY for real-time 3D mini-games —
// the 3D sibling of the `ui` surface. It is deliberately NOT a universal
// scene graph and NOT Three.js-compatible: every verb here is expressible on
// a fixed-function GPU (PSP GE) as well as on wgpu/Metal, and every verb is
// a WRITE. There are no reads: picking, collision and visibility queries are
// the guest's job (playset ships deterministic TS colliders), so a frame's
// pixels are a pure function of the op stream — no FFI round-trips on hot
// paths, no hidden inputs, and the whole surface replays under host-sim.
//
// Hosts install this namespace as `globalThis.s3` (native) or inject it
// (web/wasm/test), exactly like the `ui` surface in src/host.ts. Hosts
// without 3D support simply omit it — <Viewport3D> degrades to an empty
// laid-out box, the same graceful-absence contract as <Video>.
//
// Conventions (matching spec/spec.ts):
//   - Handles are positive i32 ids; 0 means "none".
//   - Colors are u32 ABGR (abgr() in spec/spec.ts; same byte order as `ui`).
//   - Right-handed, +Y up, -Z forward (camera looks down -Z), radians.
//   - Batched writes carry (Float32Array, count) — colors ride in a separate
//     Uint32Array, never bit-punned through f32 (NaN canonicalization).
//   - The vocabulary is APPEND-ONLY once a native core ships it: new verbs
//     get new names; existing signatures never change.
//
// Lighting model (honest to the GE): one directional sun + two-tone
// hemisphere ambient, evaluated PER VERTEX. Materials are flat or
// vertex-colored — no textures in v1 (CLUT8 textured materials are a
// reserved follow-up verb: `materialTextured`). No shadow maps ever; use
// blob decals (playset world/BlobShadow).

/** Geometry kind ordinals — carried in serialized scenes and debug dumps. */
export const GEOM_KIND = {
  box: 0,
  sphere: 1,
  cylinder: 2,
  cone: 3,
  plane: 4,
  torus: 5,
  /** Arbitrary indexed triangle mesh (positions [+ optional vertex colors]). */
  mesh: 6,
  /** Regular-grid heightfield — the terrain workhorse (LOD-friendly, and the
   *  natural shape for a future GE strip renderer + heightfield raycasts). */
  heightfield: 7,
} as const;

/** Material flag bits (combine with |). Default (0) = lit, opaque, single-sided. */
export const MAT = {
  /** Per-vertex colors modulate the base color (terrain, painted meshes). */
  vertexColors: 1 << 0,
  /** Skip lighting: albedo = color (UI-in-world, neon, emissive fakes). */
  unlit: 1 << 1,
  /** Additive blending, depth-write off (glows, flames, tracers). */
  additive: 1 << 2,
  /** Alpha blending, depth-write off (clouds, ghosts). Color's A is the alpha. */
  transparent: 1 << 3,
  /** Draw both faces (decals, ribbons, foliage cards). */
  doubleSided: 1 << 4,
} as const;

/** writePoses stride: [id, px,py,pz, qx,qy,qz,qw, sx,sy,sz] per entry. */
export const POSE_STRIDE = 11;
/** writeSprites stride (floats): [x,y,z, size] per entry; colors separate. */
export const SPRITE_STRIDE = 4;
/** writeBeams stride (floats): [ax,ay,az, bx,by,bz, width] per entry. */
export const BEAM_STRIDE = 7;

/**
 * The `s3.*` op surface. Every op is SYNCHRONOUS and write-only (queries
 * would make pixels depend on host state; see header). Guests keep mirrors.
 */
export interface Scene3dOps {
  // -- scenes ---------------------------------------------------------------
  /** A scene owns nodes, pools, lights, fog and a camera. → scene handle. */
  sceneCreate(): number;
  /** Frees the scene and everything in it (nodes, pools; geoms/materials are
   *  scene-independent and survive). */
  sceneDestroy(scene: number): void;

  // -- node tree (transform hierarchy) --------------------------------------
  /** New node under `parentOr0` (0 = scene root). Identity pose. → node id,
   *  or 0 when the scene or parent is dead/unknown (no orphans are minted). */
  nodeCreate(scene: number, parentOr0: number): number;
  /** Destroys the node and its whole subtree. Handles are never reused. */
  nodeDestroy(id: number): void;
  /** Reparent (keeps LOCAL pose, like scene-graph adoption everywhere).
   *  Adopting under self/descendant or across scenes is a silent no-op. */
  nodeSetParent(id: number, parentOr0: number): void;
  /** Hidden nodes hide their subtree. */
  nodeSetVisible(id: number, on: number): void;
  /** Cold-path single-node local pose write (unit quaternion). */
  nodeSetPose(
    id: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
  ): void;
  /** Cold-path non-uniform local scale. */
  nodeSetScale(id: number, sx: number, sy: number, sz: number): void;
  /** HOT PATH — one call per frame flushes every moved node:
   *  `buf` holds `count` entries of POSE_STRIDE floats (id rides as f32;
   *  exact for ids < 2^24). Unknown ids are ignored (a destroy may race a
   *  staged write inside one guest turn — last write wins, no throw). */
  writePoses(buf: Float32Array, count: number): void;

  // -- geometry (immutable once created; scenes share them) -----------------
  geomBox(hx: number, hy: number, hz: number): number;
  geomSphere(radius: number, segments: number): number;
  /** Cylinder along +Y; radiusTop=0 degenerates to a cone (three parity). */
  geomCylinder(radiusTop: number, radiusBottom: number, height: number, segments: number): number;
  geomCone(radius: number, height: number, segments: number): number;
  /** Plane in XZ (a ground tile), facing +Y, w×d. */
  geomPlane(w: number, d: number): number;
  geomTorus(radius: number, tube: number, segments: number, tubeSegments: number): number;
  /** Indexed triangle mesh. `colors` (RGB f32 triplets, one per vertex) may be
   *  null. Normals are computed by the host (flat or smooth is a host
   *  quality decision; sim host stores positions verbatim). */
  geomMesh(
    positions: Float32Array,
    indices: Uint32Array,
    colors: Float32Array | null,
  ): number;
  /** cols×rows vertex grid over w×d in XZ, `heights` row-major (rows of
   *  cols), optional per-vertex RGB `colors`. The heightfield the terrain
   *  factory bakes; also the shape future native raycast verbs understand. */
  geomHeightfield(
    w: number, d: number,
    cols: number, rows: number,
    heights: Float32Array,
    colors: Float32Array | null,
  ): number;
  /** Frees a geometry (nodes still referencing it draw nothing). */
  geomFree(id: number): void;

  // -- materials -------------------------------------------------------------
  /** color: u32 ABGR; flags: MAT bits. → material handle. */
  material(color: number, flags: number): number;
  materialSetColor(id: number, color: number): void;
  materialFree(id: number): void;

  // -- mesh attachment --------------------------------------------------------
  /** Attach geometry+material to a node (one mesh per node; geom 0 clears
   *  the whole attachment, material included — bare nodes are groups). */
  meshSet(nodeId: number, geomId: number, matId: number): void;
  /** Per-instance tint multiplied over the material color (u32 ABGR;
   *  0xffffffff = none). Health flashes, team colors, fade-outs. */
  nodeSetTint(nodeId: number, color: number): void;

  // -- environment (per scene) -------------------------------------------------
  /** Directional sun: direction the light TRAVELS (normalized by host). */
  sun(scene: number, dx: number, dy: number, dz: number, color: number): void;
  /** Two-tone hemisphere ambient (sky tint from above, ground from below). */
  ambient(scene: number, skyColor: number, groundColor: number): void;
  /** Linear fog; far <= near disables. Matches GE fog exactly. */
  fog(scene: number, color: number, near: number, far: number): void;
  /** Procedural gradient sky (zenith → horizon). */
  sky(scene: number, zenithColor: number, horizonColor: number): void;

  // -- camera (one per scene) ---------------------------------------------------
  camera(
    scene: number,
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    fovYRad: number, znear: number, zfar: number,
  ): void;

  // -- pooled billboards & ribbons (particles, tracers, trails) -----------------
  /** Fixed-capacity sprite pool drawn with `matId` (usually additive|unlit).
   *  → pool handle. */
  spritePool(scene: number, capacity: number, matId: number): number;
  /** HOT PATH — replaces the pool's live set each frame: `buf` holds `count`
   *  entries of SPRITE_STRIDE floats; `colors` one u32 ABGR per entry.
   *  count > capacity is clamped (host counts drops in debug builds). */
  writeSprites(pool: number, buf: Float32Array, colors: Uint32Array, count: number): void;
  /** Fixed-capacity view-aligned ribbon pool (beams/trails/tracers). */
  beamPool(scene: number, capacity: number, matId: number): number;
  writeBeams(pool: number, buf: Float32Array, colors: Uint32Array, count: number): void;
  poolFree(pool: number): void;

  // -- viewport binding -----------------------------------------------------------
  /** Bind a scene to a `ui` view node: the host renders the scene into that
   *  node's laid-out rect each frame (the <Video>/videoBind precedent —
   *  DRAW_OP wiring lands with the native cores). scene 0 unbinds; a ui node
   *  holds at most one scene (rebind moves); dead scenes are a no-op. */
  bindViewport(uiNodeId: number, scene: number): void;

  // -- test/debug (sim host only; native hosts omit) --------------------------------
  /** Canonical JSON of the whole retained state of `scene` (sorted keys,
   *  stable id order) — the golden-trace probe for headless tests. */
  __serialize?(scene: number): string;
  /** Host self-identification (mirrors HostOps.__host). */
  __host?: string;
}

/**
 * Resolve the scene3d host: injected ops win; otherwise `globalThis.s3`
 * (native hosts install it before the bundle evals, like `ui`). Returns
 * null when the host has no 3D — callers degrade (Viewport3D renders an
 * empty box; playset visual factories become no-ops that keep pure state).
 */
export function detectScene3d(injected?: Scene3dOps): Scene3dOps | null {
  if (injected) return injected;
  const native = (globalThis as { s3?: Scene3dOps }).s3;
  return native ?? null;
}
