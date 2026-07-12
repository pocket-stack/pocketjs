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
  {
    // chrome: bevel border rings (Win98 window mock, demos/chrome). f2 =
    // initial layout: raised window frame, sunken text well, thin status
    // cells, navy caption gradient. DOWN@4 focuses OK, RIGHT@8 moves to
    // CANCEL — f12 shows the focus face tint; CIRCLE held f16..22 — f18 is
    // the active: bevel INVERSION; f26 is released and back to raised.
    name: "chrome-main",
    frames: 30,
    capture: [2, 12, 18, 26],
    input: (f) =>
      f === 4 ? BTN.DOWN : f === 8 ? BTN.RIGHT : f >= 16 && f <= 22 ? BTN.CIRCLE : 0,
  },
  {
    // im (Pocket Talk): bootstrap lands at f30 — f40 is the conversation
    // list (presence, unread badges, previews). CIRCLE@60 opens MAYA CHEN —
    // f80 is the thread bottom (wrapped bubbles, read ticks). UP held
    // 90..150 scrolls the virtual window — f160 shows mid-history with a
    // day chip. SELECT@170 jumps back, TRIANGLE@200 opens the OSK, DOWN@230
    // walks focus to 'q', CIRCLE@260 types it — f280 is the OSK with a live
    // draft. START@300 sends; f370 has the ack + delivery receipt (gray ✓✓).
    name: "im-main",
    frames: 380,
    capture: [40, 80, 160, 280, 370],
    input: (f) =>
      f === 60
        ? BTN.CIRCLE
        : f >= 90 && f < 150
          ? BTN.UP
          : f === 170
            ? BTN.SELECT
            : f === 200
              ? BTN.TRIANGLE
              : f === 230
                ? BTN.DOWN
                : f === 260
                  ? BTN.CIRCLE
                  : f === 300
                    ? BTN.START
                    : 0,
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
