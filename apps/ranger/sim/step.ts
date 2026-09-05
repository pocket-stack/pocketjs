// apps/ranger/sim/step.ts — M1 SWF-step orchestrator (hand-written).
//
// Implements the concrete M0 EXECUTION_ORDER (b-display, d-clip-enterframe,
// c-frame-scripts, e-finalize) from apps/ranger/scope.ts. The order is the
// SHARED constant — no divergent copy lives here: dispatch iterates
// EXECUTION_ORDER.order directly, and the phase map is keyed by its
// members, pinned at type level below.
//
// Per advancing SWF step: exactly ONE swfConsume() at the head (§3.3-3a);
// the snapshot is delivered to every consumer. Non-advancing host ticks
// only run hostPoll (input collection); consumers never see raw buttons.

import { EXECUTION_ORDER } from "../scope.ts";
import { schedulerStep, type SwfScheduler } from "./scheduler.ts";
import { hostPoll, swfConsume, type SwfInput } from "./input.ts";

/** Phase keys are exactly the shared M0 order members (no copy). */
export type StepPhase = (typeof EXECUTION_ORDER.order)[number];
export type StepHandlers = Record<StepPhase, (input: SwfInput) => void>;

export interface SwfStepState {
  scheduler: SwfScheduler;
  /** Advancing steps so far (each consumed exactly once). */
  steps: number;
  /** swfConsume() calls so far; invariant: consumes === steps. */
  consumes: number;
  /** Snapshot of the most recent advancing step (null before the first). */
  lastInput: SwfInput | null;
}

export function createSwfStepState(scheduler: SwfScheduler): SwfStepState {
  return { scheduler, steps: 0, consumes: 0, lastInput: null };
}

/** Host-rate input collection: every host tick, advance or not (§3.4-1). */
export function hostTick(_st: SwfStepState, buttons: number): void {
  hostPoll(buttons);
}

/**
 * One host tick of the pipeline. Returns 1 when the SWF frame advanced
 * (handlers ran in EXECUTION_ORDER with a single shared snapshot),
 * 0 otherwise (nothing ran; input stays latched).
 */
export function advanceSwfStep(st: SwfStepState, handlers: StepHandlers): 0 | 1 {
  const n = schedulerStep(st.scheduler);
  if (n === 0) return 0;
  const input = swfConsume();
  st.consumes += 1;
  st.steps += 1;
  st.lastInput = input;
  for (const phase of EXECUTION_ORDER.order) {
    handlers[phase](input);
  }
  return 1;
}
