// apps/gallery/gen-assets.ts — render the gallery's cover shaders and bake them.
//
//   bun apps/gallery/gen-assets.ts
//
// For each tile it renders a GLSL shader (apps/gallery/shaders.ts) in a headless
// Chrome WebGL2 context at 256x256, box-downsamples to a 64x64 pow2 texture (4x
// supersampled AA), and writes tile-NN.png next to this file plus a tiles.ts
// manifest. `bun tools/build.ts gallery-main` then bakes each PNG into the pak
// (via framework/compiler/pak.ts decodePng). PNG encoder subset matches decodePng exactly
// (colorType 6, bitDepth 8, filter 0, single node:zlib IDAT).

import { deflateSync } from "node:zlib";
import { decodePng } from "../../framework/compiler/pak.ts";
import { PALETTES, PRELUDE, SHADERS, TILES } from "./shaders.ts";

const HERE = new URL(".", import.meta.url).pathname; // apps/gallery/
const FRAME_RENDER = 128; // per-frame render size (2x supersampled)
const FRAME = 64; // per-frame final size (pow2 cell)
const FRAMES = 8; // animation frames per cover (a seamless loop)
const ACOLS = 4; // atlas grid columns
const AROWS = 2; // atlas grid rows (ACOLS*AROWS >= FRAMES)
const ATLAS_W = ACOLS * FRAME; // 256 (pow2, <= TEX_MAX_DIM)
const ATLAS_H = AROWS * FRAME; // 128 (pow2)
const FRAME_STEP = 4; // vblanks per frame (8*4 = 32 ~= 0.53s loop)
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9343;

// ---------------------------------------------------------------------------
// PNG encoder (validated against framework/compiler/pak.ts decodePng)
// ---------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function u32be(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; }
function chunk(type: string, data: Uint8Array): Uint8Array {
  const tb = new TextEncoder().encode(type);
  const body = new Uint8Array(tb.length + data.length); body.set(tb, 0); body.set(data, tb.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32be(data.length), 0); out.set(body, 4); out.set(u32be(crc32(body)), 4 + body.length);
  return out;
}
function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1); }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w, false); dv.setUint32(4, h, false); ihdr[8] = 8; ihdr[9] = 6;
  const idat = new Uint8Array(deflateSync(raw));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0); const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

/** Box-downsample a srcN x srcN RGBA image to dstN x dstN (opaque). */
function downsampleFrame(src: Uint8Array, srcN: number, dstN: number): Uint8Array {
  const k = srcN / dstN;
  const out = new Uint8Array(dstN * dstN * 4);
  for (let ty = 0; ty < dstN; ty++) for (let tx = 0; tx < dstN; tx++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const sx = tx * k + dx, sy = ty * k + dy, si = (sy * srcN + sx) * 4;
      r += src[si]; g += src[si + 1]; b += src[si + 2];
    }
    const n = k * k, oi = (ty * dstN + tx) * 4;
    out[oi] = Math.round(r / n); out[oi + 1] = Math.round(g / n); out[oi + 2] = Math.round(b / n); out[oi + 3] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Headless WebGL2 renderer (Chrome over the DevTools Protocol)
// ---------------------------------------------------------------------------

const HARNESS = `
window.__setup = () => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
  if (!gl) return false;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  window.__gl = { c, gl, buf, vs: '#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}' };
  return true;
};
window.bake = (frag, size, uni) => {
  const { c, gl, buf, vs } = window.__gl;
  c.width = size; c.height = size;
  const v = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(v, vs); gl.compileShader(v);
  const f = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(f, frag); gl.compileShader(f);
  if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) return { error: 'frag: ' + gl.getShaderInfoLog(f) };
  const pr = gl.createProgram(); gl.attachShader(pr, v); gl.attachShader(pr, f); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return { error: 'link: ' + gl.getProgramInfoLog(pr) };
  gl.useProgram(pr);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = (n) => gl.getUniformLocation(pr, n);
  gl.uniform2f(u('iResolution'), size, size);
  gl.uniform1f(u('iTime'), uni.iTime || 0); gl.uniform1f(u('iSeed'), uni.iSeed || 0);
  gl.uniform3fv(u('pa'), uni.pa); gl.uniform3fv(u('pb'), uni.pb); gl.uniform3fv(u('pc'), uni.pc); gl.uniform3fv(u('pd'), uni.pd);
  gl.viewport(0, 0, size, size); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.deleteShader(v); gl.deleteShader(f); gl.deleteProgram(pr);
  return { url: c.toDataURL('image/png') };
};
window.__setup();
`;

function fragFor(shaderBody: string): string {
  return `#version 300 es\nprecision highp float;\nout vec4 fragColor;\n${PRELUDE}\n${shaderBody}\nvoid main(){ mainImage(fragColor, gl_FragCoord.xy); }\n`;
}

async function main() {
  const proc = Bun.spawn(
    [CHROME, "--headless=new", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"],
    { stdout: "ignore", stderr: "ignore" });

  const waitFor = async <T>(fn: () => Promise<T>, tries = 60, gap = 100): Promise<T> => {
    for (let i = 0; i < tries; i++) { try { return await fn(); } catch { await Bun.sleep(gap); } } throw new Error("chrome timeout");
  };
  const version = await waitFor(() => fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()));
  const ws = new WebSocket(version.webSocketDebuggerUrl as string);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.error ? { __error: m.error } : (m.result ?? {})); pend.delete(m.id); } };
  const raw = (method: string, params: any = {}, s?: string) => { const i = ++id; const p: any = { id: i, method, params }; if (s) p.sessionId = s; return new Promise<any>((r) => { pend.set(i, r); ws.send(JSON.stringify(p)); }); };
  const { targetInfos } = await raw("Target.getTargets");
  const pt = targetInfos.find((t: any) => t.type === "page");
  const { sessionId } = await raw("Target.attachToTarget", { targetId: pt.targetId, flatten: true });
  const evalJs = async (expr: string) => {
    const r = await raw("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };
  await raw("Runtime.enable", {}, sessionId);
  const okSetup = await evalJs(HARNESS + "\ntrue");
  if (!okSetup) throw new Error("WebGL2 harness failed to init");

  const names: string[] = [];
  const spriteMeta: Record<string, { cols: number; rows: number; frames: number; step: number }> = {};
  for (const tile of TILES) {
    const pal = PALETTES[tile.page];
    const frag = fragFor(SHADERS[tile.shader].body);
    // Composite FRAMES loop frames into one pow2 atlas (ACOLS x AROWS grid).
    const atlas = new Uint8Array(ATLAS_W * ATLAS_H * 4);
    for (let i = 0; i < ATLAS_W * ATLAS_H; i++) atlas[i * 4 + 3] = 255;
    for (let f = 0; f < FRAMES; f++) {
      const uni = { iTime: f / FRAMES, iSeed: tile.seed, pa: pal.a, pb: pal.b, pc: pal.c, pd: pal.d };
      const call = `window.bake(${JSON.stringify(frag)}, ${FRAME_RENDER}, ${JSON.stringify(uni)})`;
      const res = await evalJs(call);
      if (!res || res.error) {
        throw new Error(`shader '${SHADERS[tile.shader].name}' tile ${tile.index} frame ${f}: ${res?.error ?? "no result"}`);
      }
      const png = Uint8Array.from(atob(String(res.url).split(",")[1]), (ch) => ch.charCodeAt(0));
      const img = decodePng(png);
      if (img.width !== FRAME_RENDER || img.height !== FRAME_RENDER) {
        throw new Error(`unexpected render size ${img.width}x${img.height}`);
      }
      const cell = downsampleFrame(img.rgba, FRAME_RENDER, FRAME);
      const col = f % ACOLS, row = Math.floor(f / ACOLS);
      for (let y = 0; y < FRAME; y++) {
        const dst = ((row * FRAME + y) * ATLAS_W + col * FRAME) * 4;
        const src = y * FRAME * 4;
        atlas.set(cell.subarray(src, src + FRAME * 4), dst);
      }
    }
    const name = `tile-${String(tile.index).padStart(2, "0")}.png`;
    names.push(name);
    spriteMeta[name] = { cols: ACOLS, rows: AROWS, frames: FRAMES, step: FRAME_STEP };
    await Bun.write(HERE + name, encodePng(ATLAS_W, ATLAS_H, atlas));
    console.log(`  baked ${name}  <- ${SHADERS[tile.shader].name} (page ${tile.page}, ${FRAMES}f atlas ${ATLAS_W}x${ATLAS_H})`);
  }
  await Bun.write(HERE + "sprites.json", JSON.stringify(spriteMeta, null, 2) + "\n");

  const manifest =
    `// AUTO-GENERATED by apps/gallery/gen-assets.ts — the gallery's shader-baked\n` +
    `// animated cover atlases. Names are FULL string literals so tools/build.ts\n` +
    `// collects them; sprites.json marks them as sprite atlases so each is baked\n` +
    `// into the pak as a ui:sprite.<name> entry (a plain .ts, NOT *.generated.ts,\n` +
    `// so the pass-1 walker scans it).\n\n` +
    `export const FRAME_SIZE = ${FRAME};\n` +
    `export const GALLERY_PAGES = 4;\n` +
    `export const TILES_PER_PAGE = 6;\n\n` +
    `export const TILE_SRCS: string[] = [\n` +
    names.map((n) => `  ${JSON.stringify(n)},`).join("\n") + `\n];\n`;
  await Bun.write(HERE + "tiles.ts", manifest);

  ws.close(); proc.kill();
  console.log(`gallery: baked ${names.length} animated covers (${FRAMES}f, ${ATLAS_W}x${ATLAS_H}) + tiles.ts + sprites.json`);
}

await main();
