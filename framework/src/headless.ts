// Headless runtime entry: the frame transaction without a UI root.
//
// A host without a display (or a display it does not drive from PocketJS)
// still ticks the guest once per host tick through `globalThis.frame(...)`.
// `mountHeadless()` installs a frame handler that runs the same fixed
// prefix of the frame transaction the UI entries run — virtual clock →
// service pumps (network delivery) → effect delivery → app hook — and
// nothing else: no renderer, no input edge detection, no `globalThis.ui`
// requirement. Promise reactions raised inside the pumps run in the host's
// job drain after `frame()` returns, exactly as under `render()`.
//
// This is what the network smoke firmware and headless daemons use; a UI
// app keeps using `render()`/`mount()` from the framework entry.

import { resetClock } from "./clock.ts";
import { resetEffects } from "./effects.ts";
import { runFramePrelude } from "./frame-prelude.ts";
import { installFrameHandler } from "./host.ts";

export interface HeadlessOptions {
  /** Called every frame after service pumps and effect delivery. */
  frame?: (buttons: number, analog: number) => void;
}

/** Install the headless frame handler. Returns a disposer that uninstalls it. */
export function mountHeadless(options: HeadlessOptions = {}): () => void {
  resetClock(); // latches the host's __simHz clock policy (docs/DETERMINISM.md)
  resetEffects();
  const hook = options.frame;
  installFrameHandler((buttons: number, analog?: number) => {
    runFramePrelude(); // clock → pumps → effects (frame-prelude.ts); no input surface to latch
    if (hook) hook(buttons, analog ?? 0);
  });
  return () => {
    (globalThis as { frame?: unknown }).frame = undefined;
  };
}
