// App-facing lifecycle callbacks for Vue Vapor.

import { computed, onScopeDispose, shallowRef, type ComputedRef } from "vue";

type FrameCallback = (buttons: number) => void;

const callbacks = new Set<FrameCallback>();
let buttonHandlerBlockDepth = 0;

export function resetFrameHooks(): void {
  callbacks.clear();
  buttonHandlerBlockDepth = 0;
}

export function runFrameHooks(buttons: number): void {
  for (const cb of [...callbacks]) cb(buttons);
}

export function onFrame(callback: FrameCallback): void {
  callbacks.add(callback);
  onScopeDispose(() => callbacks.delete(callback), true);
}

export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  /** See src/frame.ts: arm only after the button is seen up for one frame. */
  latched?: boolean;
}

export function pushButtonHandlerBlock(): () => void {
  buttonHandlerBlockDepth++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    buttonHandlerBlockDepth = Math.max(0, buttonHandlerBlockDepth - 1);
  };
}

export function onButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts: ButtonPressOptions = {},
): void {
  let prevButtons = opts.latched ? ~0 : 0; // latched: "everything held" until released
  onFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    const active = typeof opts.active === "function" ? opts.active() : opts.active ?? true;
    if (!active) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  });
}

export interface SpriteAnimationOptions {
  frameStep?: number;
}

export function createSpriteAnimation(frames: readonly string[], opts: SpriteAnimationOptions = {}): ComputedRef<string> {
  if (frames.length === 0) {
    throw new Error("PocketJS: createSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  const frame = shallowRef(0);
  onFrame(() => {
    frame.value = (frame.value + 1) % (frames.length * frameStep);
  });
  return computed(() => frames[Math.floor(frame.value / frameStep) % frames.length]);
}
