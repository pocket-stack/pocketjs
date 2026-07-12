// demos/im/press.ts — a mount-safe button press hook.
//
// onButtonPress() starts its edge detector at "nothing held", so a component
// that mounts UNDER the user's finger sees the held button as a fresh press
// one frame later — enter a thread with CIRCLE and the thread's own CIRCLE
// handler would fire immediately. This variant seeds the detector with
// "everything held": a button must be seen up for at least one frame before
// its next press counts. Golden/sim scripts pulse buttons for single frames,
// so they are unaffected.

import { onFrame } from "@pocketjs/framework/lifecycle";

export function onPressLatched(mask: number, cb: () => void, active?: () => boolean): void {
  let prev = ~0;
  onFrame((buttons) => {
    const pressed = buttons & ~prev;
    prev = buttons;
    if (active && !active()) return;
    if (pressed & mask) cb();
  });
}
