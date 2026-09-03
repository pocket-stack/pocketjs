// Svelte flavor of the gesture layer. The recognizer machinery lives in
// gesture-core.ts (framework-neutral); this shim adds a createGesture() torn
// down with the calling component. Outside a component (the entry's
// installTouchActivation) onDestroy throws, so disposal falls to
// resetGestures() at the next mount.

import { onDestroy } from "svelte";
import { attachGesture, type GestureHandle, type GestureOptions } from "./gesture-core.ts";

export type {
  GestureContact,
  GestureHandle,
  GestureOptions,
  GesturePhase,
  GesturePinch,
  GestureRegion,
} from "./gesture-core.ts";
export { __runGestures, attachGesture, pushTouchBlock, resetGestures } from "./gesture-core.ts";

export function createGesture(opts: GestureOptions): GestureHandle {
  const handle = attachGesture(opts);
  try {
    onDestroy(() => handle.dispose());
  } catch {
    // Registered outside a component; the next mount's reset owns it.
  }
  return handle;
}
