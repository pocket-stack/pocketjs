// host-sim/shot.ts — the frozen-frame downscale (LAUNCHER.md, spec op 41).
//
// One transform, shared by the cover cooker (scripts/launcher.ts) and the
// sim launcher runner (host-sim/launcher.ts): center-crop the 480×272
// framebuffer to 2:1 (rows 16..255), bilinear-downscale ×1.875 to 256×128
// RGBA — the pow2 texture the launcher stretches back over the screen.
//
// Pure IEEE-double arithmetic, no wall clock: byte-stable across runs and
// machines, so cover-bearing goldens hold. native/src/switch.rs implements
// the same crop + filter for the on-device capture; the two need only be
// visually equivalent (their outputs never meet in one golden), determinism
// WITHIN each host is what matters.

export const SHOT_W = 256;
export const SHOT_H = 128;

/** Source rows kept by the 2:1 center crop of a 480×272 frame. */
export const SHOT_CROP_Y = 16;
export const SHOT_CROP_H = 240;

/** Downscale a 480×272 RGBA framebuffer to the 256×128 shot texture. */
export function downscaleShot(rgba: Uint8Array, srcW = 480, srcH = 272): Uint8Array {
  if (rgba.length < srcW * srcH * 4) {
    throw new Error(`shot: framebuffer too small (${rgba.length} < ${srcW * srcH * 4})`);
  }
  const cropY = Math.max(0, Math.floor((srcH - (srcW * SHOT_H) / SHOT_W) / 2));
  const cropH = Math.min(srcH, Math.floor((srcW * SHOT_H) / SHOT_W));
  const out = new Uint8Array(SHOT_W * SHOT_H * 4);
  const scaleX = srcW / SHOT_W;
  const scaleY = cropH / SHOT_H;
  for (let dy = 0; dy < SHOT_H; dy++) {
    const sy = (dy + 0.5) * scaleY - 0.5;
    const y0 = Math.min(cropH - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(cropH - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let dx = 0; dx < SHOT_W; dx++) {
      const sx = (dx + 0.5) * scaleX - 0.5;
      const x0 = Math.min(srcW - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const r00 = ((cropY + y0) * srcW + x0) * 4;
      const r01 = ((cropY + y0) * srcW + x1) * 4;
      const r10 = ((cropY + y1) * srcW + x0) * 4;
      const r11 = ((cropY + y1) * srcW + x1) * 4;
      const o = (dy * SHOT_W + dx) * 4;
      for (let c = 0; c < 3; c++) {
        const top = rgba[r00 + c] + (rgba[r01 + c] - rgba[r00 + c]) * fx;
        const bot = rgba[r10 + c] + (rgba[r11 + c] - rgba[r10 + c]) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
      // Opaque by definition — the native GE leaves framebuffer alpha 0 and
      // switch.rs forces it too; the two paths must agree.
      out[o + 3] = 255;
    }
  }
  return out;
}
