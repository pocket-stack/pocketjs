// Additive billboards / beams.

struct Globals {
    view_proj: mat4x4f,
    cam_pos: vec4f,
    sky_zenith: vec4f,
    sky_horizon: vec4f,
    sun_dir: vec4f,
    sun_color: vec4f,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var t_glow: texture_2d<f32>;
@group(1) @binding(1) var s_glow: sampler;

struct VsIn {
    @location(0) pos: vec3f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f,
}

struct VsOut {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    out.clip = globals.view_proj * vec4f(in.pos, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let glow = textureSample(t_glow, s_glow, in.uv);
    return vec4f(in.color.rgb * glow.a, in.color.a * glow.a);
}
