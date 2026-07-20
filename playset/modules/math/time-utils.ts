// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © xt4d) —
// modules/math/TimeUtils.js, with ONE deliberate semantic upgrade:
//
// GameBlocks' Clock falls back to Date.now() unless the caller opts into
// manual mode — the wall clock leaks in by default. In Pocket the wall
// clock is never an input (DETERMINISM.md), so the non-manual path reads
// the VIRTUAL clock (@pocketjs/framework/clock virtualNow): same API, but
// deterministic by default on every host, replayable under host-sim.
// `useManual()` behaves exactly like the original (fixed-step drivers and
// tests advance it by hand).

import { virtualNow } from "@pocketjs/framework/clock";

export interface ClockOptions {
  manual?: boolean;
  nowMs?: number;
}

export class Clock {
  manual: boolean;
  currentMs: number;

  constructor({ manual = false, nowMs = 0 }: ClockOptions = {}) {
    this.manual = manual;
    this.currentMs = nowMs;
  }

  /** Milliseconds — manual value, or VIRTUAL time (never Date.now). */
  now(): number {
    return this.manual ? this.currentMs : virtualNow() * 1000;
  }

  nowSeconds(): number {
    return this.now() * 0.001;
  }

  /** GameBlocks name kept; "system" here means the virtual clock. */
  useSystem(): this {
    this.manual = false;
    return this;
  }

  useManual(nowMs: number = this.currentMs): this {
    this.manual = true;
    this.currentMs = nowMs;
    return this;
  }

  setMs(nowMs: number): this {
    this.currentMs = nowMs;
    return this;
  }

  advanceMs(deltaMs: number): this {
    this.currentMs += deltaMs;
    return this;
  }
}

export const DEFAULT_CLOCK = new Clock();
