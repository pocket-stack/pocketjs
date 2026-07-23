// vapor/test/oracle.test.ts — VAPOR TODO under real Vue Vapor (the oracle).
//
// These tests pin the app's semantics on the reference implementation:
// vue 3.6 runtime-with-vapor over the micro-DOM, painted to the 30x20 grid.
// The ROM parity suite replays the same button tapes against the compiled
// .gba and compares grids cell-for-cell.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileVaporApp } from "../compiler/compile.ts";
import { Button } from "../host/input.ts";
import { bootOracle, type Oracle } from "../oracle/boot.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");
const styles = compileVaporApp(ENTRY, await Bun.file(ENTRY).text(), "VAPOR TODO", "gba").styles;
const boot = () => bootOracle({ styles });

function line(oracle: Awaited<ReturnType<typeof bootOracle>>, y: number): string {
  return oracle.grid().chars[y];
}

describe("vapor todo oracle", () => {
  test("boots with seed todos and computed header", async () => {
    const o = await boot();
    expect(line(o, 0)).toBe(("      POCKET VAPOR TODO").padEnd(30)); // align-center
    expect(line(o, 1)).toBe(" 2 LEFT / ALL".padEnd(30));
    expect(line(o, 3)).toBe(" >[ ] SHIP POCKET VAPOR".padEnd(30));
    expect(line(o, 4)).toBe("  [X] WRITE THE COMPILER".padEnd(30));
    expect(line(o, 5)).toBe("  [ ] RUN ON DEVICE".padEnd(30));
    expect(line(o, 19)).toBe(" A:DONE B:DEL R:FILT ST:NEW".padEnd(30));
    o.unmount();
  });

  test("cursor moves and toggle updates remaining", async () => {
    const o = await boot();
    await o.press(Button.Down);
    expect(line(o, 3)).toBe("  [ ] SHIP POCKET VAPOR".padEnd(30));
    expect(line(o, 4)).toBe(" >[X] WRITE THE COMPILER".padEnd(30));
    await o.press(Button.A); // un-done the second todo
    expect(line(o, 1)).toBe(" 3 LEFT / ALL".padEnd(30));
    expect(line(o, 4)).toBe(" >[ ] WRITE THE COMPILER".padEnd(30));
    o.unmount();
  });

  test("filters are a computed view", async () => {
    const o = await boot();
    await o.press(Button.R); // ACTIVE
    expect(line(o, 1)).toBe(" 2 LEFT / ACTIVE".padEnd(30));
    expect(line(o, 3)).toBe(" >[ ] SHIP POCKET VAPOR".padEnd(30));
    expect(line(o, 4)).toBe("  [ ] RUN ON DEVICE".padEnd(30));
    expect(line(o, 5)).toBe("".padEnd(30));
    await o.press(Button.R); // DONE
    expect(line(o, 1)).toBe(" 2 LEFT / DONE".padEnd(30));
    expect(line(o, 3)).toBe(" >[X] WRITE THE COMPILER".padEnd(30));
    await o.press(Button.R); // back to ALL
    expect(line(o, 1)).toBe(" 2 LEFT / ALL".padEnd(30));
    o.unmount();
  });

  test("delete, clear completed, and the empty state", async () => {
    const o = await boot();
    await o.press(Button.B); // delete first
    expect(line(o, 3)).toBe(" >[X] WRITE THE COMPILER".padEnd(30));
    await o.press(Button.Select); // clear completed
    expect(line(o, 3)).toBe(" >[ ] RUN ON DEVICE".padEnd(30));
    expect(line(o, 1)).toBe(" 1 LEFT / ALL".padEnd(30));
    await o.press(Button.B);
    expect(line(o, 3)).toBe(" NOTHING HERE".padEnd(30));
    o.unmount();
  });

  test("edit mode composes a todo through the glyph picker", async () => {
    const o = await boot();
    await o.press(Button.Start);
    expect(line(o, 17)).toBe(" NEW: [A]".padEnd(30));
    expect(line(o, 19)).toBe(" A:PUT B:DEL ST:SAVE SE:QUIT".padEnd(30));
    await o.press(Button.A); // put A
    await o.press(Button.Right); // glyph B
    await o.press(Button.A); // put B
    expect(line(o, 17)).toBe(" NEW: AB[B]".padEnd(30));
    await o.press(Button.B); // backspace
    expect(line(o, 17)).toBe(" NEW: A[B]".padEnd(30));
    await o.press(Button.Start); // save
    expect(line(o, 17)).toBe("".padEnd(30));
    expect(line(o, 6)).toBe("  [ ] A".padEnd(30));
    expect(line(o, 1)).toBe(" 3 LEFT / ALL".padEnd(30));
    o.unmount();
  });

  test("glyph picker wraps left from A to 9", async () => {
    const o = await boot();
    await o.press(Button.Start);
    await o.press(Button.Left);
    expect(line(o, 17)).toBe(" NEW: [9]".padEnd(30));
    await o.press(Button.Select); // cancel
    expect(line(o, 17)).toBe("".padEnd(30));
    o.unmount();
  });

  test("cursor clamps when the view shrinks", async () => {
    const o = await boot();
    await o.press(Button.Down);
    await o.press(Button.Down); // cursor on last
    await o.press(Button.B); // delete last -> cursor clamps to new last
    expect(line(o, 4)).toBe(" >[X] WRITE THE COMPILER".padEnd(30));
    o.unmount();
  });
});
