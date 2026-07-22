// Lightmapped world geometry + procedural gradient sky.

struct Globals {
    view_proj: mat4x4f,
    cam_pos: vec4f,        // xyz = camera position, w = time (seconds)
    sky_zenith: vec4f,
    sky_horizon: vec4f,
    sun_dir: vec4f,        // xyz = towards sun
    sun_color: vec4f,
}

@group(0) @binding(0) var<uniform> globals: Globals;

@group(1) @binding(0) var t_albedo: texture_2d<f32>;
@group(1) @binding(1) var s_albedo: sampler;
@group(1) @binding(2) var t_lightmap: texture_2d<f32>;
@group(1) @binding(3) var s_lightmap: sampler;

struct VsIn {
    @location(0) pos: vec3f,
    @location(1) uv: vec2f,
    @location(2) lm_uv: vec2f,
}

struct VsOut {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) lm_uv: vec2f,
    @location(2) world_pos: vec3f,
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    out.clip = globals.view_proj * vec4f(in.pos, 1.0);
    out.uv = in.uv;
    out.lm_uv = in.lm_uv;
    out.world_pos = in.pos;
    return out;
}

fn shade(in: VsOut, albedo: vec4f) -> vec4f {
    let lm = textureSample(t_lightmap, s_lightmap, in.lm_uv).rgb;
    // GoldSrc-style overbright: lightmaps store 0..1 with 1.0 ~= 2x white.
    var color = albedo.rgb * lm * 2.0;
    return vec4f(color, 1.0);
}

@fragment
fn fs_opaque(in: VsOut) -> @location(0) vec4f {
    let albedo = textureSample(t_albedo, s_albedo, in.uv);
    return shade(in, albedo);
}

@fragment
fn fs_alphatest(in: VsOut) -> @location(0) vec4f {
    let albedo = textureSample(t_albedo, s_albedo, in.uv);
    if albedo.a < 0.5 {
        discard;
    }
    return shade(in, albedo);
}

// Sky brush faces: ignore surface detail, shade by view ray direction.
@fragment
fn fs_sky(in: VsOut) -> @location(0) vec4f {
    let ray = normalize(in.world_pos - globals.cam_pos.xyz);
    let up = clamp(ray.y, 0.0, 1.0);
    let horizon_blend = pow(1.0 - up, 3.0);
    var color = mix(globals.sky_zenith.rgb, globals.sky_horizon.rgb, horizon_blend);
    // Sun disc + halo.
    let sun_amount = max(dot(ray, normalize(globals.sun_dir.xyz)), 0.0);
    color += globals.sun_color.rgb * (pow(sun_amount, 350.0) * 1.2 + pow(sun_amount, 8.0) * 0.12);
    return vec4f(color, 1.0);
}
