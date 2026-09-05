// apps/ranger/sim/fixed.ts — M1 fixed-point + stage coordinates (hand-written).
//
// Game meaning is owned here; the first block is a checked mirror of
// tests/ranger-doc-examples.test.ts §fixed (keep in sync, §6.1/§6.6).
// All game positions/velocities are i32 subpx integers. No floats leak
// into accumulated state (§3.5). No unseeded randomness, no wall clock.

// checked mirror of tests/ranger-doc-examples.test.ts §fixed — keep in sync.
// 1px = 16 subpx. 모든 게임 좌표·속도는 i32 subpx 정수다.
export const SUB = 16;
export type Subpx = number; // i32 invariant (정수만 대입)
export const toSub = (px: number): Subpx => Math.floor(px) * SUB;
export const toPx = (s: Subpx): number => Math.floor(s / SUB);
export const GX = (x: number): number => Math.floor((x * 8) / 15); // §2.1
export const GY = (y: number): number => 32 + Math.floor((y * 8) / 15);

// --- M1 extensions (same §2.1 rules, not part of the mirror) ---

/** Uniform scale numerator/denominator: S = 8/15 (§2.1). Never 0.5. */
export const S_NUM = 8;
export const S_DEN = 15;
/** Letterbox offsets: OX = 0, OY = (240-176)/2 = 32 (§2.1). */
export const OX = 0;
export const OY = 32;
/** Mapped content size: 600*8/15 = 320, 330*8/15 = 176 (§2.1). */
export const CONTENT_W = 320;
export const CONTENT_H = 176;

/** Size mapping with the min-1px rule (§2.1): floor + lift 0-width to 1. */
export const GW = (w: number): number => {
  const v = Math.floor((w * S_NUM) / S_DEN);
  return w > 0 && v === 0 ? 1 : v;
};
export const GH = (h: number): number => {
  const v = Math.floor((h * S_NUM) / S_DEN);
  return h > 0 && v === 0 ? 1 : v;
};

/** Inverse mapping for debug/hit reports (§2.1). */
export const INV_GX = (px: number): number => Math.ceil(((px - OX) * S_DEN) / S_NUM);
export const INV_GY = (py: number): number => Math.ceil(((py - OY) * S_DEN) / S_NUM);

/** Font size rule (§2.4): floor(pt*8/15), min 8px. */
export const toFontPx = (pt: number): number => Math.max(8, Math.floor((pt * S_NUM) / S_DEN));
