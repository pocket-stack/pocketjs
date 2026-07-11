// demos/nightbloom/backend.ts — the augury: NIGHTBLOOM's "network", built on
// the effect-shell pattern (DETERMINISM.md), same shape as tidelight's wire.
//
// When a night phase begins, the engine asks the dark what is coming with
// runEffect("augury", { phase }). The DATA is a pure request -> response
// function; the TIME is the virtual clock: the omen lands as a frame-boundary
// delivery exactly one virtual second later — the same virtual second in
// every run, on every host, at every simulationHz. A forecast with dramatic
// latency, and it is still deterministic.

import { after } from "@pocketjs/framework/clock";
import { installEffectDriver } from "@pocketjs/framework/effects";
import { PHASES, type PhaseId } from "./data.ts";

export interface AuguryRequest {
  phase: PhaseId;
}

export interface AuguryResponse {
  omen: string;
}

export function respond(kind: string, payload: unknown): unknown {
  if (kind === "augury") {
    const req = payload as AuguryRequest;
    const phase = PHASES.find((p) => p.id === req.phase);
    if (!phase) throw new Error(`nightbloom backend: unknown phase "${req.phase}"`);
    return { omen: phase.omen } satisfies AuguryResponse;
  }
  throw new Error(`nightbloom backend: unknown effect kind "${kind}"`);
}

/** Latency per request kind, in VIRTUAL seconds (whole-second grid — exact at
 *  every valid simulationHz). The dark always takes a beat to answer. */
export function latencySeconds(kind: string): number {
  return kind === "augury" ? 1.0 : 0.5;
}

export function installAugury(): void {
  installEffectDriver((cmd, deliver) => {
    after(latencySeconds(cmd.kind), () => deliver(respond(cmd.kind, cmd.payload)));
  });
  // The lab seam: same data, bring your own clock.
  (globalThis as Record<string, unknown>).__nightbloomAugury = { respond, latencySeconds };
}
