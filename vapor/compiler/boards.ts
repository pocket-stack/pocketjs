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

const ESP32P4_BSP = "waveshare-esp32-p4-wifi6-touch-lcd-7b" as const;
const ESP32P4_PANEL = { controller: "ek79007", width: 1024, height: 600, cell: [30, 30] } as const;
export const ESP32P4_VIRTUAL_BUTTONS = [
  "a", "b", "select", "start", "right", "left", "up", "down", "r",
] as const satisfies readonly PocketButtonName[];

export interface Esp32Board {
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

export interface Esp32P4Board {
  board: string;
  title: string;
  chip: "esp32p4";
  lcd: {
    /** Board-support package selected by the ESP32-P4 host. */
    bsp: typeof ESP32P4_BSP;
    controller: "ek79007";
    width: 1024;
    height: 600;
    cell: readonly [30, 30];
  };
  input: {
    kind: "touch";
    controller: "gt911";
    /** Pocket buttons exposed by the host's on-screen controls. */
    virtualButtons: readonly PocketButtonName[];
    absent: readonly PocketButtonName[];
  };
}

/** Chip is the discriminator because it selects a different ESP-IDF host. */
export type VaporBoard = Esp32Board | Esp32P4Board;

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

function requireKnownKeys(
  name: string,
  value: Record<string, unknown>,
  what: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new BoardError(name, `unknown ${what} field ${JSON.stringify(key)}`);
  }
}

function requireButtonList(name: string, value: unknown, what: string): PocketButtonName[] {
  if (!Array.isArray(value)) throw new BoardError(name, `${what} must be an array`);
  const buttons: PocketButtonName[] = [];
  for (const button of value) {
    if (!(POCKET_PAD as readonly unknown[]).includes(button))
      throw new BoardError(name, `unknown pocket button ${JSON.stringify(button)} in ${what}`);
    if (buttons.includes(button as PocketButtonName))
      throw new BoardError(name, `duplicate pocket button ${JSON.stringify(button)} in ${what}`);
    buttons.push(button as PocketButtonName);
  }
  return buttons;
}

function requireInt(name: string, value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new BoardError(name, `${what} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  return value;
}

/** Validate a raw board document; throws a descriptive error on any defect. */
export function parseBoard(name: string, raw: unknown): VaporBoard {
  if (!isRecord(raw)) throw new BoardError(name, "document must be a JSON object");
  requireKnownKeys(name, raw, "board", ["board", "title", "chip", "lcd", "input"]);
  if (raw.board !== name)
    throw new BoardError(name, `"board" must equal the file name, got ${JSON.stringify(raw.board)}`);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new BoardError(name, "board names are lowercase kebab-case");
  if (typeof raw.title !== "string" || raw.title.length === 0)
    throw new BoardError(name, '"title" must be a non-empty string');
  if (raw.chip !== "esp32" && raw.chip !== "esp32p4")
    throw new BoardError(name, `chip must be "esp32" or "esp32p4", got ${JSON.stringify(raw.chip)}`);

  const lcd = raw.lcd;
  if (!isRecord(lcd)) throw new BoardError(name, '"lcd" must be an object');

  if (raw.chip === "esp32p4") {
    requireKnownKeys(name, lcd, "lcd", ["bsp", "controller", "width", "height", "cell"]);
    if (lcd.bsp !== ESP32P4_BSP)
      throw new BoardError(
        name,
        `lcd.bsp must be "${ESP32P4_BSP}", got ${JSON.stringify(lcd.bsp)}`,
      );
    if (lcd.controller !== ESP32P4_PANEL.controller)
      throw new BoardError(
        name,
        `lcd.controller must be "${ESP32P4_PANEL.controller}", got ${JSON.stringify(lcd.controller)}`,
      );
    const width = requireInt(name, lcd.width, "lcd.width", 1, 4096);
    const height = requireInt(name, lcd.height, "lcd.height", 1, 4096);
    if (width !== ESP32P4_PANEL.width || height !== ESP32P4_PANEL.height)
      throw new BoardError(
        name,
        `the ${ESP32P4_PANEL.controller} BSP panel must be ${ESP32P4_PANEL.width}x${ESP32P4_PANEL.height}, got ${width}x${height}`,
      );
    if (!Array.isArray(lcd.cell) || lcd.cell.length !== 2)
      throw new BoardError(name, "lcd.cell must be [width, height]");
    const cell = [
      requireInt(name, lcd.cell[0], "lcd.cell[0]", 1, 256),
      requireInt(name, lcd.cell[1], "lcd.cell[1]", 1, 256),
    ] as const;
    if (cell[0] !== ESP32P4_PANEL.cell[0] || cell[1] !== ESP32P4_PANEL.cell[1])
      throw new BoardError(
        name,
        `the ${ESP32P4_BSP} touch layout requires lcd.cell [${ESP32P4_PANEL.cell.join(", ")}], got ${JSON.stringify(cell)}`,
      );

    const input = raw.input;
    if (!isRecord(input)) throw new BoardError(name, '"input" must be an object');
    requireKnownKeys(name, input, "input", ["kind", "controller", "virtualButtons", "absent"]);
    if (input.kind !== "touch")
      throw new BoardError(name, `input.kind must be "touch", got ${JSON.stringify(input.kind)}`);
    if (input.controller !== "gt911")
      throw new BoardError(name, `input.controller must be "gt911", got ${JSON.stringify(input.controller)}`);
    const virtualButtons = requireButtonList(name, input.virtualButtons, "input.virtualButtons");
    const absent = requireButtonList(name, input.absent, "input.absent");

    for (const button of POCKET_PAD) {
      const spellings = [virtualButtons.includes(button), absent.includes(button)].filter(Boolean).length;
      if (spellings !== 1)
        throw new BoardError(
          name,
          `pocket button "${button}" must have exactly one spelling (virtual button or absent), found ${spellings}`,
        );
    }
    if (
      virtualButtons.length !== ESP32P4_VIRTUAL_BUTTONS.length ||
      ESP32P4_VIRTUAL_BUTTONS.some((button) => !virtualButtons.includes(button))
    )
      throw new BoardError(
        name,
        `input.virtualButtons must match the ${ESP32P4_BSP} touch layout ${JSON.stringify(ESP32P4_VIRTUAL_BUTTONS)}`,
      );

    return {
      board: name,
      title: raw.title,
      chip: "esp32p4",
      lcd: {
        bsp: ESP32P4_BSP,
        controller: ESP32P4_PANEL.controller,
        width,
        height,
        cell: ESP32P4_PANEL.cell,
      },
      input: { kind: "touch", controller: "gt911", virtualButtons, absent },
    };
  }

  requireKnownKeys(name, lcd, "lcd", ["controller", "width", "height", "cell", "madctl", "pins"]);
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
  ) as Esp32Board["lcd"]["pins"];

  const input = raw.input;
  if (!isRecord(input)) throw new BoardError(name, '"input" must be an object');
  requireKnownKeys(name, input, "input", ["pins", "chorded", "absent"]);
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

  const chorded: Esp32Board["input"]["chorded"] = {};
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

  const absent = input.absent === undefined ? [] : requireButtonList(name, input.absent, "input.absent");

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
  if (board.chip === "esp32p4") {
    const virtualMask = board.input.virtualButtons.reduce(
      (mask, button) => mask | (1 << POCKET_PAD.indexOf(button)),
      0,
    );
    const absentMask = board.input.absent.reduce(
      (mask, button) => mask | (1 << POCKET_PAD.indexOf(button)),
      0,
    );
    return [
      `VP_BOARD_ID=\\"${board.board}\\"`,
      `VP_CHIP_ID=\\"${board.chip}\\"`,
      `VP_BSP_ID=\\"${board.lcd.bsp}\\"`,
      `VP_PANEL_ID=\\"${board.lcd.controller}\\"`,
      `VP_LCD_WIDTH=${board.lcd.width}`,
      `VP_LCD_HEIGHT=${board.lcd.height}`,
      `VP_LCD_CELL_W=${board.lcd.cell[0]}`,
      `VP_LCD_CELL_H=${board.lcd.cell[1]}`,
      `VP_TOUCH_ID=\\"${board.input.controller}\\"`,
      `VP_TOUCH_BUTTON_MASK=0x${virtualMask.toString(16)}`,
      `VP_ABSENT_BUTTON_MASK=0x${absentMask.toString(16)}`,
    ];
  }

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
    if (board.chip === "esp32p4") {
      if (board.input.virtualButtons.includes(button)) continue;
      issues.push({
        code: "VB102",
        severity: "error",
        message: `app uses "${button}" but ${board.board} has no mapping for it`,
      });
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
