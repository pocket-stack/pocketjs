// Board profiles are data with a contract: the loader must refuse malformed
// or incomplete boards, the derived compile definitions must stay
// byte-stable (they are the board half of esp32BuildId), and the admission
// rule must judge demands the way BOARDS.md promises.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  admitBoard,
  boardDefinitions,
  listBoards,
  loadBoard,
  parseBoard,
  POCKET_PAD,
  RUNTIME_CHORDS,
} from "../compiler/boards.ts";
import { compileVaporApp, VAPOR_TARGETS } from "../compiler/compile.ts";
import { Button } from "../host/input.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");
const P4_BOARD = "waveshare-esp32-p4-wifi6-touch-lcd-7b";

function meowbitRaw(): any {
  return {
    board: "meowbit",
    title: "Xueersi/KittenBot MeowBit",
    chip: "esp32",
    lcd: {
      controller: "st7735",
      width: 160,
      height: 128,
      cell: [8, 7],
      madctl: 96,
      pins: { sclk: 18, mosi: 23, cs: 5, dc: 4, rst: -1, backlight: -1 },
    },
    input: {
      pins: { up: 2, down: 13, left: 27, right: 35, a: 34, b: 12 },
      chorded: { start: ["a", "b"], select: ["left", "right"], r: ["up", "down"] },
      absent: ["l"],
    },
  };
}

function p4Raw(): any {
  return {
    board: P4_BOARD,
    title: "Waveshare ESP32-P4-WIFI6-Touch-LCD-7B",
    chip: "esp32p4",
    lcd: {
      bsp: P4_BOARD,
      controller: "ek79007",
      width: 1024,
      height: 600,
      cell: [30, 30],
    },
    input: {
      kind: "touch",
      controller: "gt911",
      virtualButtons: ["a", "b", "select", "start", "right", "left", "up", "down", "r"],
      absent: ["l"],
    },
  };
}

describe("board registry", () => {
  test("POCKET_PAD mirrors the Button ids apps compile against", () => {
    for (const [name, id] of Object.entries(Button) as [string, number][]) {
      expect(POCKET_PAD[id]).toBe(name.toLowerCase() as (typeof POCKET_PAD)[number]);
    }
  });

  test("meowbit is a registered, loadable board", () => {
    expect(listBoards()).toContain("meowbit");
    const board = loadBoard("meowbit");
    expect(board.title).toBe("Xueersi/KittenBot MeowBit");
    expect(board.input.absent).toEqual(["l"]);
  });

  test("Waveshare ESP32-P4 is a registered, chip-tagged BSP board", () => {
    expect(listBoards()).toContain(P4_BOARD);
    const board = loadBoard(P4_BOARD);
    expect(board.chip).toBe("esp32p4");
    if (board.chip !== "esp32p4") throw new Error("chip discriminator did not narrow the board");
    expect(board.lcd).toEqual({
      bsp: P4_BOARD,
      controller: "ek79007",
      width: 1024,
      height: 600,
      cell: [30, 30],
    });
    expect(board.input).toEqual({
      kind: "touch",
      controller: "gt911",
      virtualButtons: ["a", "b", "select", "start", "right", "left", "up", "down", "r"],
      absent: ["l"],
    });
    expect(board.input.virtualButtons.map((button) => POCKET_PAD.indexOf(button))).toEqual([
      Button.A,
      Button.B,
      Button.Select,
      Button.Start,
      Button.Right,
      Button.Left,
      Button.Up,
      Button.Down,
      Button.R,
    ]);
  });

  test("meowbit derives the exact definitions PR #154 flashed (buildId stability)", () => {
    // This list is the board half of esp32BuildId. If this test breaks, the
    // firmware identity of every flashed MeowBit changes with it — that must
    // be a deliberate act, not a refactor side effect.
    expect(boardDefinitions(loadBoard("meowbit"))).toEqual([
      'VP_ESP32_BOARD=\\"meowbit\\"',
      "VP_LCD_ENABLED=1",
      "VP_LCD_CONTROLLER=3",
      "VP_LCD_WIDTH=160",
      "VP_LCD_HEIGHT=128",
      "VP_LCD_CELL_W=8",
      "VP_LCD_CELL_H=7",
      "VP_LCD_MADCTL=0x60",
      "VP_LCD_SCLK=18",
      "VP_LCD_MOSI=23",
      "VP_LCD_CS=5",
      "VP_LCD_DC=4",
      "VP_LCD_RST=-1",
      "VP_LCD_BL=-1",
      "VP_BUTTON_COUNT=6",
      "VP_BUTTON_UP=2",
      "VP_BUTTON_DOWN=13",
      "VP_BUTTON_LEFT=27",
      "VP_BUTTON_RIGHT=35",
      "VP_BUTTON_A=34",
      "VP_BUTTON_B=12",
    ]);
  });

  test("ESP32-P4 definitions carry stable BSP identity without fake GPIO buttons", () => {
    const definitions = boardDefinitions(loadBoard(P4_BOARD));
    expect(definitions).toEqual([
      `VP_BOARD_ID=\\"${P4_BOARD}\\"`,
      'VP_CHIP_ID=\\"esp32p4\\"',
      `VP_BSP_ID=\\"${P4_BOARD}\\"`,
      'VP_PANEL_ID=\\"ek79007\\"',
      "VP_LCD_WIDTH=1024",
      "VP_LCD_HEIGHT=600",
      "VP_LCD_CELL_W=30",
      "VP_LCD_CELL_H=30",
      'VP_TOUCH_ID=\\"gt911\\"',
      "VP_TOUCH_BUTTON_MASK=0x1ff",
      "VP_ABSENT_BUTTON_MASK=0x200",
    ]);
    expect(definitions.some((definition) => /VP_BUTTON_(?:UP|DOWN|LEFT|RIGHT|A|B)=/.test(definition))).toBe(false);
  });

  test("rejects a chord the runtime does not decode", () => {
    const raw = meowbitRaw();
    raw.input.chorded.start = ["a", "up"];
    expect(() => parseBoard("meowbit", raw)).toThrow(/fixed by vapor_esp32\.c/);
    delete raw.input.chorded.start;
    raw.input.chorded.l = RUNTIME_CHORDS.start;
    expect(() => parseBoard("meowbit", raw)).toThrow(/no chord for "l"/);
  });

  test("rejects silent pad coverage gaps and double spellings", () => {
    const gap = meowbitRaw();
    gap.input.absent = []; // "l" now has no spelling
    expect(() => parseBoard("meowbit", gap)).toThrow(/"l" must have exactly one spelling.*found 0/);

    const doubled = meowbitRaw();
    doubled.input.absent = ["l", "start"]; // start is also chorded
    expect(() => parseBoard("meowbit", doubled)).toThrow(/"start" must have exactly one spelling.*found 2/);
  });

  test("rejects missing pins, bad chips, and mismatched names", () => {
    const unwired = meowbitRaw();
    delete unwired.input.pins.a;
    expect(() => parseBoard("meowbit", unwired)).toThrow(/input\.pins\.a/);

    const chip = meowbitRaw();
    chip.chip = "rp2040";
    expect(() => parseBoard("meowbit", chip)).toThrow(/chip must be "esp32" or "esp32p4"/);

    expect(() => parseBoard("other-name", meowbitRaw())).toThrow(/"board" must equal the file name/);
  });

  test("rejects malformed or GPIO-shaped ESP32-P4 profiles", () => {
    const bsp = p4Raw();
    bsp.lcd.bsp = "some-other-board";
    expect(() => parseBoard(P4_BOARD, bsp)).toThrow(/lcd\.bsp must be/);

    const panel = p4Raw();
    panel.lcd.controller = "st7789";
    expect(() => parseBoard(P4_BOARD, panel)).toThrow(/lcd\.controller must be "ek79007"/);

    const geometry = p4Raw();
    geometry.lcd.width = 800;
    expect(() => parseBoard(P4_BOARD, geometry)).toThrow(/ek79007 BSP panel must be 1024x600/);

    const cell = p4Raw();
    cell.lcd.cell = [31, 30];
    expect(() => parseBoard(P4_BOARD, cell)).toThrow(/touch layout requires lcd\.cell \[30, 30\]/);

    const touch = p4Raw();
    touch.input.controller = "ft5x06";
    expect(() => parseBoard(P4_BOARD, touch)).toThrow(/input\.controller must be "gt911"/);

    const fakeGpio = p4Raw();
    fakeGpio.input.pins = { up: 1 };
    expect(() => parseBoard(P4_BOARD, fakeGpio)).toThrow(/unknown input field "pins"/);

    const unknown = p4Raw();
    unknown.lcd.rotation = 90;
    expect(() => parseBoard(P4_BOARD, unknown)).toThrow(/unknown lcd field "rotation"/);
  });

  test("rejects gaps, overlaps, duplicates, and unknown P4 virtual buttons", () => {
    const gap = p4Raw();
    gap.input.virtualButtons = gap.input.virtualButtons.filter((button: string) => button !== "r");
    expect(() => parseBoard(P4_BOARD, gap)).toThrow(/"r" must have exactly one spelling.*found 0/);

    const overlap = p4Raw();
    overlap.input.absent = ["l", "r"];
    expect(() => parseBoard(P4_BOARD, overlap)).toThrow(/"r" must have exactly one spelling.*found 2/);

    const duplicate = p4Raw();
    duplicate.input.virtualButtons.push("a");
    expect(() => parseBoard(P4_BOARD, duplicate)).toThrow(/duplicate pocket button "a"/);

    const unknown = p4Raw();
    unknown.input.virtualButtons[0] = "home";
    expect(() => parseBoard(P4_BOARD, unknown)).toThrow(/unknown pocket button "home"/);

    const runtimeDrift = p4Raw();
    runtimeDrift.input.virtualButtons[8] = "l";
    runtimeDrift.input.absent = ["r"];
    expect(() => parseBoard(P4_BOARD, runtimeDrift)).toThrow(/virtualButtons must match.*touch layout/);
  });
});

describe("aot admission: derived demands vs board profile", () => {
  const board = loadBoard("meowbit");
  const grid = VAPOR_TARGETS.esp32;

  test("todo admits onto meowbit with exactly the three chord warnings", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "esp32");
    expect(app.buttonsUsed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]); // everything but L
    const issues = admitBoard({ buttonsUsed: app.buttonsUsed }, board, grid);
    expect(issues.map((issue) => [issue.code, issue.severity])).toEqual([
      ["VB103", "warn"],
      ["VB103", "warn"],
      ["VB103", "warn"],
    ]);
  });

  test("a demand for an unmapped button is refused", () => {
    const issues = admitBoard({ buttonsUsed: [Button.L] }, board, grid);
    expect(issues).toEqual([
      {
        code: "VB102",
        severity: "error",
        message: 'app uses "l" but meowbit has no mapping for it',
      },
    ]);
  });

  test("a grid the panel cannot host is refused", () => {
    const issues = admitBoard({ buttonsUsed: [] }, board, { width: 30, height: 20 });
    expect(issues.map((issue) => issue.code)).toEqual(["VB101"]);
  });

  test("todo admits on the P4 through GT911 virtual Button coverage", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source, "VAPOR TODO", "esp32");
    expect(app.buttonsUsed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(admitBoard({ buttonsUsed: app.buttonsUsed }, loadBoard(P4_BOARD), grid)).toEqual([]);
  });

  test("P4 refuses absent L and grids larger than its declared 30px cells", () => {
    const board = loadBoard(P4_BOARD);
    expect(admitBoard({ buttonsUsed: [Button.L] }, board, grid)).toEqual([
      {
        code: "VB102",
        severity: "error",
        message: `app uses "l" but ${P4_BOARD} has no mapping for it`,
      },
    ]);
    expect(admitBoard({ buttonsUsed: [] }, board, { width: 35, height: 18 })[0]).toMatchObject({
      code: "VB101",
      severity: "error",
    });
  });
});
