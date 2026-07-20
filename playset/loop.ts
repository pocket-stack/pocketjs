// playset/loop.ts — the fixed-step game loop, wired to the virtual clock.
//
// GameBlocks demos run `FIXED_STEP = 1/60` state machines driven by rAF with
// dt clamping. Pocket already HAS the stronger version of that contract
// (DETERMINISM.md): one `frame()` per virtual frame, `60/hz` core ticks each.
// This helper folds a playset game into it: the sim ALWAYS steps at 1/60 s —
// on a low-Hz guest it steps 60/hz times per virtual frame — so the
// trajectory is identical at every simulationHz (the subsampling theorem
// extends from pixels to game state), input tapes replay byte-exact, and
// host-sim golden traces work unchanged.
//
// Usage (inside a component, e.g. the app root or a <Viewport3D> owner):
//
//   createGameLoop({
//     step: (dt, input) => { game.step(state, input, dt); },   // 1/60 fixed
//     render: () => { syncVisuals(state); scene.flush(); },    // once/frame
//   });

import { onFrame, analogX, analogY } from "@pocketjs/framework/lifecycle";
import { ticksPerFrame } from "@pocketjs/framework/clock";

/** The fixed simulation timestep (matches spec FIXED_DT: one core tick). */
export const FIXED_DT = 1 / 60;

export interface GameInput {
  /** spec BTN bitmask as delivered to frame(). */
  buttons: number;
  /** Analog nub, deadzoned, -1..1 (0 on stickless hosts). */
  analogX: number;
  analogY: number;
}

export interface GameLoopOptions {
  /** Called `60/hz` times per virtual frame with dt = FIXED_DT, always. */
  step: (dt: number, input: GameInput) => void;
  /** Called once per virtual frame AFTER the catch-up steps — push poses to
   *  the scene and flush here (presentation runs at the guest rate; the sim
   *  never skips or stretches a step). */
  render?: (input: GameInput) => void;
}

/** Register the loop (component-scoped — unregisters with its owner). */
export function createGameLoop(opts: GameLoopOptions): void {
  const input: GameInput = { buttons: 0, analogX: 0, analogY: 0 };
  onFrame((buttons) => {
    input.buttons = buttons;
    input.analogX = analogX();
    input.analogY = analogY();
    const n = ticksPerFrame();
    for (let i = 0; i < n; i++) opts.step(FIXED_DT, input);
    opts.render?.(input);
  });
}
