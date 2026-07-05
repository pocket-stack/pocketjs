// demos/gallery/shaders.ts — GLSL cover shaders for the gallery tiles.
//
// ShaderToy-style fragment shaders adapted to WebGL2 (#version 300 es, mainImage
// + main() wrapper added by gen-assets.ts). Techniques follow the MiniMax
// shader-dev skill: cosine palettes, SDF ray marching (sphere tracing + smin +
// tetrahedron normals), value-noise FBM + domain warping, Voronoi, Julia
// escape-time, and polar kaleidoscope — all inside the software-render budget
// (<=80 march steps, <=6 FBM octaves). gen-assets.ts renders each at 256x256,
// box-downsamples to a 64x64 pow2 texture, and bakes it into the pak.

/** Cosine-palette params (a,b,c,d) per gallery page — one theme per screen. */
export const PALETTES: { a: number[]; b: number[]; c: number[]; d: number[] }[] = [
  // 0 SYNTHWAVE  — blue / magenta / cyan
  { a: [0.52, 0.50, 0.62], b: [0.50, 0.46, 0.52], c: [1.0, 1.0, 1.0], d: [0.62, 0.52, 0.82] },
  // 1 GOLDEN HOUR — amber / orange / red
  { a: [0.62, 0.44, 0.32], b: [0.42, 0.42, 0.30], c: [1.0, 1.0, 1.0], d: [0.02, 0.12, 0.22] },
  // 2 EVERGREEN  — green / teal / lime
  { a: [0.38, 0.52, 0.44], b: [0.36, 0.42, 0.40], c: [1.0, 1.0, 1.0], d: [0.32, 0.50, 0.42] },
  // 3 NEBULA     — violet / pink / deep blue
  { a: [0.54, 0.42, 0.64], b: [0.48, 0.42, 0.52], c: [1.0, 1.0, 1.0], d: [0.82, 0.60, 0.46] },
];

/** Prepended to every shader — uniforms + shared palette/noise helpers. */
export const PRELUDE = `
uniform vec2 iResolution; uniform float iTime; uniform float iSeed;
uniform vec3 pa, pb, pc, pd;

vec3 palette(float t){ return pa + pb * cos(6.28318 * (pc * t + pd)); }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
vec2 hash22(vec2 p){ vec3 a = fract(vec3(p.xyx) * vec3(123.34, 234.34, 345.65)); a += dot(a, a + 34.45); return fract(vec2(a.x * a.y, a.y * a.z)); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
const mat2 M2 = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++){ s += a * vnoise(p); p = M2 * p * 2.02; a *= 0.5; } return s; }
vec3 tonemap(vec3 c){ c = c / (c + 0.9); return pow(clamp(c, 0.0, 1.0), vec3(0.85)); }
`;

// iTime is the LOOP PHASE in [0,1); every shader animates via th = 2*PI*iTime
// with integer harmonics so frame N wraps seamlessly back to frame 0.
export const SHADERS: { name: string; body: string }[] = [
  // 0 — raymarched glossy metaballs (SDF sphere tracing + smin + soft light)
  {
    name: "metaballs",
    body: `
float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.0); return min(a, b) - h * h * 0.25 / k; }
float map(vec3 p){
  float th = 6.28318 * iTime;   // one loop
  float s = iSeed;
  vec3 a = 0.90 * vec3(cos(th + s), sin(th + s), 0.35 * sin(2.0 * th));
  vec3 b = 0.90 * vec3(cos(-th + s * 2.0 + 2.1), sin(th + s + 1.7), 0.35 * cos(th));
  vec3 c = 0.82 * vec3(sin(2.0 * th + s), cos(th + s + 0.8), 0.30 * sin(th + 3.0));
  float d = length(p - a) - 0.55;
  d = smin(d, length(p - b) - 0.50, 0.55);
  d = smin(d, length(p - c) - 0.50, 0.55);
  d = smin(d, length(p) - 0.42, 0.7);
  return d;
}
vec3 nrm(vec3 p){ vec2 e = vec2(0.0015, 0.0); return normalize(vec3(
  map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx))); }
void mainImage(out vec4 O, vec2 fc){
  vec2 uv = (2.0 * fc - iResolution.xy) / iResolution.y;
  vec3 ro = vec3(0.0, 0.0, -2.65), rd = normalize(vec3(uv, 1.25));
  float t = 0.0, hit = -1.0;
  for (int i = 0; i < 80; i++){ vec3 p = ro + t * rd; float d = map(p); if (d < 0.001){ hit = t; break; } t += d; if (t > 8.0) break; }
  vec3 col;
  if (hit > 0.0){
    vec3 p = ro + hit * rd, n = nrm(p);
    vec3 l = normalize(vec3(0.7, 0.9, -0.6));
    float dif = clamp(dot(n, l), 0.0, 1.0);
    float spc = pow(clamp(dot(reflect(-l, n), -rd), 0.0, 1.0), 40.0);
    float frs = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
    vec3 base = palette(0.42 + 0.4 * n.y + 0.28 * length(p.xy));
    col = base * (0.20 + 0.95 * dif) + spc * 1.0 + frs * palette(0.15 + iSeed) * 0.8;
  } else {
    float g = exp(-1.7 * length(uv));                 // soft colored backglow, not dead black
    col = palette(0.55 + 0.3 * uv.y) * (0.05 + 0.30 * g);
  }
  O = vec4(tonemap(col), 1.0);
}`,
  },

  // 1 — domain-warped nebula plasma (fbm(p + fbm(p + fbm(p))))
  {
    name: "nebula",
    body: `
void mainImage(out vec4 O, vec2 fc){
  vec2 uv = (2.0 * fc - iResolution.xy) / iResolution.y;
  float th = 6.28318 * iTime;
  uv *= rot(iSeed * 0.6);
  vec2 drift = 0.55 * vec2(cos(th), sin(th));  // circular domain drift -> seamless flow
  vec2 p = uv * 2.4 + iSeed * 3.0 + drift;
  vec2 q = vec2(fbm(p + vec2(0.0, 1.7)), fbm(p + vec2(5.2, 1.3)));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2)), fbm(p + 3.0 * q + vec2(8.3, 2.8)));
  float f = fbm(p + 3.5 * r);
  vec3 col = palette(f * 1.3 + 0.15 * length(q));
  col = mix(col, palette(0.1), clamp(1.0 - dot(r, r) * 0.9, 0.0, 1.0) * 0.4);
  col *= 0.7 + 0.8 * f;                             // luminous filaments
  col += palette(0.6) * pow(clamp(f, 0.0, 1.0), 4.0) * 0.6; // bright cores
  col *= 1.0 - 0.35 * dot(uv, uv);                  // vignette
  O = vec4(tonemap(col * 1.5), 1.0);
}`,
  },

  // 2 — Voronoi crystal cells with edge glow
  {
    name: "voronoi",
    body: `
void mainImage(out vec4 O, vec2 fc){
  vec2 uv = (2.0 * fc - iResolution.xy) / iResolution.y;
  uv *= rot(iSeed * 0.5);
  vec2 g = uv * 3.0 + iSeed * 2.0;
  vec2 i = floor(g), f = fract(g);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y));
    vec2 pt = o + 0.5 + 0.42 * sin(iSeed + 6.28318 * iTime + 6.2831 * hash22(i + o));
    float d = length(f - pt);
    if (d < d1){ d2 = d1; d1 = d; id = i + o; } else if (d < d2){ d2 = d; }
  }
  float edge = smoothstep(0.02, 0.16, d2 - d1);      // cell borders
  vec3 col = palette(0.35 + 0.6 * hash21(id) + 0.2 * d1);
  col *= 0.35 + 0.75 * edge;                          // facet shading
  col += palette(0.15) * (1.0 - edge) * 0.9;          // glowing seams
  col *= 1.0 - 0.3 * dot(uv, uv);
  O = vec4(tonemap(col * 1.3), 1.0);
}`,
  },

  // 3 — Julia set (escape-time) with smooth palette + inner glow
  {
    name: "julia",
    body: `
void mainImage(out vec4 O, vec2 fc){
  vec2 uv = (2.0 * fc - iResolution.xy) / iResolution.y;
  uv *= 1.2 * rot(iSeed * 0.25);
  // Curated dendritic Julia constants — filament-rich boundaries fill the frame.
  float k = mod(floor(iSeed * 1.7), 6.0);
  vec2 c = k < 1.0 ? vec2(-0.8, 0.156)
         : k < 2.0 ? vec2(0.285, 0.01)
         : k < 3.0 ? vec2(-0.70176, -0.3842)
         : k < 4.0 ? vec2(-0.4, 0.6)
         : k < 5.0 ? vec2(0.355, 0.355)
         : vec2(-0.512511, 0.521121);
  c += 0.02 * vec2(cos(iSeed * 1.3), sin(iSeed * 1.1));
  c += 0.045 * vec2(cos(6.28318 * iTime), sin(6.28318 * iTime)); // c wobbles on a circle -> seamless morph
  vec2 z = uv;
  float it = 0.0, m = 0.0, trap = 1e9;
  for (int i = 0; i < 100; i++){
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    m = dot(z, z);
    trap = min(trap, abs(z.x * z.y) * 2.0 + length(z) * 0.25); // orbit trap
    if (m > 16.0) break;
    it += 1.0;
  }
  float sn = it - log2(max(1.0, log2(m)));            // smooth iteration count
  vec3 col;
  if (m > 16.0){
    col = palette(0.48 + 0.045 * sn);
    col *= 0.5 + 0.5 * cos(sn * 0.35);                // exterior banding
    col += palette(0.78) * pow(clamp(1.0 - m / 16.0, 0.0, 1.0), 1.5) * 0.4;
  } else {
    col = palette(0.15 + 0.6 * exp(-3.0 * trap));     // interior via orbit trap (not flat)
    col *= 0.30 + 0.55 * exp(-2.0 * trap);
  }
  O = vec4(tonemap(col * 1.4), 1.0);
}`,
  },

  // 4 — polar kaleidoscope mandala
  {
    name: "kaleido",
    body: `
void mainImage(out vec4 O, vec2 fc){
  vec2 uv = (2.0 * fc - iResolution.xy) / iResolution.y;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float seg = 6.0 + floor(mod(iSeed, 4.0)) * 2.0;    // 6/8/10/12-fold symmetry
  a = abs(mod(a, 6.2831 / seg) - 3.1415 / seg);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q *= rot(iSeed + 6.28318 * iTime);            // full turn per loop -> seamless
  float p = 0.0;
  p += sin(q.x * 9.0 + iSeed) * cos(q.y * 9.0 - iSeed);
  p += 0.5 * sin(r * 16.0 - 6.28318 * iTime * 2.0 - iSeed * 2.0); // pulsing rings
  p += fbm(q * 4.0 + iSeed);
  vec3 col = palette(0.4 + 0.35 * p + 0.5 * r);
  col *= 0.6 + 0.6 * smoothstep(0.9, 0.3, r);         // radial falloff
  col += palette(0.15) * pow(clamp(1.0 - r, 0.0, 1.0), 3.0) * 1.2; // center bloom
  O = vec4(tonemap(col * 1.3), 1.0);
}`,
  },

  // 5 — warped energy portal (concentric rings through domain warp)
  {
    name: "portal",
    body: `
void mainImage(out vec4 O, vec2 fc){
  vec2 uv = (2.0 * fc - iResolution.xy) / iResolution.y;
  float th = 6.28318 * iTime;
  uv *= rot(iSeed * 0.3);
  vec2 dr = 0.25 * vec2(cos(th), sin(th));      // circular warp drift -> seamless
  vec2 w = uv + 0.35 * vec2(fbm(uv * 2.0 + iSeed + dr), fbm(uv * 2.0 + iSeed + 7.0 + dr));
  float r = length(w);
  float ang = atan(w.y, w.x);
  float rings = sin(r * 22.0 - th * 2.0 - iSeed * 3.0 + 3.0 * sin(ang * 3.0));
  float glow = pow(clamp(1.0 - r, 0.0, 1.0), 2.5);
  vec3 col = palette(0.45 + 0.25 * rings + 0.4 * r);
  col *= 0.45 + 0.55 * smoothstep(-0.2, 0.8, rings);
  col += palette(0.7) * glow * 1.4;                   // hot core
  col *= 1.0 - 0.35 * dot(uv, uv);
  O = vec4(tonemap(col * 1.35), 1.0);
}`,
  },
];

/** 24 tiles: page (0..3) x the 6 shaders, each with a per-tile seed for variety. */
export interface TileSpec { index: number; page: number; shader: number; seed: number; }
export const TILES: TileSpec[] = Array.from({ length: 24 }, (_, i) => ({
  index: i,
  page: Math.floor(i / 6),
  shader: i % 6,
  seed: 0.7 + i * 0.813, // decorrelated, deterministic
}));
