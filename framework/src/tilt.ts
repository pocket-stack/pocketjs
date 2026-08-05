// Framework-neutral calibrated screen-plane tilt state.
//
// Sensor hardware, device orientation and calibration stay in the host. The
// guest receives one packed screen-plane sample per frame, so every framework
// observes the same right/down-positive coordinate system and deterministic
// center fallback.

import { TILT_CENTER } from "../../contracts/spec/spec.ts";

let tiltPacked = TILT_CENTER;

export function __setTilt(packed: number | undefined): void {
  tiltPacked = packed === undefined ? TILT_CENTER : packed & 0xffff;
}

export function __resetTilt(): void {
  tiltPacked = TILT_CENTER;
}

/** Raw calibrated screen-plane tilt ((x << 8) | y) delivered by the host. */
export function tiltRaw(): number {
  return tiltPacked;
}

/** One calibrated screen-plane axis normalized to -1..1. */
function axis(raw: number): number {
  // The negative half has 128 integer steps while the positive half has 127.
  return Math.max(-1, Math.min(1, (raw - 128) / 127));
}

/** Screen-plane X tilt in -1..1 (right positive), or 0 without input.tilt. */
export function tiltX(): number {
  return axis((tiltPacked >> 8) & 0xff);
}

/** Screen-plane Y tilt in -1..1 (down positive), or 0 without input.tilt. */
export function tiltY(): number {
  return axis(tiltPacked & 0xff);
}
