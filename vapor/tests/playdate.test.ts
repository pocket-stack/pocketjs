import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileVaporApp, VAPOR_TARGETS } from "../compiler/compile.ts";
import {
  playdateBuildId,
  resolvePlaydateSdk,
} from "../compiler/playdate.ts";
import { FONT8 } from "../compiler/font.gen.ts";
import {
  __dispatchAxisDelta,
  __resetButtons,
  Button,
  onAxisDelta,
  RelativeAxis,
  RelativeAxisUnits,
} from "../host/input.ts";
import { bootOracle, type Oracle } from "../oracle/boot.ts";

const RUNTIME = join(import.meta.dir, "..", "runtime");
const SIX_BUTTON = join(
  import.meta.dir,
  "..",
  "examples",
  "playdate-six-button",
  "playdate-six-button.tsx",
);
const TODO = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");
const PLAYDATE_TODO = join(
  import.meta.dir,
  "..",
  "examples",
  "todo",
  "todo.playdate.tsx",
);

describe("playdate compiler target", () => {
  test("uses the 50x30 grid and emits only 1bpp two-style data", async () => {
    expect(VAPOR_TARGETS.playdate).toEqual({
      name: "playdate",
      width: 50,
      height: 30,
      poolCap: 32,
      strCap: 24,
    });
    const source = await Bun.file(SIX_BUTTON).text();
    const app = compileVaporApp(SIX_BUTTON, source, "PLAYDATE SIX", "playdate");
    expect(app.c).toContain("/* target: playdate (50x30) */");
    const font = app.c.match(/const u8 vp_font_tiles\[\] = \{ ([^}]*) \};/);
    expect(font).not.toBeNull();
    expect(font![1].split(",").map(Number)).toEqual(FONT8.flat());
    expect(font![1].split(",")).toHaveLength(95 * 8);
    expect(app.c).toContain("const u8 vp_palette_count = 3;");
    expect(app.c).toContain("const u8 vp_pal_style[3]");
    expect(app.c).not.toContain("vp_ink565");
    expect(app.c).not.toContain("vp_paper565");
    expect(app.c).not.toContain("vp_palettes");
    expect(app.c).toContain("void app_on_axis_delta(u8 axis, s32 delta)");
    expect(app.relativeAxesUsed).toEqual([]);
    expect(app.plan).toContain("760 B font + 3 B style data");
    expect(compileVaporApp(SIX_BUTTON, source, "PLAYDATE SIX", "playdate").c).toBe(app.c);
  });

  test("admits six physical buttons and rejects missing Playdate inputs", async () => {
    const source = await Bun.file(SIX_BUTTON).text();
    const app = compileVaporApp(SIX_BUTTON, source, "PLAYDATE SIX", "playdate");
    expect(app.buttonsUsed).toEqual([0, 1, 4, 5, 6, 7]);

    const todo = await Bun.file(TODO).text();
    expect(() => compileVaporApp(TODO, todo, "TODO", "playdate")).toThrow(
      /VT101: playdate has no physical input for Select, Start, R/,
    );
  });

  test("lowers the generic Primary relative axis and admits the Playdate Todo", async () => {
    const source = await Bun.file(PLAYDATE_TODO).text();
    const app = compileVaporApp(PLAYDATE_TODO, source, "VAPOR TODO", "playdate");
    expect(app.buttonsUsed).toEqual([0, 1, 4, 5, 6, 7]);
    expect(app.relativeAxesUsed).toEqual([RelativeAxis.Primary]);
    expect(app.c).toContain("static void vp_axis_handler_0(s32 axis_delta_arg)");
    expect(app.c).toContain("case 0: vp_axis_handler_0(delta); break;");
    expect(app.c).toContain("void app_on_axis_delta(u8 axis, s32 delta)");
    expect(app.c).toContain("/ 45000");
    expect(app.c).toContain("% 45000");
    expect(app.c).not.toContain("Math.trunc");
    expect(app.graph).toContain("relative axes: Primary");
    expect(() => compileVaporApp(PLAYDATE_TODO, source, "VAPOR TODO", "gba")).toThrow(
      /VT102: gba has no adapter for relative axis Primary/,
    );
    expect(() =>
      compileVaporApp(
        PLAYDATE_TODO,
        source.replace("RelativeAxis.Primary, (delta)", "RelativeAxis.Secondary, (delta)"),
        "VAPOR TODO",
        "playdate",
      ),
    ).toThrow(/VT102: playdate has no adapter for relative axis Secondary/);
  });
});

test("relative-axis oracle contract preserves signed canonical deltas", () => {
  const seen: number[] = [];
  __resetButtons();
  onAxisDelta(RelativeAxis.Primary, (delta) => seen.push(delta));
  __dispatchAxisDelta(RelativeAxis.Primary, 3);
  __dispatchAxisDelta(RelativeAxis.Primary, -2);
  expect(seen).toEqual([3, -2]);
  expect(() => __dispatchAxisDelta(RelativeAxis.Primary, 0)).toThrow(/non-zero integer/);
  expect(() => __dispatchAxisDelta(RelativeAxis.Primary, 1.5)).toThrow(/non-zero integer/);
  expect(() => __dispatchAxisDelta(99 as 0, 1)).toThrow(/unknown relative axis 99/);
  __resetButtons();
});

describe("playdate todo under the real Vue Vapor oracle", () => {
  const line = (o: Oracle, y: number): string => o.grid().chars[y];

  async function bootPlaydateTodo(): Promise<Oracle> {
    const source = await Bun.file(PLAYDATE_TODO).text();
    const styles = compileVaporApp(
      PLAYDATE_TODO,
      source,
      "PLAYDATE VAPOR TODO",
      "playdate",
    ).styles;
    return bootOracle({
      width: 50,
      height: 30,
      styles,
      entry: join(import.meta.dir, "..", "oracle", "entry-playdate.ts"),
    });
  }

  test("boots on the 50x30 grid with seed todos", async () => {
    const o = await bootPlaydateTodo();
    expect(line(o, 0).trim()).toBe("PLAYDATE VAPOR TODO");
    expect(line(o, 1)).toBe(" 2 LEFT / ALL".padEnd(50));
    expect(line(o, 3)).toBe(" >[ ] SHIP POCKET VAPOR".padEnd(50));
    expect(line(o, 4)).toBe("  [X] WRITE THE COMPILER".padEnd(50));
    expect(line(o, 5)).toBe("  [ ] RUN ON PLAYDATE".padEnd(50));
    expect(line(o, 29)).toBe(" CRANK:MOVE A:DONE B:DEL >:FILT UP:NEW DOWN:CLEAR".padEnd(50));
    o.unmount();
  });

  test("crank deltas move the cursor once per 45 degrees, signed and clamped", async () => {
    const o = await bootPlaydateTodo();
    await o.axisDelta(RelativeAxis.Primary, 44_999); // just under one detent
    expect(line(o, 3)).toBe(" >[ ] SHIP POCKET VAPOR".padEnd(50));
    await o.axisDelta(RelativeAxis.Primary, 1); // remainder completes the step
    expect(line(o, 3)).toBe("  [ ] SHIP POCKET VAPOR".padEnd(50));
    expect(line(o, 4)).toBe(" >[X] WRITE THE COMPILER".padEnd(50));
    await o.axisDelta(RelativeAxis.Primary, 90_000); // two steps, clamped at the end
    expect(line(o, 5)).toBe(" >[ ] RUN ON PLAYDATE".padEnd(50));
    await o.axisDelta(RelativeAxis.Primary, -45_000); // anti-clockwise moves up
    expect(line(o, 4)).toBe(" >[X] WRITE THE COMPILER".padEnd(50));
    o.unmount();
  });

  test("edit mode consumes buttons and ignores crank motion", async () => {
    const o = await bootPlaydateTodo();
    await o.press(Button.Up); // open the editor
    expect(line(o, 27)).toBe(" NEW: [A]".padEnd(50));
    await o.axisDelta(RelativeAxis.Primary, 180_000); // crank must not move the list
    await o.press(Button.Right); // scrub glyph A -> B
    await o.press(Button.A); // put it
    expect(line(o, 27)).toBe(" NEW: B[B]".padEnd(50));
    await o.press(Button.Down); // cancel
    expect(line(o, 3)).toBe(" >[ ] SHIP POCKET VAPOR".padEnd(50));
    o.unmount();
  });
});

test("45-degree detents are application policy over canonical axis deltas", () => {
  let remainder = 0;
  let cursor = 0;
  const threshold = 45 * RelativeAxisUnits.PerDegree;

  __resetButtons();
  onAxisDelta(RelativeAxis.Primary, (delta) => {
    remainder += delta;
    const steps = Math.trunc(remainder / threshold);
    if (steps !== 0) {
      remainder %= threshold;
      cursor += steps;
    }
  });

  __dispatchAxisDelta(RelativeAxis.Primary, 44_999);
  expect({ cursor, remainder }).toEqual({ cursor: 0, remainder: 44_999 });
  __dispatchAxisDelta(RelativeAxis.Primary, 1);
  expect({ cursor, remainder }).toEqual({ cursor: 1, remainder: 0 });
  __dispatchAxisDelta(RelativeAxis.Primary, 90_000);
  expect({ cursor, remainder }).toEqual({ cursor: 3, remainder: 0 });
  __dispatchAxisDelta(RelativeAxis.Primary, -135_001);
  expect({ cursor, remainder }).toEqual({ cursor: 0, remainder: -1 });
  __resetButtons();
});

describe("playdate build inputs", () => {
  test("SDK resolution never hides an invalid explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocket-vapor-playdate-sdk-"));
    const home = join(root, "home");
    const sdk = join(root, "sdk");
    await mkdir(join(home, ".Playdate"), { recursive: true });
    await mkdir(join(sdk, "C_API", "buildsupport"), { recursive: true });
    await mkdir(join(sdk, "bin"), { recursive: true });
    await writeFile(join(sdk, "C_API", "pd_api.h"), "");
    await writeFile(join(sdk, "C_API", "buildsupport", "playdate.cmake"), "");
    await writeFile(join(sdk, "C_API", "buildsupport", "arm.cmake"), "");
    await writeFile(join(sdk, "bin", "pdc"), "");
    await writeFile(join(sdk, "VERSION.txt"), "3.1.1\n");
    await writeFile(join(home, ".Playdate", "config"), `SDKRoot\t${sdk}\n`);

    try {
      expect(resolvePlaydateSdk({}, home)).toEqual({
        path: sdk,
        version: "3.1.1",
        pdc: join(sdk, "bin", "pdc"),
        armToolchain: join(sdk, "C_API", "buildsupport", "arm.cmake"),
      });
      expect(() =>
        resolvePlaydateSdk({ PLAYDATE_SDK_PATH: join(root, "missing") }, home),
      ).toThrow(/PLAYDATE_SDK_PATH not found/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("build identity is deterministic and source/SDK-sensitive", async () => {
    const source = await Bun.file(SIX_BUTTON).text();
    const app = compileVaporApp(SIX_BUTTON, source, "PLAYDATE SIX", "playdate");
    const same = compileVaporApp(SIX_BUTTON, source, "PLAYDATE SIX", "playdate");
    const changed = compileVaporApp(
      SIX_BUTTON,
      source.replace("value.value + 1", "value.value + 2"),
      "PLAYDATE SIX",
      "playdate",
    );
    const id = await playdateBuildId(app, "3.1.1");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(await playdateBuildId(same, "3.1.1")).toBe(id);
    expect(await playdateBuildId(changed, "3.1.1")).not.toBe(id);
    expect(await playdateBuildId(app, "3.1.2")).not.toBe(id);
  });

  test("native source manifest contains no interpreter runtime", async () => {
    const cmake = await Bun.file(join(RUNTIME, "playdate", "CMakeLists.txt")).text();
    expect(cmake).toContain("vapor_core.c");
    expect(cmake).toContain("vapor_playdate.c");
    expect(cmake).not.toMatch(/quickjs|wamr|wasm-micro-runtime/i);
  });
});

test("playdate framebuffer C unit", async () => {
  const cc = Bun.which("cc");
  expect(cc).not.toBeNull();
  const root = await mkdtemp(join(tmpdir(), "pocket-vapor-playdate-frame-"));
  const binary = join(root, "framebuffer-test");
  try {
    const compile = Bun.spawn(
      [
        cc!,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        `-I${join(RUNTIME, "playdate")}`,
        join(RUNTIME, "playdate", "framebuffer.c"),
        join(import.meta.dir, "harness", "playdate_framebuffer_test.c"),
        "-o",
        binary,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [compileOut, compileErr, compileCode] = await Promise.all([
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
      compile.exited,
    ]);
    expect(`${compileOut}${compileErr}`).toBe("");
    expect(compileCode).toBe(0);

    const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe("playdate framebuffer: ok\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("playdate lifecycle and input C unit", async () => {
  const cc = Bun.which("cc");
  expect(cc).not.toBeNull();
  const root = await mkdtemp(join(tmpdir(), "pocket-vapor-playdate-runtime-"));
  const binary = join(root, "runtime-test");
  try {
    const compile = Bun.spawn(
      [
        cc!,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DVP_GRID_W=50",
        "-DVP_GRID_H=30",
        "-DVP_STR_CAP=24",
        "-DVP_VIEW_CAP=32",
        `-I${join(import.meta.dir, "harness", "playdate_sdk")}`,
        `-I${RUNTIME}`,
        `-I${join(RUNTIME, "playdate")}`,
        join(RUNTIME, "vapor_core.c"),
        join(RUNTIME, "playdate", "framebuffer.c"),
        join(RUNTIME, "playdate", "vapor_playdate.c"),
        join(import.meta.dir, "harness", "playdate_runtime_test.c"),
        "-o",
        binary,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [compileOut, compileErr, compileCode] = await Promise.all([
      new Response(compile.stdout).text(),
      new Response(compile.stderr).text(),
      compile.exited,
    ]);
    expect(`${compileOut}${compileErr}`).toBe("");
    expect(compileCode).toBe(0);

    const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toBe("playdate runtime: ok\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
