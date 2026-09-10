import { expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bakeFoldSnapshot, FOLD_RADII, FOLD_TEXTURE } from "../tools/fold-snapshot.ts";
import { parseFoldState } from "../apps/duo-fold/service.ts";
import { selectIPodTouch4App } from "../tools/ipodtouch4.ts";

test("fold state accepts finite motion receipts and rejects malformed transport data", () => {
  const state = { t: "fold.state", source: true, available: true, active: true,
    manual: false, degrees: -31.2, samples: 123, calibrations: 1 };
  expect(parseFoldState(JSON.stringify(state))).toEqual(state);
  expect(parseFoldState(JSON.stringify({ ...state, degrees: 125 }))).not.toBeNull();
  for (const patch of [{ degrees: null }, { degrees: 181 }, { samples: -1 }, { samples: 1.5 },
    { source: "true" }, { active: undefined }, { calibrations: -1 }]) {
    expect(parseFoldState(JSON.stringify({ ...state, ...patch }))).toBeNull();
  }
  for (const line of ["", "null", "{}", "garbage"]) expect(parseFoldState(line)).toBeNull();
});

test("fold installs alongside Clear with its own local service and container", () => {
  const fold = selectIPodTouch4App("fold"), clear = selectIPodTouch4App("clear");
  expect(fold.foldSurface).toBe(true);
  expect(fold.svcWire).toBe(false);
  for (const key of ["bundleId", "bundleName", "executable", "scheme"] as const) expect(fold[key]).not.toBe(clear[key]);
});

test("snapshot baker preserves the flat image, scatters edges over black, and rejects a locked display", async () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-fold-bake-"));
  try {
    const png = join(root, "source.png"), bin = join(root, "textures.bin");
    const canvas = createCanvas(320, 480), ctx = canvas.getContext("2d");
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, 320, 480);
    writeFileSync(png, canvas.toBuffer("image/png"));
    await expect(bakeFoldSnapshot(png, bin)).rejects.toThrow("black");
    ctx.fillStyle = "rgb(240,120,60)"; ctx.fillRect(0, 0, 320, 480);
    writeFileSync(png, canvas.toBuffer("image/png"));
    await bakeFoldSnapshot(png, bin);
    const data = readFileSync(bin), { width, height, padding } = FOLD_TEXTURE;
    expect(data.subarray(0, 8).toString()).toBe("PFOLD001");
    expect(data.length).toBe(8 + width * height * 4 * FOLD_RADII.length);
    const pixel = (level: number, x: number, y: number) =>
      [...data.subarray(8 + (level * width * height + y * width + x) * 4,
        12 + (level * width * height + y * width + x) * 4)];
    expect(pixel(0, padding + 100, padding + 100)).toEqual([240, 120, 60, 255]);
    expect(pixel(0, padding - 10, padding + 100)).toEqual([0, 0, 0, 255]);
    expect(pixel(7, padding - 10, padding + 100)[0]).toBeGreaterThan(0);
    expect(pixel(7, padding + 100, padding + 100)).toEqual([240, 120, 60, 255]);
    expect(pixel(7, 0, 0)).toEqual([0, 0, 0, 255]);
    const landscape = createCanvas(480, 320);
    writeFileSync(png, landscape.toBuffer("image/png"));
    await expect(bakeFoldSnapshot(png, bin)).rejects.toThrow("portrait");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.platform !== "darwin")("native reprojection cancels compound attitude and keeps blur coverage continuous", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-fold-math-"));
  try {
    const source = resolve(import.meta.dir, "fixtures/fold_projection.c"), binary = join(root, "probe");
    const build = Bun.spawnSync(["xcrun", "clang", "-Wall", "-Wextra", "-Werror",
      "-fsanitize=address,undefined", source, "-o", binary]);
    expect(build.stderr.toString()).toBe(""); expect(build.exitCode).toBe(0);
    const run = Bun.spawnSync([binary]);
    expect(run.stderr.toString()).toBe(""); expect(run.exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
