// Animation public API.

export { createCaretBlink, type CaretBlinkOptions } from "./caret-blink.ts";

export {
  animate,
  spring,
  cancelAnim,
  jump,
  createJumpBatch,
  type AnimateOptions,
  type EasingName,
  type JumpBatch,
} from "./anim.ts";
