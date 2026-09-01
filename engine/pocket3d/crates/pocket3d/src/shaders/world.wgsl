// Lightmapped world geometry + procedural gradient sky.

struct Globals {
    view_proj: mat4x4f,
    inverse_view_proj: mat4x4f,
    cam_pos: vec4f,        // xyz = camera position, w = time (seconds)
    sky_zenith: vec4f,
    sky_horizon: vec4f,
    sky_sun_dir: vec4f,    // xyz = towards sun
    sky_sun_color: vec4f,
    model_sun_dir: vec4f,
    model_sun_color: vec4f,
    model_ambient: vec4f,
    toon: vec4f,
    rim_color: vec4f,
    rim_params: vec4f,
    fog_color: vec4f,      // rgb = color, w = enabled
    fog_params: vec4f,     // x = start, y = end
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

struct BackgroundSkyOut {
    @builtin(position) clip: vec4f,
    @location(0) ndc: vec2f,
}

fn safe_normalize(v: vec3f) -> vec3f {
    let length_squared = dot(v, v);
    if length_squared > 1e-10 {
        return v * inverseSqrt(length_squared);
    }
    return vec3f(0.0);
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

@vertex
fn vs_background_sky(@builtin(vertex_index) vertex_index: u32) -> BackgroundSkyOut {
    let positions = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0),
    );
    let ndc = positions[vertex_index];
    var out: BackgroundSkyOut;
    out.clip = vec4f(ndc, 1.0, 1.0);
    out.ndc = ndc;
    return out;
}

fn distance_fog(world_pos: vec3f) -> f32 {
    if globals.fog_color.w < 0.5 {
        return 0.0;
    }
    let distance_to_camera = distance(world_pos, globals.cam_pos.xyz);
    return smoothstep(globals.fog_params.x, globals.fog_params.y, distance_to_camera);
}

fn procedural_sky(ray: vec3f) -> vec3f {
    let up = clamp(ray.y, 0.0, 1.0);
    let horizon_blend = pow(1.0 - up, 3.0);
    var color = mix(globals.sky_zenith.rgb, globals.sky_horizon.rgb, horizon_blend);
    // Sun disc + halo.
    let sun_amount = max(dot(ray, safe_normalize(globals.sky_sun_dir.xyz)), 0.0);
    color += globals.sky_sun_color.rgb
        * (pow(sun_amount, 350.0) * 1.2 + pow(sun_amount, 8.0) * 0.12);
    return color;
}

fn shade(in: VsOut, albedo: vec4f) -> vec4f {
    let lm = textureSample(t_lightmap, s_lightmap, in.lm_uv).rgb;
    // GoldSrc-style overbright: lightmaps store 0..1 with 1.0 ~= 2x white.
    var color = albedo.rgb * lm * 2.0;
    color = mix(color, globals.fog_color.rgb, distance_fog(in.world_pos));
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
    let ray = safe_normalize(in.world_pos - globals.cam_pos.xyz);
    return vec4f(procedural_sky(ray), 1.0);
}

// Full-screen sky for model-only scenes. Reconstruct the far-plane world
// position so camera rotation and field of view match geometry sky faces.
@fragment
fn fs_background_sky(in: BackgroundSkyOut) -> @location(0) vec4f {
    let far_h = globals.inverse_view_proj * vec4f(in.ndc, 1.0, 1.0);
    let far_world = far_h.xyz / far_h.w;
    let ray = safe_normalize(far_world - globals.cam_pos.xyz);
    return vec4f(procedural_sky(ray), 1.0);
}
