// playset/math/math-utils.ts — Three.js-compatible math subset for
// @pocketjs/playset. API mirrors three@0.161 (MIT © three.js authors);
// reimplemented from the standard formulas, not copied.

export const DEG2RAD: number = Math.PI / 180;
export const RAD2DEG: number = 180 / Math.PI;

/** Clamps `value` to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Linear interpolation from `x` to `y` by factor `t`. */
export function lerp(x: number, y: number, t: number): number {
  return (1 - t) * x + t * y;
}

/** Inverse of lerp: the factor of `value` between `x` and `y` (0 when x === y). */
export function inverseLerp(x: number, y: number, value: number): number {
  if (x !== y) return (value - x) / (y - x);
  return 0;
}

/** Frame-rate independent exponential approach of `x` toward `y`. */
export function damp(x: number, y: number, lambda: number, dt: number): number {
  return lerp(x, y, 1 - Math.exp(-lambda * dt));
}

/** Maps `x` from range [a1, a2] into range [b1, b2]. */
export function mapLinear(x: number, a1: number, a2: number, b1: number, b2: number): number {
  return b1 + ((x - a1) * (b2 - b1)) / (a2 - a1);
}

/** Euclidean (always-positive) modulo of n by m. */
export function euclideanModulo(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Triangle wave over [0, length] (default length 1). */
export function pingpong(x: number, length = 1): number {
  return length - Math.abs(euclideanModulo(x, length * 2) - length);
}

/** Hermite smoothstep of `x` between `min` and `max`. */
export function smoothstep(x: number, min: number, max: number): number {
  if (x <= min) return 0;
  if (x >= max) return 1;
  x = (x - min) / (max - min);
  return x * x * (3 - 2 * x);
}

/** Perlin's smootherstep of `x` between `min` and `max`. */
export function smootherstep(x: number, min: number, max: number): number {
  if (x <= min) return 0;
  if (x >= max) return 1;
  x = (x - min) / (max - min);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function degToRad(degrees: number): number {
  return degrees * DEG2RAD;
}

export function radToDeg(radians: number): number {
  return radians * RAD2DEG;
}

/** Random integer in the inclusive interval [low, high]. */
export function randInt(low: number, high: number): number {
  return low + Math.floor(Math.random() * (high - low + 1));
}

/** Random float in the interval [low, high). */
export function randFloat(low: number, high: number): number {
  return low + Math.random() * (high - low);
}

/** Random float in the interval (-range/2, range/2). */
export function randFloatSpread(range: number): number {
  return range * (0.5 - Math.random());
}

/**
 * Namespace object matching three's `MathUtils` export so ports can keep
 * `MathUtils.lerp(...)` call sites unchanged.
 */
export const MathUtils = {
  DEG2RAD,
  RAD2DEG,
  clamp,
  lerp,
  inverseLerp,
  damp,
  mapLinear,
  euclideanModulo,
  pingpong,
  smoothstep,
  smootherstep,
  degToRad,
  radToDeg,
  randInt,
  randFloat,
  randFloatSpread,
} as const;
