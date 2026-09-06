// Pocket Clear palettes. The color theme preserves the reference ramps; the
// e-ink theme uses neutral grays with larger luminance steps so adjacent rows
// remain distinct on a 16-level panel and after partial refreshes.

const TODO_H = 354;
const TODO_S = 100;
const TODO_L = 46;
const TODO_STEP_H = 7;
const TODO_STEP_L = 2;
const TODO_SPAN = 7;

const LIST_H = 212;
const LIST_S = 93;
const LIST_L = 53;
const LIST_STEP_H = -2.5;
const LIST_STEP_S = 1;
const LIST_STEP_L = 2.5;
const LIST_SPAN = 5;
const GRAD_L = 2;

export interface KeyboardPalette {
  readonly panelFrom: string;
  readonly panelTo: string;
  readonly divider: string;
  readonly char: readonly [string, string, string, string];
  readonly action: readonly [string, string, string, string];
  readonly engaged: readonly [string, string, string, string];
  readonly keyText: string;
  readonly engagedText: string;
  readonly popupFrom: string;
  readonly popupTo: string;
  readonly popupBorder: string;
}

export interface ClearPalette {
  readonly canvas: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly disabledForeground: string;
  readonly edgeLight: string;
  readonly edgeDark: string;
  readonly countCell: string;
  readonly doneFrom: string;
  readonly doneTo: string;
  readonly doneText: string;
  readonly completeFrom: string;
  readonly completeTo: string;
  readonly completeIcon: string;
  readonly deleteIcon: string;
  readonly flapFrom: string;
  readonly flapTo: string;
  readonly todoRows: (order: number, pendingRows: number) => readonly [string, string];
  readonly listRows: (order: number, rows: number) => readonly [string, string];
  readonly keyboard: KeyboardPalette;
}

function hex2(value: number): string {
  const v = Math.max(0, Math.min(255, Math.round(value)));
  return (v < 16 ? "0" : "") + v.toString(16);
}

/** hsl (deg, %, %) → '#rrggbb'. */
export function hsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${hex2((r + m) * 255)}${hex2((g + m) * 255)}${hex2((b + m) * 255)}`;
}

function colorTodoRows(order: number, pendingRows: number): readonly [string, string] {
  let stepH = TODO_STEP_H;
  let stepL = TODO_STEP_L;
  if (pendingRows > TODO_SPAN) {
    stepH = (TODO_STEP_H * TODO_SPAN) / pendingRows;
    stepL = (TODO_STEP_L * TODO_SPAN) / pendingRows;
  }
  const h = TODO_H + order * stepH;
  const s = order ? TODO_S - 10 : TODO_S;
  const l = TODO_L + order * stepL;
  return [hsl(h, s, l + GRAD_L), hsl(h, s, l - GRAD_L)];
}

function colorListRows(order: number, rows: number): readonly [string, string] {
  let stepH = LIST_STEP_H;
  let stepS = LIST_STEP_S;
  let stepL = LIST_STEP_L;
  if (rows > LIST_SPAN) {
    stepH = (LIST_STEP_H * LIST_SPAN) / rows;
    stepS = (LIST_STEP_S * LIST_SPAN) / rows;
    stepL = (LIST_STEP_L * LIST_SPAN) / rows;
  }
  const h = LIST_H + order * stepH;
  const s = Math.min(100, LIST_S + order * stepS);
  const l = Math.min(100, LIST_L + order * stepL);
  return [hsl(h, s, l + GRAD_L), hsl(h, s, l - GRAD_L)];
}

function grayRamp(order: number, rows: number, start: number, span: number): readonly [string, string] {
  const denominator = Math.max(1, Math.min(rows, 10) - 1);
  const center = start + Math.min(order, denominator) * span / denominator;
  return [hsl(0, 0, center + 2.5), hsl(0, 0, center - 2.5)];
}

export const CLEAR_COLOR_PALETTE: ClearPalette = {
  canvas: "#000000",
  foreground: "#ffffff",
  mutedForeground: "#ffffff40",
  disabledForeground: "#333333",
  edgeLight: "#ffffff12",
  edgeDark: "#0000001a",
  countCell: "#ffffff26",
  doneFrom: "#0c0c0c",
  doneTo: "#000000",
  doneText: "#666666",
  completeFrom: "#00b236",
  completeTo: "#009e30",
  completeIcon: "#ffffff",
  deleteIcon: "#eb0017",
  flapFrom: "#f50018",
  flapTo: "#e00016",
  todoRows: colorTodoRows,
  listRows: colorListRows,
  keyboard: {
    panelFrom: "#17191d",
    panelTo: "#0d0f12",
    divider: "#000000",
    char: ["#3a3f46", "#2d3138", "#5c626b", "#4b515a"],
    action: ["#24272c", "#1a1d21", "#3d4249", "#31363c"],
    engaged: ["#dfe2e6", "#c9cdd3", "#b7bcc3", "#a8adb5"],
    keyText: "#d3d7dc",
    engagedText: "#16181c",
    popupFrom: "#454b53",
    popupTo: "#34383f",
    popupBorder: "#101215",
  },
};

export const CLEAR_EINK_PALETTE: ClearPalette = {
  canvas: "#f2f2f2",
  foreground: "#ffffff",
  mutedForeground: "#555555",
  disabledForeground: "#aaaaaa",
  edgeLight: "#ffffff55",
  edgeDark: "#00000055",
  countCell: "#00000033",
  doneFrom: "#eeeeee",
  doneTo: "#d8d8d8",
  doneText: "#444444",
  completeFrom: "#1c1c1c",
  completeTo: "#080808",
  completeIcon: "#111111",
  deleteIcon: "#111111",
  flapFrom: "#343434",
  flapTo: "#202020",
  todoRows: (order, rows) => grayRamp(order, rows, 20, 24),
  listRows: (order, rows) => grayRamp(order, rows, 16, 30),
  keyboard: {
    panelFrom: "#303030",
    panelTo: "#181818",
    divider: "#000000",
    char: ["#555555", "#414141", "#777777", "#626262"],
    action: ["#333333", "#242424", "#505050", "#3f3f3f"],
    engaged: ["#eeeeee", "#d5d5d5", "#c5c5c5", "#b4b4b4"],
    keyText: "#ffffff",
    engagedText: "#111111",
    popupFrom: "#666666",
    popupTo: "#4a4a4a",
    popupBorder: "#111111",
  },
};

// Compatibility exports used by the existing color app and its tests.
export const DONE_FROM = CLEAR_COLOR_PALETTE.doneFrom;
export const DONE_TO = CLEAR_COLOR_PALETTE.doneTo;
export const DONE_TEXT = CLEAR_COLOR_PALETTE.doneText;
export const GREEN_FROM = CLEAR_COLOR_PALETTE.completeFrom;
export const GREEN_TO = CLEAR_COLOR_PALETTE.completeTo;
export function todoRowColors(order: number, pendingRows: number): readonly [string, string] {
  return colorTodoRows(order, pendingRows);
}
export function listRowColors(order: number, rows: number): readonly [string, string] {
  return colorListRows(order, rows);
}
