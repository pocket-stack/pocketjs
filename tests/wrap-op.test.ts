// tests/wrap-op.test.ts — the wrapText op (spec op 43) against the JS greedy
// fallback (apps/desk98/notepad.ts wrapLine). On a baked host both reduce to
// the same additive atlas advances, so their break columns must agree
// column-for-column — this is the parity that lets apps use the op when
// present and the JS rules when not, without the layout ever moving.
//
// Runs on the wasm core with desk98's committed W95FA atlas (slot 19) — the
// real consumer's font, spaces and CJK-free ASCII plus over-wide tokens.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { segsFromBreaks, wrapLine } from "../apps/desk98/notepad.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const WASM_PATH = join(ROOT, "hosts/web/pocketjs.wasm");

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) throw new Error(`wrap-op: failed to produce ${path}`);
}

const SLOT = 19;
let ops: {
  loadFontAtlas(buf: Uint8Array): void;
  measureText(s: string, slot: number): number;
  wrapText?(s: string, slot: number, maxW: number): number[];
};

beforeAll(async () => {
  ensureBuilt(WASM_PATH, [process.execPath, "tools/wasm.ts"]);
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  ops = wasm.ops;
  const atlas = await Bun.file(join(ROOT, "apps/desk98/fonts/w95fa-19.bin")).arrayBuffer();
  ops.loadFontAtlas(new Uint8Array(atlas));
});

const SAMPLES = [
  "",
  "Welcome to PocketJS 98.",
  "This desktop is one PocketJS guest: the windows, the taskbar, the Start menu and this Notepad are Vue Vapor JSX over the same DrawList contract the consoles boot, painted by the gpui backend.",
  "  - drag-select this text; Cmd+C/X/V, right-click",
  "word",
  "spaces      hang    at   soft   breaks      ",
  "averyveryverylongunbreakabletokenthatmustcharsplitacrossrows plus a tail",
  "a b c d e f g h i j k l m n o p q r s t u v w x y z",
];
const WIDTHS = [24, 60, 120, 200, 388];

describe("wrapText op ↔ JS fallback parity", () => {
  test("the op exists on the wasm host", () => {
    expect(typeof ops.wrapText).toBe("function");
  });

  test("break columns agree with the greedy JS rules for every sample", () => {
    const width = (s: string) => ops.measureText(s, SLOT);
    for (const line of SAMPLES) {
      for (const maxW of WIDTHS) {
        const opBreaks = ops.wrapText!(line, SLOT, maxW);
        const jsBreaks = wrapLine(line, maxW, width)
          .slice(1)
          .map((s) => s.from);
        expect({ line, maxW, breaks: opBreaks }).toEqual({ line, maxW, breaks: jsBreaks });
        // Segments rebuilt from the op tile the line exactly.
        const segs = segsFromBreaks(line.length, opBreaks);
        expect(segs[0].from).toBe(0);
        expect(segs[segs.length - 1].to).toBe(line.length);
        for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBe(segs[i - 1].to);
      }
    }
  });

  test("fitting lines and empty text produce no breaks", () => {
    expect(ops.wrapText!("", SLOT, 100)).toEqual([]);
    expect(ops.wrapText!("short", SLOT, 10000)).toEqual([]);
  });
});
