// The fixed prefix of every frame transaction, shared by the Solid, Vue
// Vapor, Octane and headless entries:
//
//   virtual clock → input latches → service pumps → effect delivery
//
// The order is a correctness contract, not a convention: module Promise
// delivery (network batches polled by the service pumps) must enter the world
// before the frame-boundary effects and before any app code runs, and the
// input latches must be in place before anything reads analog/touch state.
// One definition here keeps a fifth runtime from re-typing the sequence.

import { __setAnalog } from "./analog.ts";
import { __advanceClock } from "./clock.ts";
import { __drainEffects } from "./effects.ts";
import { runServicePumps } from "./services.ts";
import { __setTouches } from "./touch.ts";

export interface FramePreludeInput {
  /** Packed analog nub sample (see analog.ts); undefined = no nub. */
  readonly analog?: number;
  /** Packed touch contacts and their host-resolved hit facts (touch.ts). */
  readonly touches?: readonly number[];
  readonly hits?: readonly number[];
}

/**
 * Run the frame prelude. UI entries pass the host's input snapshot so the
 * latches are set before pumps and effects; the headless entry passes
 * nothing (no input surface). Promise reactions raised inside the pumps run
 * in the host's job drain after `frame()` returns.
 */
export function runFramePrelude(input?: FramePreludeInput): void {
  __advanceClock(); // virtual frame++, fire due after() timers
  if (input) {
    __setAnalog(input.analog); // latch the nub before any app code reads it
    __setTouches(input.touches, input.hits); // latch contacts + their hit facts
  }
  runServicePumps(); // only modules with pending async work register here
  __drainEffects(); // frame-boundary deliveries enter the world first
}
