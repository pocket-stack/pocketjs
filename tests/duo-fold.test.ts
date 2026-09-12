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
  for (const patch of [{ degrees: null }, { degrees: 90 }, { samples: -1 }, { samples: 1.5 },
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

test.skipIf(process.platform !== "darwin")("native projection preserves zero and hinge, mirrors signs, and isolates screen Y attitude", () => {
  const root = mkdtempSync(join(tmpdir(), "pocket-fold-math-"));
  try {
    const source = join(root, "probe.c"), binary = join(root, "probe");
    writeFileSync(source, `#include ${JSON.stringify(resolve(import.meta.dir, "../hosts/ios-legacy/fold-math.h"))}
#include <assert.h>
#define CLOSE(a,b) assert(fabs((a)-(b)) < 1e-8)
int main(void) {
  for (int shape = 0; shape < 2; ++shape) {
    double w = shape ? 480 : 320, h = shape ? 320 : 480;
    for (int j = 0; j <= 10; ++j) {
      double x = w*j/10, y = h*0.3;
      FoldRay flat = fold_ray(x,y,0,w,h,2053.54);
      CLOSE(flat.x,x); CLOSE(flat.y,y); CLOSE(flat.radius,0); CLOSE(flat.attenuation,1);
      for (int k = 1; k < 85; ++k) {
        double a = k*M_PI/180;
        FoldRay left = fold_ray(x,y,-a,w,h,2053.54);
        FoldRay right = fold_ray(w-x,y,a,w,h,2053.54);
        CLOSE(left.x,w-right.x); CLOSE(left.y,right.y);
        CLOSE(left.radius,right.radius); assert(left.depth > 0);
        assert(left.attenuation >= 0 && left.attenuation <= 1);
      }
    }
    FoldRay hinge = fold_ray(w,h*0.2,1,w,h,2053.54);
    CLOSE(hinge.x,w); CLOSE(hinge.y,h*0.2); CLOSE(hinge.radius,0);
  }
  double identity[9] = {1,0,0,0,1,0,0,0,1};
  double a = 0.6, c = cos(a), s = sin(a);
  double yrot[9] = {c,0,s,0,1,0,-s,0,c};
  double roll[9] = {c,-s,0,s,c,0,0,0,1};
  double pitch[9] = {1,0,0,0,c,-s,0,s,c};
  CLOSE(fold_tilt(identity,yrot),a); CLOSE(fold_tilt(yrot,identity),-a);
  CLOSE(fold_tilt(yrot,yrot),0); CLOSE(fold_tilt(identity,roll),0);
  CLOSE(fold_tilt(identity,pitch),0);
  double transposed[9]; fold_device_matrix(yrot,1,transposed);
  CLOSE(fold_tilt(identity,transposed),-a);
  return 0;
}`);
    const build = Bun.spawnSync(["xcrun", "clang", "-Wall", "-Wextra", "-Werror", source, "-o", binary]);
    expect(build.stderr.toString()).toBe(""); expect(build.exitCode).toBe(0);
    expect(Bun.spawnSync([binary]).exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
