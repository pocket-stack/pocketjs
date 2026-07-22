// vapor/tests/styles.test.ts — the class DSL: parsing, pair allocation,
// per-target lowering, and the compile-time diagnostics matrix.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileVaporApp } from "../compiler/compile.ts";
import { parseRowClass, styleOfPair, StyleTable } from "../compiler/styles.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");

const HEADER = `
import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
`;

function app(rowJsx: string): string {
  return `${HEADER}
export default () => {
  const count = ref(0);
  onButton((b) => {
    if (b === Button.A) count.value = count.value + 1;
  });
  return (
    <>
      ${rowJsx}
    </>
  );
};
`;
}

describe("class parsing", () => {
  test("tailwind colors resolve through the framework palette", () => {
    const { style, issues } = parseRowClass("bg-emerald-500 text-slate-950 align-center");
    expect(issues).toEqual([]);
    expect(style.paper).toBe(0x10b981);
    expect(style.ink).toBe(0x020617);
    expect(style.align).toBe(1);
  });

  test("arbitrary hex colors work", () => {
    const { style } = parseRowClass("bg-[#101423] text-[#fff]");
    expect(style.paper).toBe(0x101423);
    expect(style.ink).toBe(0xffffff);
  });

  test("unknown classes and colors are issues", () => {
    expect(parseRowClass("flex").issues[0].code).toBe("VS101");
    expect(parseRowClass("bg-vermillion-500").issues[0].code).toBe("VS102");
  });
});

describe("per-target lowering", () => {
  test("styles2 maps pairs by luminance polarity", () => {
    expect(styleOfPair({ ink: 0x000000, paper: 0xffffff })).toBe(0); // dark on light
    expect(styleOfPair({ ink: 0xffffff, paper: 0x101423 })).toBe(1); // light on dark
  });

  test("collapsing pairs is a warning, an error under strict", () => {
    const table = new StyleTable();
    table.resolveClass("text-white");
    table.resolveClass("text-emerald-400"); // both light-on-dark
    expect(table.lower("gb").issues.some((i) => i.code === "VS104" && i.severity === "warn")).toBe(true);
    expect(table.lower("gb", true).issues.some((i) => i.code === "VS104" && i.severity === "error")).toBe(true);
    expect(table.lower("gba").issues).toEqual([]);
  });
});

describe("compile-time style diagnostics", () => {
  test("unknown class fails the build with file:line", () => {
    expect(() => compileVaporApp("t.tsx", app('<row y={0} class="flexbox">{count.value}</row>')))
      .toThrow(/VS101/);
  });

  test("gba palette-bank budget is enforced", () => {
    const rows = Array.from({ length: 16 }, (_, i) =>
      `<row y={${i}} class="bg-[#0000${(i + 1).toString(16).padStart(2, "0")}]">{count.value}</row>`,
    ).join("\n      ");
    expect(() => compileVaporApp("t.tsx", app(rows), "T", "gba")).toThrow(/VS103/);
    // the same 16 pairs are fine on a 2-style target (they just collapse)
    expect(() => compileVaporApp("t.tsx", app(rows), "T", "gb")).not.toThrow();
  });

  test("strict escalates lossy lowering on 2-style targets", () => {
    const source = app(
      '<row y={0} class="text-emerald-400">{count.value}</row>\n      <row y={1} class="text-sky-400">{count.value}</row>',
    );
    expect(() => compileVaporApp("t.tsx", source, "T", "gb")).not.toThrow();
    expect(() => compileVaporApp("t.tsx", source, "T", "gb", { strict: true })).toThrow(/VS104/);
  });

  test("dynamic class must be a ternary of literals", () => {
    expect(() =>
      compileVaporApp("t.tsx", app('<row y={0} class={"bg-" + "white"}>{count.value}</row>')),
    ).toThrow(/VS105/);
  });

  test("the pal attribute is rejected with a migration hint", () => {
    expect(() => compileVaporApp("t.tsx", app("<row y={0} pal={1}>{count.value}</row>"))).toThrow(/class=/);
  });

  test("the todo app carries expected collapse warnings on gb, none on gba", () => {
    const source = Bun.file(ENTRY);
    return source.text().then((text) => {
      const gba = compileVaporApp(ENTRY, text, "VAPOR TODO", "gba");
      expect(gba.diagnostics).toEqual([]);
      const gb = compileVaporApp(ENTRY, text, "VAPOR TODO", "gb");
      expect(gb.diagnostics.some((d) => d.includes("VS104"))).toBe(true);
    });
  });
});
