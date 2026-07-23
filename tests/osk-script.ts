// tests/osk-script.ts — turn "type this text on the system OSK" into a
// deterministic button script. Uses the SAME layout/navigation math the
// keyboard runs (framework/src/osk-layout.ts), so journeys stay valid across layout
// tweaks: the scripter walks a BFS-shortest d-pad path to each key and
// presses CIRCLE, switching layers with the L/R chords when a character
// lives elsewhere. Mirrors the panel's conventions: focus starts on 'q',
// layer switches preserve the clamped position.

import { BTN, SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import type { ScriptEvent } from "../hosts/sim/sim.ts";
import {
  clampPos,
  layoutRows,
  navigate,
  OSK_GAP,
  OSK_H,
  OSK_LAYERS,
  OSK_PAD,
  OSK_ROW_H,
  type OskLayerName,
  type OskPos,
} from "../framework/src/osk-layout.ts";

const INNER_W = SCREEN_W - 8; // panel padding: OSK_PAD each side

const DIRS = ["up", "down", "left", "right"] as const;
const DIR_BTN = { up: BTN.UP, down: BTN.DOWN, left: BTN.LEFT, right: BTN.RIGHT } as const;

function findKey(layer: OskLayerName, ch: string): OskPos | null {
  const rows = layoutRows(OSK_LAYERS[layer], INNER_W);
  for (const row of rows) {
    for (const k of row) if (k.key.ch === ch) return { row: k.row, col: k.col };
  }
  return null;
}

/** BFS-shortest d-pad path (navigate() transitions) from one key to another. */
function pathTo(layer: OskLayerName, from: OskPos, to: OskPos): (typeof DIRS)[number][] {
  const rows = layoutRows(OSK_LAYERS[layer], INNER_W);
  const id = (p: OskPos) => `${p.row}:${p.col}`;
  const start = clampPos(rows, from);
  const seen = new Map<string, (typeof DIRS)[number][]>([[id(start), []]]);
  const queue: OskPos[] = [start];
  while (queue.length) {
    const pos = queue.shift()!;
    const path = seen.get(id(pos))!;
    if (pos.row === to.row && pos.col === to.col) return path;
    for (const d of DIRS) {
      const next = navigate(rows, pos, d);
      if (!seen.has(id(next))) {
        seen.set(id(next), [...path, d]);
        queue.push(next);
      }
    }
  }
  throw new Error(`osk-script: ${id(to)} unreachable from ${id(start)}`);
}

export class OskScripter {
  readonly events: ScriptEvent[] = [];
  private layer: OskLayerName = "lower";
  private pos: OskPos = { row: 0, col: 1 }; // the panel focuses 'q' on open

  constructor(
    private t: number,
    private step = 0.5,
  ) {}

  press(btn: number): this {
    this.events.push({ at: this.t, press: btn });
    this.t += this.step;
    return this;
  }

  /** △ — open the keyboard (panel state resets to lower/'q'). */
  open(): this {
    this.layer = "lower";
    this.pos = { row: 0, col: 1 };
    return this.press(BTN.TRIANGLE);
  }

  /** START — commit. */
  commit(): this {
    return this.press(BTN.START);
  }

  private setLayer(next: OskLayerName, chord: number): void {
    this.press(chord);
    this.layer = next;
    this.pos = clampPos(layoutRows(OSK_LAYERS[next], INNER_W), this.pos);
  }

  /** Navigate to `ch` (switching layers when needed) and press CIRCLE. */
  type(text: string): this {
    for (const ch of text) {
      if (!findKey(this.layer, ch)) {
        const home = (["lower", "upper", "symbols"] as const).find((l) => findKey(l, ch));
        if (!home) throw new Error(`osk-script: no layer types ${JSON.stringify(ch)}`);
        // Chord routes: R toggles lower<->upper, L toggles ...<->symbols
        // (L from symbols always lands on lower).
        while (this.layer !== home) {
          if (home === "symbols" || this.layer === "symbols") {
            this.setLayer(this.layer === "symbols" ? "lower" : "symbols", BTN.LTRIGGER);
          } else {
            this.setLayer(this.layer === "upper" ? "lower" : "upper", BTN.RTRIGGER);
          }
        }
      }
      const target = findKey(this.layer, ch)!;
      for (const d of pathTo(this.layer, this.pos, target)) this.press(DIR_BTN[d]);
      this.pos = target;
      this.press(BTN.CIRCLE);
    }
    return this;
  }

  /** Touch-tap each character at its key center (panel docked at the bottom
   *  of the screen — the system convention). A tap is a one-event contact
   *  released half a step later: down arms + highlights, release commits. */
  tap(text: string): this {
    for (const ch of text) {
      const pos = findKey(this.layer, ch);
      if (!pos) throw new Error(`osk-script: ${JSON.stringify(ch)} is not on layer ${this.layer}`);
      const rows = layoutRows(OSK_LAYERS[this.layer], INNER_W);
      const rect = rows[pos.row][pos.col];
      const x = Math.round(OSK_PAD + rect.x + rect.w / 2);
      const y = Math.round(
        SCREEN_H - OSK_H + OSK_PAD + pos.row * (OSK_ROW_H + OSK_GAP) + OSK_ROW_H / 2,
      );
      this.events.push({ at: this.t, touch: [{ x, y }] });
      this.events.push({ at: this.t + this.step / 2, touch: [] });
      this.t += this.step;
      this.pos = pos; // the panel focus follows the tap
    }
    return this;
  }

  get end(): number {
    return this.t;
  }
}
