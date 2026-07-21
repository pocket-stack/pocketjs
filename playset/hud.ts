// playset/hud.ts — per-field HUD signals from a snapshot, without the trap.
//
// THE TRAP (measured, real PSP): the obvious way to wire a game HUD is one
// signal holding a snapshot object, refreshed every frame:
//
//     const [hud, setHud] = createSignal(game.hudState());
//     createGameLoop({ render: () => setHud(game.hudState()) });
//
// A fresh object is never `===` the old one, so every consumer re-runs whether
// or not its own value moved — every Text line, every marker, every derived
// memo. In rally that fan-out measured 12,973 µs per frame amortised (78 ms
// per refresh), more than the physics and the scene flush put together, on a
// HUD where in steady state only a speed readout and two map markers change.
//
// `createHudSignals` keeps the ergonomics of "snapshot in, accessors out" and
// gives each field its own signal, so Solid's identity check stops an update
// at the source. It also refreshes on a fixed sim-step interval rather than
// every frame — HUD text does not need 60 Hz, and on a 333 MHz interpreter
// that alone is most of the cost.
//
// ANCHOR THE INTERVAL TO SIM STEPS, NOT RENDER FRAMES. Counting frames makes
// the refresh instants depend on simulationHz, which breaks the subsampling
// relation the deterministic goldens rely on (DETERMINISM.md): the same
// virtual second must produce the same pixels at 30 Hz and 60 Hz.

import { createSignal, batch, type Accessor } from "solid-js";

/**
 * A snapshot is any object whose fields are the scalars a HUD draws.
 *
 * Typed as `object` rather than a `Record` of scalars on purpose: interfaces
 * have no implicit index signature, so a `Record` constraint would reject the
 * `…HudState` interfaces every game already declares. Keep the fields scalar
 * anyway — an object-valued field is never `===` its predecessor and puts the
 * very trap this helper exists to remove back into one channel.
 */
export type HudSnapshot = object;

export interface HudOptions<T extends HudSnapshot> {
  /** Fresh values for this refresh. Called once per interval, not per frame. */
  read: () => T;
  /**
   * Sim steps between refreshes (default 6 = 10 Hz at the fixed 1/60 s step).
   * A game with a fast-moving readout can lower it; nothing visual needs 1.
   */
  everySteps?: number;
}

export interface Hud<T extends HudSnapshot> {
  /** One accessor per field of the snapshot. */
  fields: { [K in keyof T]: Accessor<T[K]> };
  /**
   * Call from the loop's `step` with the running step count. Refreshes on the
   * interval and is a cheap counter check otherwise.
   */
  tick: (stepCount: number) => void;
  /** Force a refresh now (game over, level change — anything the HUD must not lag). */
  refresh: () => void;
}

/**
 * Build per-field signals from a snapshot function.
 *
 * The snapshot's own object identity is never observed, so `read` may return a
 * reused buffer — which is the cheap thing to do on a device where every
 * allocation eventually costs a collection.
 */
export function createHudSignals<T extends HudSnapshot>(options: HudOptions<T>): Hud<T> {
  const initial = options.read();
  const everySteps = Math.max(1, Math.floor(options.everySteps ?? 6));

  const setters = {} as { [K in keyof T]: (v: T[K]) => void };
  const fields = {} as { [K in keyof T]: Accessor<T[K]> };
  for (const key of Object.keys(initial) as (keyof T)[]) {
    const [get, set] = createSignal(initial[key]);
    fields[key] = get as Accessor<T[typeof key]>;
    setters[key] = set as (v: T[typeof key]) => void;
  }

  const refresh = (): void => {
    const next = options.read();
    // One batch, so a refresh is a single reactive pass instead of one per
    // field; the writes whose value did not move cost a comparison and stop.
    batch(() => {
      for (const key of Object.keys(setters) as (keyof T)[]) setters[key](next[key]);
    });
  };

  return {
    fields,
    refresh,
    tick(stepCount: number): void {
      if (stepCount % everySteps === 0) refresh();
    },
  };
}
