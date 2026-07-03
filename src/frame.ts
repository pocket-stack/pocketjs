// App-facing frame hooks.
//
// Hosts still drive one low-level global frame callback per vblank/rAF tick,
// but application code should register component-scoped hooks instead of
// patching mount() with a global per-frame callback.

import { createSignal, onCleanup, type Accessor } from "solid-js";

type FrameCallback = (buttons: number) => void;

const callbacks = new Set<FrameCallback>();

export function resetFrameHooks(): void {
  callbacks.clear();
}

export function runFrameHooks(buttons: number): void {
  for (const cb of [...callbacks]) cb(buttons);
}

export function useFrame(callback: FrameCallback): void {
  callbacks.add(callback);
  onCleanup(() => callbacks.delete(callback));
}

export function useButtonPress(mask: number, callback: (pressed: number, buttons: number) => void): void {
  let prevButtons = 0;
  useFrame((buttons) => {
    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
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
