// Skinned/static models: base color texture, hemisphere + sun lighting.

struct Globals {
    view_proj: mat4x4f,
    cam_pos: vec4f,
    sky_zenith: vec4f,
    sky_horizon: vec4f,
    sun_dir: vec4f,
    sun_color: vec4f,
}

struct Instance {
    model: mat4x4f,
    tint: vec4f,
    // x: lit amount, y: alpha-test cutoff (0 = off), z/w unused
    params: vec4f,
}

struct Material {
    base_color_factor: vec4f,
    // x: unlit, y: alpha-test cutoff, z: double-sided, w: alpha blend
    params: vec4f,
    // x: monochrome base color, y/z/w reserved
    style: vec4f,
}

@group(0) @binding(0) var<uniform> globals: Globals;

@group(1) @binding(0) var t_albedo: texture_2d<f32>;
@group(1) @binding(1) var s_albedo: sampler;
@group(1) @binding(2) var<uniform> material: Material;

@group(2) @binding(0) var<uniform> instance: Instance;
@group(2) @binding(1) var<storage, read> joints: array<mat4x4f>;

struct VsIn {
    @location(0) pos: vec3f,
    @location(1) normal: vec3f,
    @location(2) uv: vec2f,
    @location(3) joints: vec4u,
    @location(4) weights: vec4f,
}

struct VsOut {
    @builtin(position) clip: vec4f,
    @location(0) uv: vec2f,
    @location(1) normal: vec3f,
    @location(2) world_pos: vec3f,
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var skin = mat4x4f(
        vec4f(1.0, 0.0, 0.0, 0.0),
        vec4f(0.0, 1.0, 0.0, 0.0),
        vec4f(0.0, 0.0, 1.0, 0.0),
        vec4f(0.0, 0.0, 0.0, 1.0),
    );
    let wsum = in.weights.x + in.weights.y + in.weights.z + in.weights.w;
    if wsum > 0.001 {
        skin = in.weights.x * joints[in.joints.x]
            + in.weights.y * joints[in.joints.y]
            + in.weights.z * joints[in.joints.z]
            + in.weights.w * joints[in.joints.w];
    }
    let world = instance.model * skin;
    let wp = world * vec4f(in.pos, 1.0);

    var out: VsOut;
    out.clip = globals.view_proj * wp;
    out.uv = in.uv;
    out.normal = normalize((world * vec4f(in.normal, 0.0)).xyz);
    out.world_pos = wp.xyz;
    return out;
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) front_facing: bool) -> @location(0) vec4f {
    var albedo = textureSample(t_albedo, s_albedo, in.uv)
        * material.base_color_factor
        * instance.tint;
    if material.style.x > 0.5 {
        // Texture samples are already linearized by the sRGB texture view.
        // Rec. 709 luminance removes hue without changing transparency.
        let luminance = dot(albedo.rgb, vec3f(0.2126, 0.7152, 0.0722));
        albedo = vec4f(vec3f(luminance), albedo.a);
    }
    let alpha_cutoff = max(instance.params.y, material.params.y);
    if alpha_cutoff > 0.0 && albedo.a < alpha_cutoff {
        discard;
    }
    var n = normalize(in.normal);
    if material.params.z > 0.5 && !front_facing {
        n = -n;
    }
    let sun = max(dot(n, normalize(globals.sun_dir.xyz)), 0.0);
    // Hemisphere ambient: sky color from above, warm bounce from below.
    let hemi = mix(
        globals.sky_horizon.rgb * 0.35,
        globals.sky_zenith.rgb * 0.55 + vec3f(0.25),
        n.y * 0.5 + 0.5,
    );
    let lit_amount = instance.params.x * (1.0 - material.params.x);
    let lighting = mix(
        vec3f(1.0),
        hemi + globals.sun_color.rgb * sun * 0.9,
        lit_amount,
    );
    let alpha = select(1.0, albedo.a, material.params.w > 0.5);
    return vec4f(albedo.rgb * lighting, alpha);
}
