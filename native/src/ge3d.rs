//! SCENE_QUAD -> sceGu: composites a bound scene3d scene (the shared
//! pocket-scene3d Store) into a DrawList rect — the PSP counterpart of
//! pocket-scene3d's wgpu SceneRenderer, pass for pass: (1) gradient sky,
//! (2) opaque vertex-lit meshes, (3) blended meshes back-to-front +
//! sprite/beam pools. Like ge.rs, this module never opens or kicks display
//! lists; it enqueues into the list the frame loop owns.
//!
//! Geometry buffers are baked ONCE at geom creation (`bake_geom`) into
//! GE-ready [color][normal][position] f32 vertices + u16 indices, dcache-
//! written-back at bake — ids are never reused, so baked entries never go
//! stale. Only per-frame transients (sky strip, pool quads) go through the
//! 2D backend's bump pool.
//!
//! Lighting is GE hardware lighting, one approximation removed from the
//! desktop shader: the per-vertex hemisphere term
//! `mix(ground, sky, n.y*0.5+0.5)` becomes the GE model ambient set to the
//! AVERAGE of the hemisphere colors (the GE has no hemisphere light). Sun
//! stays exact: one directional light, `max(dot(n, -sunDir), 0)`. Material
//! color x tint modulates through the light colors (ColorMaterial routes the
//! baked per-vertex color into the material ambient+diffuse, so
//! `vertexColor x matColor x (ambient + sun*ndotl)` matches the desktop
//! formula); unlit materials keep the lighting unit on with zero lights so
//! the same path yields `vertexColor x matColor` exactly.
//!
//! Fog is sceGuFog linear fog (same near/far semantics as the desktop
//! shader); additive meshes fog toward BLACK (they fade out with distance,
//! never toward fog color — desktop parity). Pools are unlit and unfogged;
//! their radial soft-falloff fragment term becomes a 32x32 glow texture
//! built once at first use.
//!
//! The mesh walk frustum-culls against a per-geom bounding sphere before it
//! enqueues anything (see `composite`) — the same test the desktop renderer
//! runs, and the single biggest lever on this surface: rally goes from 707
//! submissions / 23,585 triangles a frame to ~66 / ~6,400.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use core::ffi::c_void;

use glam::{Mat4, Quat, Vec3};
use psp::sys::{
    self, BlendFactor, BlendOp, ClearBuffer, DepthFunc, FrontFaceDirection, GuPrimitive, GuState,
    GuTexWrapMode, LightComponent, LightType, MipmapLevel, ScePspFVector3, TextureColorComponent,
    TextureEffect, TextureFilter, TexturePixelFormat, VertexType,
};
use psp::{SCREEN_HEIGHT, SCREEN_WIDTH};
use pocket_scene3d::{mat_flags, PoolKind, Store, BEAM_STRIDE, SPRITE_STRIDE};

use crate::ge::pool_alloc;

// ---------------------------------------------------------------------------
// Vertex formats (GE fixed component order: [uv][color][normal][pos])
// ---------------------------------------------------------------------------

/// COLOR_8888 | NORMAL_32BITF | VERTEX_32BITF — 28-byte stride. Baked once
/// per geom; f32 positions, so the i16 ÷32768 scale gotcha does not apply.
#[repr(C)]
#[derive(Copy, Clone)]
struct MeshVert {
    color: u32,
    nx: f32,
    ny: f32,
    nz: f32,
    x: f32,
    y: f32,
    z: f32,
}

/// TEXTURE_32BITF | COLOR_8888 | VERTEX_32BITF — 24-byte stride (pool quads).
#[repr(C)]
#[derive(Copy, Clone)]
struct PoolVert {
    u: f32,
    v: f32,
    color: u32,
    x: f32,
    y: f32,
    z: f32,
}

/// COLOR_8888 | VERTEX_16BIT | TRANSFORM_2D (sky strip rows) — ge.rs VertC.
#[repr(C)]
#[derive(Copy, Clone)]
struct SkyVert {
    color: u32,
    x: i16,
    y: i16,
    z: i16,
    _pad: i16,
}

const VTYPE_MESH: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits()
        | VertexType::NORMAL_32BITF.bits()
        | VertexType::VERTEX_32BITF.bits()
        | VertexType::INDEX_16BIT.bits()
        | VertexType::TRANSFORM_3D.bits(),
);
const VTYPE_POOL: VertexType = VertexType::from_bits_truncate(
    VertexType::TEXTURE_32BITF.bits()
        | VertexType::COLOR_8888.bits()
        | VertexType::VERTEX_32BITF.bits()
        | VertexType::TRANSFORM_3D.bits(),
);
const VTYPE_SKY: VertexType = VertexType::from_bits_truncate(
    VertexType::COLOR_8888.bits() | VertexType::VERTEX_16BIT.bits() | VertexType::TRANSFORM_2D.bits(),
);

/// GE PRIM packs the vertex count into 16 bits (see ge.rs MAX_PRIM_VERTS);
/// divisible by 3 preserves triangle granularity for indexed draws.
const MAX_PRIM_IDX: usize = 65532;

// ---------------------------------------------------------------------------
// Baked geometry registry (ids never reused — entries never invalidate)
// ---------------------------------------------------------------------------

struct BakedGeom {
    verts: Vec<MeshVert>,
    indices: Vec<u16>,
    /// Local-space bounding sphere (AABB midpoint + the max vertex distance
    /// from it) — the frustum-cull bound, computed here because bake already
    /// walks every vertex.
    bound_center: Vec3,
    bound_radius: f32,
}

static mut GEOMS: Option<BTreeMap<i32, BakedGeom>> = None;

unsafe fn geoms() -> &'static mut BTreeMap<i32, BakedGeom> {
    if GEOMS.is_none() {
        GEOMS = Some(BTreeMap::new());
    }
    GEOMS.as_mut().unwrap()
}

#[inline]
fn rgb_byte(f: f32) -> u32 {
    (f.clamp(0.0, 1.0) * 255.0 + 0.5) as u32
}

/// Build the GE buffers for a freshly created geom and write them back for
/// the GE. Meshes past u16 index range draw nothing (none of the closed
/// vocabulary's tessellations get there; a hostile geomMesh just goes empty).
pub unsafe fn bake_geom(id: i32, store: &Store) {
    let Some(mesh) = store.geom(id) else { return };
    if mesh.indices.is_empty() || mesh.positions.len() > u16::MAX as usize {
        return;
    }
    let mut verts = Vec::with_capacity(mesh.positions.len());
    let mut lo = Vec3::splat(f32::INFINITY);
    let mut hi = Vec3::splat(f32::NEG_INFINITY);
    for i in 0..mesh.positions.len() {
        let p = mesh.positions[i];
        let n = mesh.normals[i];
        lo = lo.min(Vec3::from_array(p));
        hi = hi.max(Vec3::from_array(p));
        // Per-vertex RGB bakes into the color channel (alpha ff); material
        // color x tint modulates at draw time through the light colors.
        let color = match &mesh.colors {
            Some(c) => {
                0xff00_0000 | (rgb_byte(c[i][2]) << 16) | (rgb_byte(c[i][1]) << 8) | rgb_byte(c[i][0])
            }
            None => 0xffff_ffff,
        };
        verts.push(MeshVert { color, nx: n[0], ny: n[1], nz: n[2], x: p[0], y: p[1], z: p[2] });
    }
    // Sphere about the AABB midpoint: tighter than an origin-centred one for
    // the off-origin tessellations (cylinder caps, heightfield strips), and
    // strictly conservative — every vertex is inside it by construction.
    let bound_center = (lo + hi) * 0.5;
    let mut r2 = 0.0f32;
    for p in &mesh.positions {
        r2 = r2.max((Vec3::from_array(*p) - bound_center).length_squared());
    }
    let bound_radius = libm::sqrtf(r2);
    let indices: Vec<u16> = mesh.indices.iter().map(|&i| i as u16).collect();
    sys::sceKernelDcacheWritebackRange(
        verts.as_ptr() as *const c_void,
        (verts.len() * core::mem::size_of::<MeshVert>()) as u32,
    );
    sys::sceKernelDcacheWritebackRange(indices.as_ptr() as *const c_void, (indices.len() * 2) as u32);
    geoms().insert(id, BakedGeom { verts, indices, bound_center, bound_radius });
}

pub unsafe fn free_geom(id: i32) {
    geoms().remove(&id);
}

// ---------------------------------------------------------------------------
// glow texture (pool quads' radial falloff, desktop fs_pool's 1 - d^2)
// ---------------------------------------------------------------------------

const GLOW_DIM: usize = 32;

static mut GLOW: Option<Vec<u32>> = None;

unsafe fn glow_texture() -> *const u32 {
    if GLOW.is_none() {
        let mut px = Vec::with_capacity(GLOW_DIM * GLOW_DIM);
        for y in 0..GLOW_DIM {
            for x in 0..GLOW_DIM {
                let dx = (x as f32 + 0.5) / GLOW_DIM as f32 * 2.0 - 1.0;
                let dy = (y as f32 + 0.5) / GLOW_DIM as f32 * 2.0 - 1.0;
                let soft = (1.0 - (dx * dx + dy * dy)).clamp(0.0, 1.0);
                px.push((rgb_byte(soft) << 24) | 0x00ff_ffff);
            }
        }
        sys::sceKernelDcacheWritebackRange(px.as_ptr() as *const c_void, (px.len() * 4) as u32);
        GLOW = Some(px);
    }
    GLOW.as_ref().unwrap().as_ptr()
}

// ---------------------------------------------------------------------------
// color helpers (u32 ABGR byte math, desktop renderer parity)
// ---------------------------------------------------------------------------

/// Per-channel ABGR x ABGR.
fn abgr_mul(a: u32, b: u32) -> u32 {
    let ch = |s: u32| ((a >> s & 0xff) * (b >> s & 0xff) / 255) << s;
    ch(0) | ch(8) | ch(16) | ch(24)
}

/// Per-channel average — the hemisphere-ambient approximation (module docs).
fn abgr_avg(a: u32, b: u32) -> u32 {
    let ch = |s: u32| (((a >> s & 0xff) + (b >> s & 0xff)) / 2) << s;
    ch(0) | ch(8) | ch(16) | ch(24)
}

fn pack_rgb(r: f32, g: f32, b: f32) -> u32 {
    0xff00_0000 | (rgb_byte(b) << 16) | (rgb_byte(g) << 8) | rgb_byte(r)
}

#[inline]
fn to_psp_matrix(m: Mat4) -> sys::ScePspFMatrix4 {
    // Both are column-major [x_axis, y_axis, z_axis, w_axis] of vec4.
    unsafe { core::mem::transmute::<[f32; 16], sys::ScePspFMatrix4>(m.to_cols_array()) }
}

// ---------------------------------------------------------------------------
// the composite pass
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Blend {
    Opaque,
    Alpha,
    Additive,
}

struct Draw {
    world: Mat4,
    /// Resolved at collect time — the geom registry is not touched between
    /// collect and emit, and BakedGeom entries are never removed mid-frame
    /// (geomFree only runs from the JS turn), so the borrow stays live.
    baked: *const BakedGeom,
    /// Material color x per-node tint (u32 ABGR).
    color: u32,
    flags: u32,
    blend: Blend,
    /// View depth for back-to-front ordering of the blended set.
    depth: f32,
}

// ---------------------------------------------------------------------------
// Per-frame scratch [R]
//
// composite() ran with four fresh Vecs per frame (draws, the traversal stack,
// and partition_opaque's two rebuild buffers) and moved every element through
// them. rally walks 707 mesh nodes, so that is tens of KB of alloc/copy/free
// per frame on a CPU whose memory bus is already contended by the GE. These
// are the same buffers every frame, so retain them like GEOMS/GLOW: cleared,
// never freed. Single-threaded, and composite never nests, so one set is
// enough.
// ---------------------------------------------------------------------------

static mut DRAWS: Option<Vec<Draw>> = None;
static mut BLENDED: Option<Vec<Draw>> = None;
static mut STACK: Option<Vec<(i32, u32)>> = None;
static mut WORLDS: Option<Vec<Mat4>> = None;

/// Six frustum planes (a,b,c,d) with unit normals, inside = ax+by+cz+d >= 0.
struct Frustum {
    planes: [[f32; 4]; 6],
}

impl Frustum {
    /// Gribb-Hartmann extraction from `clip = proj * view`. `proj` here is the
    /// GL-style -1..1-depth projection composite feeds the GE, so near/far are
    /// `w + z` / `w - z` (a DirectX 0..1 projection would want `z` / `w - z` —
    /// that is the one line that differs from the desktop renderer's copy).
    fn from_clip(clip: Mat4) -> Frustum {
        let row = |i: usize| {
            [
                clip.x_axis[i],
                clip.y_axis[i],
                clip.z_axis[i],
                clip.w_axis[i],
            ]
        };
        let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
        let combine = |a: [f32; 4], b: [f32; 4], add: bool| {
            let s = if add { 1.0 } else { -1.0 };
            let mut p = [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
            // Unit-length normal so plane distance is metric and can be
            // compared against the sphere radius directly.
            let len = libm::sqrtf(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
            if len > 1e-20 {
                let inv = 1.0 / len;
                p[0] *= inv;
                p[1] *= inv;
                p[2] *= inv;
                p[3] *= inv;
            }
            p
        };
        Frustum {
            planes: [
                combine(r3, r0, true),  // left
                combine(r3, r0, false), // right
                combine(r3, r1, true),  // bottom
                combine(r3, r1, false), // top
                combine(r3, r2, true),  // near
                combine(r3, r2, false), // far
            ],
        }
    }

    /// True when the sphere is entirely outside at least one plane — i.e. it
    /// cannot contribute a pixel, so dropping the draw is pixel-exact.
    #[inline]
    fn rejects(&self, c: Vec3, r: f32) -> bool {
        for p in &self.planes {
            if p[0] * c.x + p[1] * c.y + p[2] * c.z + p[3] < -r {
                return true;
            }
        }
        false
    }
}

/// Composite `scene` into the DrawList rect. Enters with the 2D pass state
/// (blend on, texture off) and RETURNS with the same 2D-clean state, except
/// the scissor — the caller (ge.rs) re-applies its scissor stack.
pub unsafe fn composite(scene: i32, x: i32, y: i32, w: i32, h: i32) {
    let store = crate::scene3d::store();
    let Some(sc) = store.scene(scene) else { return };
    // Clamp to the screen (the core's CPU clip stage guarantees this already).
    let x0 = x.clamp(0, SCREEN_WIDTH as i32);
    let y0 = y.clamp(0, SCREEN_HEIGHT as i32);
    let x1 = (x + w).clamp(0, SCREEN_WIDTH as i32);
    let y1 = (y + h).clamp(0, SCREEN_HEIGHT as i32);
    let (rw, rh) = (x1 - x0, y1 - y0);
    if rw <= 0 || rh <= 0 {
        return;
    }

    let env = &sc.env;
    let cam = env.camera;
    let znear = cam.znear.max(1e-3);
    let zfar = cam.zfar.max(znear + 1e-3);
    let aspect = rw as f32 / rh as f32;
    let view = Mat4::from_rotation_translation(cam.q, cam.p).inverse();
    // GL-style -1..1 clip depth: what the GE consumes (pocket3d-gu parity).
    let proj = glam::camera::rh::proj::opengl::perspective(cam.fov_y, aspect, znear, zfar);
    let fwd = cam.q * Vec3::NEG_Z;

    // FRUSTUM CULL [R]: rally submits 707 meshes / 23,585 triangles per frame
    // spread over the whole circuit, of which the chase camera sees ~66 /
    // ~6,400 (measured through the desktop renderer, which runs the same store
    // and now the same test). Everything else was transformed, state-changed
    // and handed to the GE only to be clipped away — and at ~70k lit vertex
    // transforms the GE list was measured at ~30 ms, so this is the one cut
    // that lands on BOTH the CPU enqueue and the GE.
    //
    // The sphere test is CONSERVATIVE: bake_geom's sphere encloses every
    // vertex and the radius is scaled by the world matrix's longest basis
    // vector, so a rejected node provably contributes no pixel. VERIFIED, not
    // argued: 90 distinct rally frames captured through PPSSPP's software
    // renderer are byte-identical with and without this block.
    let frustum = Frustum::from_clip(proj * view);

    // -- collect draws (world transforms top-down, visibility pruned) --------
    let draws = draws_scratch();
    let blended = blended_scratch();
    let stack = stack_scratch();
    let worlds = worlds_scratch();
    draws.clear();
    blended.clear();
    stack.clear();
    // The stack carries a SLOT into `worlds` rather than a copy of the parent
    // matrix: rally hangs ~260 barrier posts off one group, which used to mean
    // 260 copies of the same 64-byte Mat4 pushed and popped. One write, N
    // reads. Slots are never recycled within a frame, so a parent's entry is
    // still live when the last of its children pops.
    worlds.clear();
    worlds.push(Mat4::IDENTITY); // slot 0 = scene root
    stack.extend(sc.root.iter().rev().map(|&id| (id, 0u32)));
    // Consecutive nodes overwhelmingly share a geom and a material (the 260
    // posts are one cylinder and one material), and both registries are
    // BTreeMaps — memoize the last hit instead of re-walking the tree.
    let mut last_geom: (i32, *const BakedGeom) = (0, core::ptr::null());
    while let Some((id, pslot)) = stack.pop() {
        let Some(node) = store.node(id) else { continue };
        if !node.visible {
            continue; // hidden nodes hide their subtree
        }
        let parent_world = worlds[pslot as usize];
        let world = parent_world * Mat4::from_scale_rotation_translation(node.s, node.q, node.p);
        if !node.children.is_empty() {
            let slot = worlds.len() as u32;
            worlds.push(world);
            for &c in node.children.iter().rev() {
                stack.push((c, slot));
            }
        }
        if node.geom == 0 || node.mat == 0 {
            continue; // bare group
        }
        if last_geom.0 != node.geom {
            let Some(baked) = geoms().get(&node.geom) else {
                continue; // dangling/degenerate: draws nothing
            };
            last_geom = (node.geom, baked as *const BakedGeom);
        }
        let baked = &*last_geom.1;
        // Cull HERE, not by skipping the subtree: a group node's own bounds
        // say nothing about where its children sit in this store.
        let center = world.transform_point3(baked.bound_center);
        let scale2 = world
            .x_axis
            .truncate()
            .length_squared()
            .max(world.y_axis.truncate().length_squared())
            .max(world.z_axis.truncate().length_squared());
        if frustum.rejects(center, baked.bound_radius * libm::sqrtf(scale2)) {
            continue;
        }
        let Some(mat) = store.material(node.mat) else { continue };
        let blend = if mat.flags & mat_flags::ADDITIVE != 0 {
            Blend::Additive
        } else if mat.flags & mat_flags::TRANSPARENT != 0 {
            Blend::Alpha
        } else {
            Blend::Opaque
        };
        let draw = Draw {
            world,
            baked: baked as *const BakedGeom,
            color: abgr_mul(mat.color, node.tint),
            flags: mat.flags,
            blend,
            depth: (world.w_axis.truncate() - cam.p).dot(fwd),
        };
        // Split at collect time — same result as the old collect-then-
        // partition, without moving every element through two fresh Vecs.
        if blend == Blend::Opaque {
            draws.push(draw);
        } else {
            blended.push(draw);
        }
    }
    // Opaques keep tree order; the blended set draws after, far -> near.
    let split = draws.len();
    draws.append(blended);
    draws[split..].sort_by(|a, b| b.depth.total_cmp(&a.depth));

    // -- rect viewport + depth clear ------------------------------------------
    sys::sceGuScissor(x0, y0, x1, y1);
    // Viewport center in the 4096 virtual space, against init_graphics'
    // fixed offset (2048 - screen/2): center the NDC box on the rect.
    let ox = 2048 - (SCREEN_WIDTH as i32) / 2;
    let oy = 2048 - (SCREEN_HEIGHT as i32) / 2;
    sys::sceGuViewport(ox + x0 + rw / 2, oy + y0 + rh / 2, rw, rh);
    // Clear depth only (color survives: the ui frame clear already ran, and
    // the sky/backdrop owns the rect's color). Inverted 16-bit depth: 0 = far.
    sys::sceGuClearDepth(0);
    sys::sceGuClear(ClearBuffer::DEPTH_BUFFER_BIT);

    // -- sky (before any 3D state; screen-space gouraud strip) ----------------
    sys::sceGuDisable(GuState::Blend);
    if let Some((zenith, horizon)) = env.sky {
        draw_sky(x0, y0, rw, rh, cam.q, cam.fov_y, zenith, horizon);
    }

    // -- 3D pass state ---------------------------------------------------------
    sys::sceGuSetMatrix(sys::MatrixMode::Projection, &to_psp_matrix(proj));
    sys::sceGuSetMatrix(sys::MatrixMode::View, &to_psp_matrix(view));
    sys::sceGuDepthRange(65535, 0);
    sys::sceGuDepthFunc(DepthFunc::GreaterOrEqual);
    sys::sceGuDepthMask(0); // depth writes on for opaques
    sys::sceGuEnable(GuState::DepthTest);
    sys::sceGuEnable(GuState::ClipPlanes);
    // Store meshes wind CCW-out (right-handed, +Y up); through the GL-style
    // projection + the GE's y-flipping viewport they arrive CCW in screen
    // space (VERIFIED against the desktop reference: CW here culls the
    // heightfield and shows closed meshes inside-out).
    sys::sceGuFrontFace(FrontFaceDirection::CounterClockwise);
    // Vertex color -> material ambient + diffuse; light colors then carry
    // the material x tint modulate (module docs).
    sys::sceGuColorMaterial(LightComponent::AMBIENT | LightComponent::DIFFUSE);
    sys::sceGuEnable(GuState::Lighting);
    let sun = match env.sun {
        Some((dir, color)) if dir != Vec3::ZERO => {
            // GE directional lights point TOWARD the light source.
            let to_light = ScePspFVector3 { x: -dir.x, y: -dir.y, z: -dir.z };
            sys::sceGuLight(0, LightType::Directional, LightComponent::DIFFUSE, &to_light);
            Some(color)
        }
        _ => None,
    };
    let ambient = env.ambient.map(|(sky, ground)| abgr_avg(sky, ground));
    let fog = env.fog;

    // -- meshes: opaques in tree order, then blended far -> near ---------------
    let mut cur_blend: Option<Blend> = None;
    let mut cur_cull: Option<bool> = None;
    // The lighting-unit commands below are a pure function of (color, unlit)
    // once `ambient`/`sun` are fixed for the frame, and GE state is sticky —
    // so re-sending an identical set is a no-op the guest pays for. rally's
    // ~260 barrier posts share one material, which is ~4 display-list words
    // each plus the abgr_mul math.
    let mut cur_light: Option<(u32, bool)> = None;
    for d in &draws[..] {
        let baked = &*d.baked;
        if cur_blend != Some(d.blend) {
            apply_blend(d.blend, fog);
            cur_blend = Some(d.blend);
        }
        let cull = d.flags & mat_flags::DOUBLE_SIDED == 0;
        if cur_cull != Some(cull) {
            if cull {
                sys::sceGuEnable(GuState::CullFace);
            } else {
                sys::sceGuDisable(GuState::CullFace);
            }
            cur_cull = Some(cull);
        }
        // Lighting-unit modulate: out = vtxColor x (ambient' + sun' x ndotl).
        let unlit = d.flags & mat_flags::UNLIT != 0;
        if cur_light != Some((d.color, unlit)) {
            cur_light = Some((d.color, unlit));
            apply_light(d.color, unlit, ambient, sun);
        }
        sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(d.world));
        let mut done = 0usize;
        while done < baked.indices.len() {
            let n = (baked.indices.len() - done).min(MAX_PRIM_IDX);
            sys::sceGuDrawArray(
                GuPrimitive::Triangles,
                VTYPE_MESH,
                n as i32,
                baked.indices.as_ptr().add(done) as *const c_void,
                baked.verts.as_ptr() as *const c_void,
            );
            done += n;
        }
    }
    sys::sceGuSetMatrix(sys::MatrixMode::Model, &to_psp_matrix(Mat4::IDENTITY));

    // -- pools: camera-facing sprites + view-aligned beams (unlit, unfogged) ---
    sys::sceGuDisable(GuState::Lighting);
    sys::sceGuDisable(GuState::Light0);
    sys::sceGuDisable(GuState::Fog);
    sys::sceGuDisable(GuState::CullFace);
    sys::sceGuDepthMask(1); // pools never write depth
    let right = cam.q * Vec3::X;
    let up = cam.q * Vec3::Y;
    let mut bound_glow = false;
    for &pid in &sc.pools {
        let Some(pool) = store.pool(pid) else { continue };
        if pool.count == 0 {
            continue;
        }
        let Some(mat) = store.material(pool.mat) else { continue };
        if !bound_glow {
            bind_glow();
            bound_glow = true;
        }
        if mat.flags & mat_flags::ADDITIVE != 0 {
            sys::sceGuBlendFunc(BlendOp::Add, BlendFactor::SrcAlpha, BlendFactor::Fix, 0, 0xffffff);
        } else {
            sys::sceGuBlendFunc(
                BlendOp::Add,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
                0,
                0,
            );
        }
        sys::sceGuEnable(GuState::Blend);
        let bytes = pool.count * 6 * core::mem::size_of::<PoolVert>();
        let verts = pool_alloc(bytes) as *mut PoolVert;
        let mut vi = 0usize;
        let mut quad = |corners: [Vec3; 4], uvs: [[f32; 2]; 4], color: u32| {
            for i in [0usize, 1, 2, 0, 2, 3] {
                *verts.add(vi) = PoolVert {
                    u: uvs[i][0],
                    v: uvs[i][1],
                    color,
                    x: corners[i].x,
                    y: corners[i].y,
                    z: corners[i].z,
                };
                vi += 1;
            }
        };
        match pool.kind {
            PoolKind::Sprite => {
                for i in 0..pool.count {
                    let e = &pool.live[i * SPRITE_STRIDE..(i + 1) * SPRITE_STRIDE];
                    let p = Vec3::new(e[0], e[1], e[2]);
                    let half = e[3] * 0.5;
                    quad(
                        [
                            p - right * half + up * half,
                            p + right * half + up * half,
                            p + right * half - up * half,
                            p - right * half - up * half,
                        ],
                        [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]],
                        abgr_mul(mat.color, pool.colors[i]),
                    );
                }
            }
            PoolKind::Beam => {
                for i in 0..pool.count {
                    let e = &pool.live[i * BEAM_STRIDE..(i + 1) * BEAM_STRIDE];
                    let a = Vec3::new(e[0], e[1], e[2]);
                    let b = Vec3::new(e[3], e[4], e[5]);
                    let mid = (a + b) * 0.5;
                    let side = (b - a).cross(cam.p - mid).normalize_or_zero() * (e[6] * 0.5);
                    // v pinned to 0.5: the soft falloff runs across width.
                    quad(
                        [a - side, b - side, b + side, a + side],
                        [[0.0, 0.5], [0.0, 0.5], [1.0, 0.5], [1.0, 0.5]],
                        abgr_mul(mat.color, pool.colors[i]),
                    );
                }
            }
        }
        sys::sceKernelDcacheWritebackRange(verts as *const c_void, bytes as u32);
        sys::sceGuDrawArray(
            GuPrimitive::Triangles,
            VTYPE_POOL,
            vi as i32,
            core::ptr::null(),
            verts as *const c_void,
        );
    }

    // -- restore the 2D pass state (ge.rs contract) ------------------------------
    sys::sceGuDisable(GuState::DepthTest);
    sys::sceGuDisable(GuState::ClipPlanes);
    sys::sceGuDisable(GuState::Fog);
    sys::sceGuDepthMask(0);
    sys::sceGuDisable(GuState::Texture2D);
    if bound_glow {
        sys::sceGuTexWrap(GuTexWrapMode::Repeat, GuTexWrapMode::Repeat); // sceGuInit default
    }
    sys::sceGuViewport(2048, 2048, SCREEN_WIDTH as i32, SCREEN_HEIGHT as i32);
    sys::sceGuEnable(GuState::Blend);
    sys::sceGuBlendFunc(BlendOp::Add, BlendFactor::SrcAlpha, BlendFactor::OneMinusSrcAlpha, 0, 0);
}

unsafe fn draws_scratch() -> &'static mut Vec<Draw> {
    if DRAWS.is_none() {
        DRAWS = Some(Vec::new());
    }
    DRAWS.as_mut().unwrap()
}

unsafe fn blended_scratch() -> &'static mut Vec<Draw> {
    if BLENDED.is_none() {
        BLENDED = Some(Vec::new());
    }
    BLENDED.as_mut().unwrap()
}

unsafe fn stack_scratch() -> &'static mut Vec<(i32, u32)> {
    if STACK.is_none() {
        STACK = Some(Vec::new());
    }
    STACK.as_mut().unwrap()
}

unsafe fn worlds_scratch() -> &'static mut Vec<Mat4> {
    if WORLDS.is_none() {
        WORLDS = Some(Vec::new());
    }
    WORLDS.as_mut().unwrap()
}

/// Program the lighting unit for one material colour. Depends only on
/// (color, unlit) plus the frame-constant env, which is why the emit loop can
/// skip it whenever those match the previous draw (GE state is sticky).
unsafe fn apply_light(color: u32, unlit: bool, ambient: Option<u32>, sun: Option<u32>) {
    if unlit {
        sys::sceGuDisable(GuState::Light0);
        sys::sceGuAmbient(color);
        return;
    }
    // Ambient rgb = avg hemisphere x material; alpha rides the ambient path
    // on the GE, so it carries the material alpha.
    let amb_rgb = abgr_mul(ambient.unwrap_or(0), color) & 0x00ff_ffff;
    sys::sceGuAmbient(amb_rgb | (color & 0xff00_0000));
    match sun {
        Some(sun_color) => {
            sys::sceGuLightColor(0, LightComponent::DIFFUSE, abgr_mul(sun_color, color));
            sys::sceGuEnable(GuState::Light0);
        }
        None => sys::sceGuDisable(GuState::Light0),
    }
}

unsafe fn apply_blend(blend: Blend, fog: Option<(u32, f32, f32)>) {
    match blend {
        Blend::Opaque => {
            sys::sceGuDisable(GuState::Blend);
            sys::sceGuDepthMask(0);
        }
        Blend::Alpha => {
            sys::sceGuEnable(GuState::Blend);
            sys::sceGuBlendFunc(
                BlendOp::Add,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
                0,
                0,
            );
            sys::sceGuDepthMask(1);
        }
        Blend::Additive => {
            sys::sceGuEnable(GuState::Blend);
            sys::sceGuBlendFunc(BlendOp::Add, BlendFactor::SrcAlpha, BlendFactor::Fix, 0, 0xffffff);
            sys::sceGuDepthMask(1);
        }
    }
    match fog {
        Some((color, near, far)) => {
            // Additive fades OUT with distance, never toward fog color.
            let c = if blend == Blend::Additive { 0 } else { color };
            sys::sceGuFog(near, far, c);
            sys::sceGuEnable(GuState::Fog);
        }
        None => sys::sceGuDisable(GuState::Fog),
    }
}

/// Screen-space gouraud strip evaluating the desktop fs_sky per row:
/// ray elevation at the rect's horizontal center, `pow(1 - up, 2.5)` blend.
unsafe fn draw_sky(x: i32, y: i32, w: i32, h: i32, q: Quat, fov_y: f32, zenith: u32, horizon: u32) {
    const ROWS: usize = 8;
    let fwd = q * Vec3::NEG_Z;
    let up_axis = q * Vec3::Y;
    let tan_f = libm::tanf(fov_y * 0.5);
    let chan = |c: u32, s: u32| (c >> s & 0xff) as f32 / 255.0;
    let bytes = (ROWS + 1) * 2 * core::mem::size_of::<SkyVert>();
    let verts = pool_alloc(bytes) as *mut SkyVert;
    for r in 0..=ROWS {
        let t = r as f32 / ROWS as f32;
        let ndc_y = 1.0 - 2.0 * t; // +1 = rect top
        let ray = (fwd + up_axis * (tan_f * ndc_y)).normalize_or_zero();
        let up_c = ray.y.clamp(0.0, 1.0);
        let blend = libm::powf(1.0 - up_c, 2.5);
        let mix = |s: u32| chan(zenith, s) + (chan(horizon, s) - chan(zenith, s)) * blend;
        let color = pack_rgb(mix(0), mix(8), mix(16));
        let ry = y + ((t * h as f32) as i32).min(h);
        *verts.add(r * 2) = SkyVert { color, x: x as i16, y: ry as i16, z: 0, _pad: 0 };
        *verts.add(r * 2 + 1) =
            SkyVert { color, x: (x + w) as i16, y: ry as i16, z: 0, _pad: 0 };
    }
    sys::sceKernelDcacheWritebackRange(verts as *const c_void, bytes as u32);
    sys::sceGuDrawArray(
        GuPrimitive::TriangleStrip,
        VTYPE_SKY,
        ((ROWS + 1) * 2) as i32,
        core::ptr::null(),
        verts as *const c_void,
    );
}

unsafe fn bind_glow() {
    sys::sceGuEnable(GuState::Texture2D);
    sys::sceGuTexMode(TexturePixelFormat::Psm8888, 0, 0, 0);
    sys::sceGuTexImage(
        MipmapLevel::None,
        GLOW_DIM as i32,
        GLOW_DIM as i32,
        GLOW_DIM as i32,
        glow_texture() as *const c_void,
    );
    sys::sceGuTexFunc(TextureEffect::Modulate, TextureColorComponent::Rgba);
    sys::sceGuTexFilter(TextureFilter::Linear, TextureFilter::Linear);
    sys::sceGuTexWrap(GuTexWrapMode::Clamp, GuTexWrapMode::Clamp);
    sys::sceGuTexScale(1.0, 1.0);
    sys::sceGuTexOffset(0.0, 0.0);
}
