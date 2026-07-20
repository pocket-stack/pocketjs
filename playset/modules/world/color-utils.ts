// playset/modules/world/color-utils.ts — hex-RGB → scene3d u32 ABGR helpers.
//
// Not a GameBlocks port. GameBlocks hands three.js 0xRRGGBB hex + a float
// `opacity`; scene3d materials/tints/pool colors take one u32 ABGR
// ((a<<24)|(b<<16)|(g<<8)|r, spec/spec.ts abgr()). Shared by the world/
// ports so every module folds opacity into the color the same way.

/** 0xRRGGBB + opacity (0..1, three material semantics) → u32 ABGR. */
export function rgbToAbgr(hex: number, alpha = 1): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Component floats (0..1, three Color semantics) + opacity → u32 ABGR.
 *  Components are clamped per byte, so >1 brightness folds to full. */
export function rgbFloatsToAbgr(r: number, g: number, b: number, alpha = 1): number {
  const toByte = (c: number) => Math.max(0, Math.min(255, Math.round(c * 255)));
  return ((toByte(alpha) << 24) | (toByte(b) << 16) | (toByte(g) << 8) | toByte(r)) >>> 0;
}

/** Scale a hex color's RGB bytes by `fade` (the pool fade idiom: additive
 *  brightness rides in RGB, per WeaponEffectsSystem's vertex-color fade). */
export function fadeRgbToAbgr(hex: number, fade: number, alpha = 1): number {
  const r = (((hex >> 16) & 255) / 255) * fade;
  const g = (((hex >> 8) & 255) / 255) * fade;
  const b = ((hex & 255) / 255) * fade;
  return rgbFloatsToAbgr(r, g, b, alpha);
}
