// Input/focus public API.

export { BTN } from "../../contracts/spec/spec.ts";
export { touches, type TouchContact } from "./touch.ts";
export { pointer, type PointerSnapshot } from "./pointer.ts";
export {
  cursorX,
  cursorY,
  enableCursor,
  focusNode,
  getFocused,
  hitFocusable,
  pushFocusController,
  pushFocusGrid,
  pushFocusScope,
  type CursorOptions,
  type CursorSource,
  type FocusDirection,
  type FocusGridOptions,
  type FocusScopeOptions,
} from "./input.ts";
