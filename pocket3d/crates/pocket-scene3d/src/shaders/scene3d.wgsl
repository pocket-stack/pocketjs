// pocket-scene3d: sky + vertex-lit meshes + pooled billboards/ribbons.
//
// Fixed-function honesty (ops.ts header): lighting and fog are evaluated
// PER VERTEX, and all color math happens in gamma space — exactly what the
// PSP GE computes on bytes — with one srgb_to_linear at the fragment end so
// the sRGB render target re-encodes back to the gamma-space result.

struct Globals {
    view_proj: mat4x4f,
    cam_right: vec4f,   // xyz = camera right, w = tan(fovY/2) * aspect
    cam_up: vec4f,      // xyz = camera up,    w = tan(fovY/2)
    cam_fwd: vec4f,     // xyz = camera look direction
    cam_pos: vec4f,
    sun_dir: vec4f,     // xyz = direction the light TRAVELS, w = enabled
    sun_color: vec4f,
    amb_sky: vec4f,     // w = ambient enabled
    amb_ground: vec4f,
    fog_color: vec4f,   // w = fog enabled
    fog_params: vec4f,  // x = near, y = far
    sky_zenith: vec4f,
    sky_horizon: vec4f,
}

@group(0) @binding(0) var<uniform> globals: Globals;

fn srgb_to_linear(c: vec3f) -> vec3f {
    let lo = c / 12.92;
    let hi = pow((c + vec3f(0.055)) / 1.055, vec3f(2.4));
    return select(hi, lo, c <= vec3f(0.04045));
}

/// Linear fog factor by view depth: 1 = unfogged, 0 = fully fog colored.
fn fog_factor(world_pos: vec3f) -> f32 {
    if globals.fog_color.w == 0.0 {
        return 1.0;
    }
    let depth = dot(world_pos - globals.cam_pos.xyz, globals.cam_fwd.xyz);
    let near = globals.fog_params.x;
    let far = globals.fog_params.y;
    return clamp((far - depth) / (far - near), 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Sky: fullscreen-in-rect gradient (zenith -> horizon), no depth.
// ---------------------------------------------------------------------------

struct SkyOut {
    @builtin(position) clip: vec4f,
    @location(0) ndc: vec2f,
}

@vertex
fn vs_sky(@builtin(vertex_index) vi: u32) -> SkyOut {
    // One clipped fullscreen triangle.
    var p = vec2f(f32(i32(vi & 1u) * 4 - 1), f32(i32(vi >> 1u) * 4 - 1));
    var out: SkyOut;
    out.clip = vec4f(p, 0.0, 1.0);
    out.ndc = p;
    return out;
}

@fragment
fn fs_sky(in: SkyOut) -> @location(0) vec4f {
    let ray = normalize(
        globals.cam_fwd.xyz
            + globals.cam_right.xyz * in.ndc.x * globals.cam_right.w
            + globals.cam_up.xyz * in.ndc.y * globals.cam_up.w,
    );
    let up = clamp(ray.y, 0.0, 1.0);
    let horizon_blend = pow(1.0 - up, 2.5);
    let rgb = mix(globals.sky_zenith.rgb, globals.sky_horizon.rgb, horizon_blend);
    return vec4f(srgb_to_linear(rgb), 1.0);
}

// ---------------------------------------------------------------------------
// Meshes: per-vertex hemisphere + sun lighting, per-vertex linear fog.
// ---------------------------------------------------------------------------

// MAT bits (ops.ts).
const MAT_VERTEX_COLORS: u32 = 1u;
const MAT_UNLIT: u32 = 2u;
const MAT_ADDITIVE: u32 = 4u;

struct DrawU {
    model: mat4x4f,
    color: vec4f,   // material color x tint, gamma space 0..1
    misc: vec4u,    // x = MAT flags
}

@group(1) @binding(0) var<uniform> draw: DrawU;

struct MeshIn {
    @location(0) pos: vec3f,
    @location(1) normal: vec3f,
    @location(2) color: vec3f,
}

struct MeshOut {
    @builtin(position) clip: vec4f,
    @location(0) rgb: vec3f,
    @location(1) alpha: f32,
}

@vertex
fn vs_mesh(in: MeshIn) -> MeshOut {
    let world = (draw.model * vec4f(in.pos, 1.0)).xyz;
    // Fixed-function normal path: rotate by the model basis, renormalize
    // (non-uniform scale skews slightly, exactly like the GE).
    let n = normalize((draw.model * vec4f(in.normal, 0.0)).xyz);
    let flags = draw.misc.x;

    var albedo = draw.color.rgb;
    if (flags & MAT_VERTEX_COLORS) != 0u {
        albedo *= in.color;
    }

    var lit = albedo;
    if (flags & MAT_UNLIT) == 0u {
        var light = vec3f(0.0);
        if globals.amb_sky.w != 0.0 {
            light += mix(globals.amb_ground.rgb, globals.amb_sky.rgb, n.y * 0.5 + 0.5);
        }
        if globals.sun_dir.w != 0.0 {
            light += globals.sun_color.rgb * max(dot(n, -globals.sun_dir.xyz), 0.0);
        }
        lit = albedo * light;
    }

    let f = fog_factor(world);
    var rgb: vec3f;
    if (flags & MAT_ADDITIVE) != 0u {
        rgb = lit * f; // additive fades OUT with distance, never toward fog
    } else {
        rgb = mix(globals.fog_color.rgb, lit, f);
    }

    var out: MeshOut;
    out.clip = globals.view_proj * vec4f(world, 1.0);
    out.rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
    out.alpha = draw.color.a;
    return out;
}

@fragment
fn fs_mesh(in: MeshOut) -> @location(0) vec4f {
    return vec4f(srgb_to_linear(in.rgb), in.alpha);
}

@fragment
fn fs_mesh_opaque(in: MeshOut) -> @location(0) vec4f {
    return vec4f(srgb_to_linear(in.rgb), 1.0);
}

// ---------------------------------------------------------------------------
// Pools: camera-facing sprite quads + view-aligned beam ribbons. Always
// unlit and unfogged; a procedural radial falloff stands in for the glow
// texture the GE variant would sample.
// ---------------------------------------------------------------------------

struct PoolIn {
    @location(0) pos: vec3f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f, // unorm ABGR bytes = rgba, gamma space
}

struct PoolOut {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
}

@vertex
fn vs_pool(in: PoolIn) -> PoolOut {
    var out: PoolOut;
    out.clip = globals.view_proj * vec4f(in.pos, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn fs_pool(in: PoolOut) -> @location(0) vec4f {
    // Sprites carry full 0..1 uvs (radial falloff); beams pin v = 0.5 so the
    // falloff runs across the ribbon width only.
    let d = length((in.uv - vec2f(0.5)) * 2.0);
    let soft = clamp(1.0 - d * d, 0.0, 1.0);
    return vec4f(srgb_to_linear(in.color.rgb), in.color.a * soft);
}
