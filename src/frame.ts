// App-facing frame hooks.
//
// Hosts still drive one low-level global frame callback per vblank/rAF tick,
// but application code should register component-scoped hooks instead of
// patching mount() with a global per-frame callback.

import { createSignal, onCleanup, type Accessor } from "solid-js";

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

export function useFrame(callback: FrameCallback): void {
  callbacks.add(callback);
  onCleanup(() => callbacks.delete(callback));
}

export interface ButtonPressOptions {
  /**
   * Modal/system handlers can opt out of the background action block. Normal
   * app handlers should stay blocked while a modal owns input.
   */
  allowWhenBlocked?: boolean;
  active?: boolean | (() => boolean);
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

export function useButtonPress(
  mask: number,
  callback: (pressed: number, buttons: number) => void,
  opts: ButtonPressOptions = {},
): void {
  let prevButtons = 0;
  useFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    const active = typeof opts.active === "function" ? opts.active() : opts.active ?? true;
    if (!active) return;
    if (buttonHandlerBlockDepth > 0 && !opts.allowWhenBlocked) return;
    if (pressed & mask) callback(pressed, buttons);
  });
}

export interface SpriteAnimationOptions {
  /** Number of host frames each sprite frame remains visible. */
  frameStep?: number;
}

export function useSpriteAnimation(frames: readonly string[], opts: SpriteAnimationOptions = {}): Accessor<string> {
  if (frames.length === 0) {
    throw new Error("psp-ui: useSpriteAnimation() requires at least one frame");
  }
  const frameStep = Math.max(1, Math.floor(opts.frameStep ?? 1));
  const [frame, setFrame] = createSignal(0);
  useFrame(() => {
    setFrame((frame() + 1) % (frames.length * frameStep));
  });
  return () => frames[Math.floor(frame() / frameStep) % frames.length];
}
