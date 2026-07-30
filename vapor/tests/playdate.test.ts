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

const RUNTIME = join(import.meta.dir, "..", "runtime");
const SIX_BUTTON = join(
  import.meta.dir,
  "..",
  "examples",
  "playdate-six-button",
  "playdate-six-button.tsx",
);
const TODO = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");

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
