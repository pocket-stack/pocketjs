import { BTN } from "../spec/spec.ts";

export interface GoldenSpec {
  name: string;
  frames: number;
  capture: number[];
  input?: (frame: number) => number;
}

// Shared by the headless WASM oracle and Vita3K E2E so inputs/frame indices
// cannot drift between hosts.
export const GOLDEN_SPECS: GoldenSpec[] = [
  {
    name: "hero-main",
    frames: 90,
    capture: [2, 10, 80],
    input: (f) =>
      f === 5 ? BTN.DOWN : f >= 20 && f <= 36 && (f - 20) % 4 === 0 ? BTN.CIRCLE : 0,
  },
  {
    name: "cards-main",
    frames: 90,
    capture: [2, 12, 24, 78],
    input: (f) => (f === 4 || f === 8 ? BTN.RIGHT : f === 18 ? BTN.CIRCLE : 0),
  },
  {
    name: "stats-main",
    frames: 95,
    capture: [2, 20, 85],
    input: (f) => (f === 50 ? BTN.RIGHT : 0),
  },
  {
    name: "library-main",
    frames: 170,
    capture: [2, 30, 105, 150],
    input: (f) =>
      f === 4 || f === 8 ? BTN.RIGHT : f === 20 ? BTN.CIRCLE : f === 120 ? BTN.TRIANGLE : 0,
  },
  {
    name: "settings-main",
    frames: 100,
    capture: [2, 26, 90],
    input: (f) =>
      f === 4
        ? BTN.DOWN
        : f === 10
          ? BTN.CIRCLE
          : f === 16
            ? BTN.DOWN
            : f === 22
              ? BTN.CIRCLE
              : f === 28
                ? BTN.DOWN
                : f === 34
                  ? BTN.CIRCLE
                  : f === 40 || f === 44 || f === 48
                    ? BTN.DOWN
                    : f === 54
                      ? BTN.CIRCLE
                      : 0,
  },
  {
    name: "notifications-main",
    frames: 70,
    capture: [2, 34, 60],
    input: (f) => (f === 10 || f === 16 ? BTN.DOWN : f === 24 ? BTN.CIRCLE : 0),
  },
  {
    name: "music-main",
    frames: 100,
    capture: [2, 20, 60, 90],
    input: (f) =>
      f === 4
        ? BTN.DOWN
        : f === 10
          ? BTN.CIRCLE
          : f === 30 || f === 36
            ? BTN.DOWN
            : f === 42
              ? BTN.CIRCLE
              : f === 70
                ? BTN.RTRIGGER
                : 0,
  },
  {
    name: "gallery-main",
    frames: 236,
    capture: [42, 82, 132, 178, 200, 226],
    input: (f) =>
      f === 22
        ? BTN.RIGHT
        : f === 30
          ? BTN.CIRCLE
          : f === 50 || f === 100 || f === 150
            ? BTN.RTRIGGER
            : f === 190
              ? BTN.LTRIGGER
              : 0,
  },
  {
    name: "motions-main",
    frames: 240,
    capture: [8, 60, 120, 170, 236],
    input: (f) => (f === 200 ? BTN.RIGHT : 0),
  },
];

export function encodeThresholdInput(spec: GoldenSpec): string {
  const lastFrame = Math.max(...spec.capture);
  const entries: string[] = [];
  let previous = -1;
  for (let frame = 0; frame <= lastFrame; frame++) {
    const buttons = spec.input?.(frame) ?? 0;
    if (frame === 0 || buttons !== previous) {
      entries.push(`${frame}:0x${buttons.toString(16)}`);
      previous = buttons;
    }
  }
  return entries.join(",");
}
