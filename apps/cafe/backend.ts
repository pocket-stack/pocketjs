// apps/cafe/backend.ts — the café's "network": a virtual-time fake backend.
//
// This is the effect-shell pattern (docs/DETERMINISM.md) in its simplest shape:
// the DATA is a pure request -> response function, and the TIME is the
// virtual clock — `after()` schedules delivery a fixed number of virtual
// seconds out, so the response lands on the same virtual frame in every run,
// on every host, at every simulationHz. Swap `after` for a real fetch and
// you have the live driver; keep it and the whole app is a closed system.
//
// The pure `respond` is also exposed on globalThis for harnesses that want
// the same data under a DIFFERENT clock — tools/flake-lab.ts wires it to
// wall-clock setTimeout delivery to reproduce how ordinary runtimes flake.

import { after } from "@pocketjs/framework/clock";
import { installEffectDriver } from "@pocketjs/framework/effects";

export interface MenuItem {
  id: string;
  name: string;
  /** Price in cents — integer math keeps every total exact. */
  cents: number;
}

export interface OrderRequest {
  items: { id: string; qty: number }[];
  /** How many orders this session placed before this one (keeps respond pure). */
  seq: number;
}

export interface OrderReceipt {
  orderNo: number;
  etaMin: number;
}

export const MENU: MenuItem[] = [
  { id: "espresso", name: "ESPRESSO", cents: 300 },
  { id: "latte", name: "OAT LATTE", cents: 450 },
  { id: "matcha", name: "MATCHA", cents: 500 },
  { id: "mocha", name: "MOCHA", cents: 475 },
];

// Font-atlas coverage for dynamically composed strings (totals, order
// numbers, ETAs): the build harvests string literals, so spell out the
// digit set once.
const DIGITS = "0123456789";
void DIGITS;

export function respond(kind: string, payload: unknown): unknown {
  if (kind === "menu") return { items: MENU };
  if (kind === "order") {
    const req = payload as OrderRequest;
    const qty = req.items.reduce((n, it) => n + it.qty, 0);
    return { orderNo: 1042 + req.seq, etaMin: 4 + qty } satisfies OrderReceipt;
  }
  throw new Error(`cafe backend: unknown effect kind "${kind}"`);
}

/** Latency per request kind, in VIRTUAL seconds (0.5 s grid — exact at every
 *  valid simulationHz). */
export function latencySeconds(kind: string): number {
  return kind === "order" ? 1.0 : 0.5;
}

export function installCafeBackend(): void {
  installEffectDriver((cmd, deliver) => {
    after(latencySeconds(cmd.kind), () => deliver(respond(cmd.kind, cmd.payload)));
  });
  // The lab seam: same data, bring your own clock (tools/flake-lab.ts).
  (globalThis as Record<string, unknown>).__cafeBackend = { respond, latencySeconds };
}
