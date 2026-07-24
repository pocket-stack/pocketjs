import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  SYMBIAN_E7_DEV_CONTRACTS,
  SYMBIAN_E7_DEV_HOST_ABI,
  SYMBIAN_E7_DEV_TARGET_ID,
  resolveSymbianE7BuildPlan,
} from "../tools/symbian-profile.ts";

const repository = new URL("..", import.meta.url).pathname;

describe("experimental Nokia E7 runtime profile", () => {
  test("does not register an unproven production target", () => {
    expect(Object.keys(POCKET_TARGETS)).toEqual(["psp", "vita", "macos-widget"]);
    expect(POCKET_TARGETS).not.toHaveProperty(SYMBIAN_E7_DEV_TARGET_ID);
  });

  test("admits the existing 480x272 hero through the private registry", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
    );
    const plan = resolveSymbianE7BuildPlan(manifest);
    expect(plan.target).toEqual({
      id: SYMBIAN_E7_DEV_TARGET_ID,
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
    });
    expect(plan.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("publishes only capabilities implemented by the first E7 host", () => {
    expect(
      SYMBIAN_E7_DEV_CONTRACTS.targets[SYMBIAN_E7_DEV_TARGET_ID].capabilities,
    ).toEqual([
      "input.buttons",
      "text.glyphs.baked",
    ]);
  });

  test("binds the strict target contract, fixed-step loop, and safe E7 input", () => {
    const runtime = readFileSync(
      join(repository, "hosts/symbian/runtime/main.cpp"),
      "utf8",
    );
    const project = readFileSync(
      join(repository, "hosts/symbian/runtime/pocketjs-e7-runtime.pro"),
      "utf8",
    );
    const resources = readFileSync(
      join(repository, "hosts/symbian/runtime/pocketjs-runtime.qrc"),
      "utf8",
    );

    expect(runtime).toContain('JS_NewString(context, "symbian-e7-dev")');
    expect(runtime).toContain('"__hostAbi"');
    expect(runtime).toContain("JS_ExecutePendingJob");
    expect(runtime.match(/\n    ui_tick\(\);/g)).toHaveLength(2);
    expect(runtime).toContain("QImage::Format_ARGB32");
    expect(runtime).toContain("point.id()) & 0xff) << 18");
    expect(runtime).toContain("position.x() >= target.left() + target.width()");
    expect(runtime).toContain("event->isAutoRepeat()");
    expect(runtime).toContain("case Qt::Key_Select:");
    expect(runtime).toContain("(width() - kLogicalWidth) / 2");
    expect(runtime).not.toContain('"__textures"');

    expect(project).toContain("TARGET.EPOCHEAPSIZE = 0x400000 0x2000000");
    expect(project).toContain("QMAKE_LFLAGS += --whole-archive");
    expect(project).toContain("QMAKE_LFLAGS += --no-whole-archive");
    expect(resources).toContain('<file alias="app.js">app.js</file>');
    expect(resources).toContain('<file alias="app.pak">app.pak</file>');
  });
});
