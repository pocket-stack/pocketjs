struct Globals {
    screen: vec2f,
    _pad: vec2f,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VsIn {
    @location(0) pos: vec2f,
    @location(1) uv: vec2f,
    @location(2) color: vec4f,
}

struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
    @location(1) color: vec4f,
}

@vertex
fn vs_main(in: VsIn) -> VsOut {
    var out: VsOut;
    let ndc = vec2f(
        in.pos.x / globals.screen.x * 2.0 - 1.0,
        1.0 - in.pos.y / globals.screen.y * 2.0,
    );
    out.pos = vec4f(ndc, 0.0, 1.0);
    out.uv = in.uv;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
    let a = textureSample(atlas, samp, in.uv).r;
    return vec4f(in.color.rgb, in.color.a * a);
}
