// playset/math/index.ts — Three.js-compatible math subset for
// @pocketjs/playset. API mirrors three@0.161 (MIT © three.js authors);
// reimplemented, not copied. Porting a GameBlocks module is a mechanical
// import swap: `import { Vector3 } from 'three'` → `from '../math/index.ts'`.

export { Vector3, type BufferAttributeLike } from "./vector3.ts";
export { Quaternion } from "./quaternion.ts";
export { Matrix4 } from "./matrix4.ts";
export { Euler, type EulerOrder } from "./euler.ts";
export {
  Color,
  ColorManagement,
  LinearSRGBColorSpace,
  LinearToSRGB,
  SRGBColorSpace,
  SRGBToLinear,
  type ColorRepresentation,
  type ColorSpace,
  type HSL,
  type RGB,
} from "./color.ts";
export { DEG2RAD, MathUtils, RAD2DEG } from "./math-utils.ts";
