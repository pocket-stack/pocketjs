// vapor/compiler/boards.ts — AOT board profiles as data.
//
// A board file (vapor/boards/<name>.json) is the devicetree of a Pocket
// Vapor MCU target: panel, pins and logical-pad coverage. The runtime
// contract stays code (runtime/vapor.h + runtime/<chip>/); the board is
// pure data validated here, so adding a device means adding a JSON file and
// passing the physical verifier — never editing the compiler. See
// vapor/BOARDS.md for the scaling argument (execution classes, derived
// demands, admission).

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const BOARDS_DIR = join(import.meta.dir, "..", "boards");

/** Pocket pad names in Button-id order (mirrors vapor/host/input.ts). */
export const POCKET_PAD = [
  "a", "b", "select", "start", "right", "left", "up", "down", "r", "l",
] as const;
export type PocketButtonName = (typeof POCKET_PAD)[number];

/** The six physical keys the ESP32 runtime scans, in button_pins[] order. */
export const PAD_KEYS = ["up", "down", "left", "right", "a", "b"] as const;
export type PadKey = (typeof PAD_KEYS)[number];

/**
 * The chord decoder is FIXED in runtime/esp32/vapor_esp32.c (release-latched
 * pairs). A board does not invent chords; it declares which of the runtime's
 * chords its pad exposes, and validation pins the exact pairs so the data
 * can never drift from the C.
 */
export const RUNTIME_CHORDS: Readonly<Partial<Record<PocketButtonName, readonly [PadKey, PadKey]>>> = {
  start: ["a", "b"],
  select: ["left", "right"],
  r: ["up", "down"],
};

const LCD_CONTROLLERS = { ili934x: 1, st7789: 2, st7735: 3 } as const;
export type LcdController = keyof typeof LCD_CONTROLLERS;

export interface VaporBoard {
  board: string;
  title: string;
  chip: "esp32";
  lcd: {
    controller: LcdController;
    width: number;
    height: number;
    cell: readonly [number, number];
    madctl: number;
    pins: { sclk: number; mosi: number; cs: number; dc: number; rst: number; backlight: number };
  };
  input: {
    pins: Record<PadKey, number>;
    chorded: Partial<Record<PocketButtonName, readonly [PadKey, PadKey]>>;
    absent: readonly PocketButtonName[];
  };
}

export interface BoardIssue {
  code: string;
  severity: "error" | "warn";
  message: string;
}

class BoardError extends Error {
  constructor(name: string, message: string) {
    super(`board ${name}: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireInt(name: string, value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new BoardError(name, `${what} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  return value;
}

/** Validate a raw board document; throws a descriptive error on any defect. */
export function parseBoard(name: string, raw: unknown): VaporBoard {
  if (!isRecord(raw)) throw new BoardError(name, "document must be a JSON object");
  if (raw.board !== name)
    throw new BoardError(name, `"board" must equal the file name, got ${JSON.stringify(raw.board)}`);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new BoardError(name, "board names are lowercase kebab-case");
  if (typeof raw.title !== "string" || raw.title.length === 0)
    throw new BoardError(name, '"title" must be a non-empty string');
  if (raw.chip !== "esp32")
    throw new BoardError(name, `the only board runtime today is "esp32", got ${JSON.stringify(raw.chip)}`);

  const lcd = raw.lcd;
  if (!isRecord(lcd)) throw new BoardError(name, '"lcd" must be an object');
  if (typeof lcd.controller !== "string" || !(lcd.controller in LCD_CONTROLLERS))
    throw new BoardError(name, `lcd.controller must be one of ${Object.keys(LCD_CONTROLLERS).join(", ")}`);
  const width = requireInt(name, lcd.width, "lcd.width", 1, 1024);
  const height = requireInt(name, lcd.height, "lcd.height", 1, 1024);
  if (!Array.isArray(lcd.cell) || lcd.cell.length !== 2)
    throw new BoardError(name, "lcd.cell must be [width, height]");
  const cell = [
    requireInt(name, lcd.cell[0], "lcd.cell[0]", 1, 32),
    requireInt(name, lcd.cell[1], "lcd.cell[1]", 1, 32),
  ] as const;
  const madctl = requireInt(name, lcd.madctl, "lcd.madctl", 0, 255);
  const rawLcdPins = lcd.pins;
  if (!isRecord(rawLcdPins)) throw new BoardError(name, "lcd.pins must be an object");
  const lcdPinNames = ["sclk", "mosi", "cs", "dc", "rst", "backlight"] as const;
  for (const extra of Object.keys(rawLcdPins))
    if (!(lcdPinNames as readonly string[]).includes(extra))
      throw new BoardError(name, `unknown lcd pin ${JSON.stringify(extra)}`);
  const lcdPins = Object.fromEntries(
    lcdPinNames.map((pin) => {
      const wired = pin === "sclk" || pin === "mosi" || pin === "cs" || pin === "dc";
      return [pin, requireInt(name, rawLcdPins[pin], `lcd.pins.${pin}`, wired ? 0 : -1, 48)];
    }),
  ) as VaporBoard["lcd"]["pins"];

  const input = raw.input;
  if (!isRecord(input)) throw new BoardError(name, '"input" must be an object');
  const rawPadPins = input.pins;
  if (!isRecord(rawPadPins)) throw new BoardError(name, '"input.pins" must be an object');
  for (const extra of Object.keys(rawPadPins))
    if (!(PAD_KEYS as readonly string[]).includes(extra))
      throw new BoardError(name, `unknown input pin ${JSON.stringify(extra)}`);
  // button_pins[] in the C runtime is positional over all six keys, so a
  // board must wire the full pad; boards with fewer keys need the runtime
  // taught first.
  const pins = Object.fromEntries(
    PAD_KEYS.map((key) => [key, requireInt(name, rawPadPins[key], `input.pins.${key}`, 0, 48)]),
  ) as Record<PadKey, number>;

  const chorded: VaporBoard["input"]["chorded"] = {};
  if (input.chorded !== undefined) {
    if (!isRecord(input.chorded)) throw new BoardError(name, '"input.chorded" must be an object');
    for (const [button, pair] of Object.entries(input.chorded)) {
      const runtimePair = RUNTIME_CHORDS[button as PocketButtonName];
      if (!runtimePair)
        throw new BoardError(name, `the esp32 runtime has no chord for ${JSON.stringify(button)}`);
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== runtimePair[0] || pair[1] !== runtimePair[1])
        throw new BoardError(
          name,
          `chord for "${button}" must be ${JSON.stringify(runtimePair)} (fixed by vapor_esp32.c), got ${JSON.stringify(pair)}`,
        );
      chorded[button as PocketButtonName] = runtimePair;
    }
  }

  const absent: PocketButtonName[] = [];
  if (input.absent !== undefined) {
    if (!Array.isArray(input.absent)) throw new BoardError(name, '"input.absent" must be an array');
    for (const button of input.absent) {
      if (!(POCKET_PAD as readonly string[]).includes(button))
        throw new BoardError(name, `unknown pocket button ${JSON.stringify(button)} in input.absent`);
      absent.push(button as PocketButtonName);
    }
  }

  // Every pocket button must be accounted for exactly once: direct pad key,
  // runtime chord, or declared absent. Silence is how coverage claims rot.
  for (const button of POCKET_PAD) {
    const spellings = [
      (PAD_KEYS as readonly string[]).includes(button),
      button in chorded,
      absent.includes(button),
    ].filter(Boolean).length;
    if (spellings !== 1)
      throw new BoardError(
        name,
        `pocket button "${button}" must have exactly one spelling (direct pad key, chord, or absent), found ${spellings}`,
      );
  }

  return {
    board: name,
    title: raw.title,
    chip: "esp32",
    lcd: { controller: lcd.controller as LcdController, width, height, cell, madctl, pins: lcdPins },
    input: { pins, chorded, absent },
  };
}

export function loadBoard(name: string): VaporBoard {
  const path = join(BOARDS_DIR, `${name}.json`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new BoardError(name, `no board file at ${path} (known: ${listBoards().join(", ")})`);
  }
  return parseBoard(name, JSON.parse(text));
}

export function listBoards(): string[] {
  return readdirSync(BOARDS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => basename(file, ".json"))
    .sort();
}

/**
 * Derive the compile definitions the ESP-IDF build injects. This is the
 * board's whole codegen surface — and the board half of esp32BuildId, so
 * the derivation must stay byte-stable for a given board file.
 */
export function boardDefinitions(board: VaporBoard): string[] {
  const { lcd, input } = board;
  return [
    `VP_ESP32_BOARD=\\"${board.board}\\"`,
    "VP_LCD_ENABLED=1",
    `VP_LCD_CONTROLLER=${LCD_CONTROLLERS[lcd.controller]}`,
    `VP_LCD_WIDTH=${lcd.width}`,
    `VP_LCD_HEIGHT=${lcd.height}`,
    `VP_LCD_CELL_W=${lcd.cell[0]}`,
    `VP_LCD_CELL_H=${lcd.cell[1]}`,
    `VP_LCD_MADCTL=0x${lcd.madctl.toString(16)}`,
    `VP_LCD_SCLK=${lcd.pins.sclk}`,
    `VP_LCD_MOSI=${lcd.pins.mosi}`,
    `VP_LCD_CS=${lcd.pins.cs}`,
    `VP_LCD_DC=${lcd.pins.dc}`,
    `VP_LCD_RST=${lcd.pins.rst}`,
    `VP_LCD_BL=${lcd.pins.backlight}`,
    `VP_BUTTON_COUNT=${PAD_KEYS.length}`,
    `VP_BUTTON_UP=${input.pins.up}`,
    `VP_BUTTON_DOWN=${input.pins.down}`,
    `VP_BUTTON_LEFT=${input.pins.left}`,
    `VP_BUTTON_RIGHT=${input.pins.right}`,
    `VP_BUTTON_A=${input.pins.a}`,
    `VP_BUTTON_B=${input.pins.b}`,
  ];
}

/** What one compiled app demands of a board (derived, never authored). */
export interface AppDemands {
  /** Button ids the source statically references (keymap keys + Button.X). */
  buttonsUsed: readonly number[];
}

/**
 * The aot-class admission rule: derived demands ⊨ board profile. Errors
 * refuse the pairing; warnings flag interaction-quality degradation (a
 * button only reachable as a two-key chord), the VS104 of input.
 */
export function admitBoard(
  demands: AppDemands,
  board: VaporBoard,
  grid: { width: number; height: number },
): BoardIssue[] {
  const issues: BoardIssue[] = [];
  const physW = grid.width * board.lcd.cell[0];
  const physH = grid.height * board.lcd.cell[1];
  if (physW > board.lcd.width || physH > board.lcd.height) {
    issues.push({
      code: "VB101",
      severity: "error",
      message: `${grid.width}x${grid.height} cells of ${board.lcd.cell[0]}x${board.lcd.cell[1]} px need ${physW}x${physH}, panel is ${board.lcd.width}x${board.lcd.height}`,
    });
  }
  for (const id of demands.buttonsUsed) {
    const button = POCKET_PAD[id];
    if (button === undefined) {
      issues.push({ code: "VB102", severity: "error", message: `unknown button id ${id} in demands` });
      continue;
    }
    if ((PAD_KEYS as readonly string[]).includes(button)) continue;
    if (button in board.input.chorded) {
      const pair = board.input.chorded[button]!;
      issues.push({
        code: "VB103",
        severity: "warn",
        message: `"${button}" is only reachable as the ${pair[0]}+${pair[1]} chord on ${board.board}`,
      });
      continue;
    }
    issues.push({
      code: "VB102",
      severity: "error",
      message: `app uses "${button}" but ${board.board} has no mapping for it`,
    });
  }
  return issues;
}
