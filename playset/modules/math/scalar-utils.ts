// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © xt4d) —
// modules/math/ScalarUtils.js. Verbatim semantics; the smoothing helpers are
// the framerate-independence backbone every motion controller leans on.

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function toFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function lerp(start: number, end: number, alpha: number): number {
  return start + (end - start) * alpha;
}

export function fract(value: number): number {
  return value - Math.floor(value);
}

export function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function toDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** dt-stable exponential smoothing factor: 1 - e^(-dt/lag). */
export function smoothingAlpha(lag: number, deltaSeconds: number): number {
  const safeDelta = Math.max(0, deltaSeconds);
  if (lag <= 0) return 1;
  return 1 - Math.exp(-safeDelta / lag);
}

export function smoothToward(
  current: number,
  target: number,
  lag: number,
  deltaSeconds: number,
): number {
  return current + (target - current) * smoothingAlpha(lag, deltaSeconds);
}
