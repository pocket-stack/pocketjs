// Additive billboards / beams.

struct Globals {
    view_proj: mat4x4f,
    inverse_view_proj: mat4x4f,
    cam_pos: vec4f,
    sky_zenith: vec4f,
    sky_horizon: vec4f,
    sky_sun_dir: vec4f,
    sky_sun_color: vec4f,
    model_sun_dir: vec4f,
    model_sun_color: vec4f,
    model_ambient: vec4f,
    toon: vec4f,
    rim_color: vec4f,
    rim_params: vec4f,
    fog_color: vec4f,
    fog_params: vec4f,
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
    @location(2) world_pos: vec3f,
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    out.clip = globals.view_proj * vec4f(in.pos, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    out.world_pos = in.pos;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let glow = textureSample(t_glow, s_glow, in.uv);
    var visibility = 1.0;
    if globals.fog_color.w > 0.5 {
        visibility = 1.0 - smoothstep(
            globals.fog_params.x,
            globals.fog_params.y,
            distance(in.world_pos, globals.cam_pos.xyz),
        );
    }
    return vec4f(
        in.color.rgb * glow.a,
        in.color.a * glow.a * visibility,
    );
}
