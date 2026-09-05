// apps/ranger/sim/rng.ts — M1 seeded RNG (hand-written).
//
// random(n) -> irandom(n): 0..n-1, seeded xorshift32 only (§3.5).
// Unseeded randomness is banned (static check in tests/ranger-input.test.ts).
// Mirrors the §6.3 rng fence (checked mirror of
// tests/ranger-doc-examples.test.ts §rng — keep in sync).

// checked mirror of tests/ranger-doc-examples.test.ts §rng — keep in sync.
// §3.5 xorshift32 고정
export interface Rng { next(n: number): number; reset(seed: number): void; }
export function createRng(seed = 0xc0ffee): Rng {
  let s = seed >>> 0 || 1;
  return {
    next(n: number): number {
      s ^= (s << 13) >>> 0; s >>>= 0;
      s ^= s >>> 17; s ^= (s << 5) >>> 0; s >>>= 0;
      return (s % n + n) % n;
    },
    reset(seed2: number): void { s = seed2 >>> 0 || 1; },
  };
}

// --- M1 companions (not part of the mirror) ---

/** Default seed (§3.5). */
export const DEFAULT_SEED = 0xc0ffee;
/** SWF getTimer() in ms from the SWF frame counter (§3.5). No wall clock. */
export function swfGetTimerMs(swfFrame: number): number {
  return Math.floor((swfFrame * 1000) / 24);
}
