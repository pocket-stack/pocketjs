// App-facing lifecycle callbacks for Svelte.

import { onDestroy } from "svelte";
import { __resetAnalog } from "./analog.ts";

export { __setAnalog, analogRaw, analogX, analogY } from "./analog.ts";

type FrameCallback = (buttons: number) => void;

const callbacks = new Set<FrameCallback>();
let buttonHandlerBlockDepth = 0;

export function resetFrameHooks(): void {
  callbacks.clear();
  buttonHandlerBlockDepth = 0;
  __resetAnalog();
}

export function runFrameHooks(buttons: number): void {
  for (const cb of [...callbacks]) cb(buttons);
}

/**
 * Svelte's onDestroy throws outside component initialization, and the entry's
 * installTouchActivation() registers from module scope, where disposal falls to
 * resetFrameHooks() at the next mount instead.
 */
function onTeardown(dispose: () => void): void {
  try {
    onDestroy(dispose);
  } catch {
    // Registered outside a component; the next mount's reset owns it.
  }
}

export function onFrame(callback: FrameCallback): void {
  callbacks.add(callback);
  onTeardown(() => callbacks.delete(callback));
}

export interface ButtonPressOptions {
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
  /** See framework/src/frame.ts: arm only after the button is seen up for one frame. */
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

export interface SpriteAnimation {
  /** The frame's image name, as `svelte/reactivity` spells a reactive read. */
  readonly current: string;
}

export function createSpriteAnimation(
  frames: readonly string[],
  opts: SpriteAnimationOptions = {},
): SpriteAnimation {
  if (frames.length === 0) {
    throw new Error("PocketJS: createSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  let tick = $state(0);
  onFrame(() => {
    tick = (tick + 1) % (frames.length * frameStep);
  });
  return {
    get current() {
      return frames[Math.floor(tick / frameStep) % frames.length];
    },
  };
}
