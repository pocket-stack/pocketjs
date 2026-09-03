// Svelte flavor of the kinetic scroller. The six-state machine lives in
// kinetics-core.ts (framework-neutral); this shim binds the offset to a rune
// and registers the d-pad pump on the Svelte frame hook.

import { BTN } from "../../contracts/spec/spec.ts";
import { analogY } from "./analog.ts";
import { onFrame } from "./frame.svelte.ts";
import {
  createScrollerWith,
  type DpadScrollOptions,
  type Scroller,
  type ScrollerOptions,
} from "./kinetics-core.ts";

export type { Scroller, DpadScrollOptions, ScrollerOptions, ScrollerState } from "./kinetics-core.ts";

export function createScroller(opts: ScrollerOptions): Scroller {
  return createScrollerWith((initial) => {
    let offset = $state(initial);
    return [() => offset, (next) => (offset = next)] as const;
  }, opts);
}

/**
 * The apps/im d-pad/analog scroll semantics over a Scroller: held UP/DOWN
 * moves the chase target stepPx per frame, the nub moves it proportionally.
 * Registers an onFrame hook (component-scoped); the caller still owns step().
 */
export function bindDpadScroll(s: Scroller, o: DpadScrollOptions = {}): void {
  const step = o.stepPx ?? 6;
  const nubStep = o.nubPx ?? 10;
  onFrame((buttons) => {
    if (o.active && !o.active()) return;
    if (buttons & BTN.UP) s.nudge(-step);
    if (buttons & BTN.DOWN) s.nudge(step);
    const nub = analogY();
    if (nub !== 0) s.nudge(nub * nubStep);
  });
}
