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
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const repository = new URL("..", import.meta.url).pathname;

describe("experimental Nokia E7 runtime profile", () => {
  test("does not register an unproven production target", () => {
    expect(Object.keys(POCKET_TARGETS)).toEqual(["psp", "vita", "macos-widget"]);
    expect(POCKET_TARGETS).not.toHaveProperty(SYMBIAN_E7_DEV_TARGET_ID);
  });

  test("selects the Hero's dynamic E7 viewport without changing its PSP viewport", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
    );
    const plan = resolveSymbianE7BuildPlan(manifest);
    expect(plan.target).toEqual({
      id: SYMBIAN_E7_DEV_TARGET_ID,
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [640, 360],
      physical: [640, 360],
      presentation: "native",
      rasterDensity: 1,
    });
    expect(plan.features["display.viewport.live"]).toBe(true);
    expect(plan.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const psp = validateAndResolveBuildPlan(manifest, { target: "psp" });
    expect(psp.ok).toBe(true);
    if (!psp.ok) return;
    expect(psp.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
    });
    expect(psp.plan.features["display.viewport.live"]).toBe(false);
  });

  test("publishes only capabilities implemented by the first E7 host", () => {
    const target = SYMBIAN_E7_DEV_CONTRACTS.targets[SYMBIAN_E7_DEV_TARGET_ID];
    expect(target.form).toBe("window");
    expect(target.display.dynamicViewport).toEqual({
      min: [360, 360],
      max: [640, 640],
    });
    expect(target.capabilities).toEqual([
      "input.buttons",
      "display.viewport.live",
      "text.glyphs.baked",
    ]);
  });

  test("keeps the Hero's horizontal regions wrap-safe in portrait", () => {
    const hero = readFileSync(join(repository, "apps/hero/app.tsx"), "utf8");
    expect(hero).toContain(
      'debugName="Header" class="flex-row flex-wrap items-center justify-between"',
    );
    expect(hero).toContain('class="flex-row flex-wrap items-center justify-between"');
    expect(hero).toContain(
      'debugName="Description" class="flex-row flex-wrap gap-1"',
    );
    expect(hero).toContain('class="flex-row flex-wrap items-center gap-4"');
  });

  test("binds the strict target contract, live viewport, and safe E7 input", () => {
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
    const buildApp = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-build-app"),
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
    expect(runtime).toContain("setAttribute(Qt::WA_AutoOrientation, true)");
    expect(runtime).not.toContain("WA_LockLandscapeOrientation");
    expect(runtime).toContain('"__pocketResizeViewport"');
    expect(runtime).toContain("queueViewport(event->size())");
    expect(runtime).toContain("queueViewport(size())");
    expect(runtime).toContain("framebuffer_ = QImage();");
    expect(runtime).toContain(
      "width != static_cast<uint32_t>(viewportSize_.width())",
    );
    expect(runtime).toContain(
      "viewportSize_.width() > kTouchCoordinateExtent",
    );
    expect(runtime).not.toContain("presentationRect");
    expect(runtime).not.toContain("kLogicalWidth");
    expect(runtime).not.toContain('"__textures"');

    expect(project).toContain("TARGET.EPOCHEAPSIZE = 0x400000 0x2000000");
    expect(project).toContain("QMAKE_LFLAGS += --whole-archive");
    expect(project).toContain("QMAKE_LFLAGS += --no-whole-archive");
    expect(project).toContain(
      "POCKETJS_INITIAL_LOGICAL_WIDTH=$$POCKETJS_INITIAL_LOGICAL_WIDTH",
    );
    expect(project).toContain(
      "POCKETJS_INITIAL_LOGICAL_HEIGHT=$$POCKETJS_INITIAL_LOGICAL_HEIGHT",
    );
    expect(buildApp).toContain(
      "initial_logical_width=$(jq -er '.viewport.logical[0]'",
    );
    expect(buildApp).toContain(
      '"POCKETJS_INITIAL_LOGICAL_WIDTH=$initial_logical_width"',
    );
    expect(buildApp).toContain("10#$initial_logical_width > 640");
    expect(buildApp).toContain("integer extents from 1 through 640");
    expect(resources).toContain('<file alias="app.js">app.js</file>');
    expect(resources).toContain('<file alias="app.pak">app.pak</file>');

    const clearImage = runtime.indexOf("framebuffer_ = QImage();");
    const resizeCore = runtime.indexOf(
      "ui_set_viewport(viewport.width(), viewport.height());",
      clearImage,
    );
    const callHook = runtime.indexOf("resizeViewport_,", resizeCore);
    const drainJobs = runtime.indexOf("if (!drainJobs()) return false;", callHook);
    expect(clearImage).toBeGreaterThan(-1);
    expect(resizeCore).toBeGreaterThan(clearImage);
    expect(callHook).toBeGreaterThan(resizeCore);
    expect(drainJobs).toBeGreaterThan(callHook);
  });
});
