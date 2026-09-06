import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import { CLEAR_EINK_PALETTE } from "../apps/clear/palette.ts";
import {
  BOOX_LEAF3_ANDROID_DEV_TARGET_ID,
  BOOX_LEAF3_DEV_CONTRACTS,
  BOOX_LEAF3_HOST_ABI,
  BOOX_LEAF3_LOGICAL_VIEWPORT,
  BOOX_LEAF3_PHYSICAL_VIEWPORT,
  BOOX_LEAF3_RASTER_DENSITY,
  resolveBooxLeaf3BuildPlan,
} from "../tools/boox-leaf3-profile.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/boox-todo/pocket.json");

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function expectGray(value: string): void {
  expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  expect(value.slice(1, 3)).toBe(value.slice(3, 5));
  expect(value.slice(3, 5)).toBe(value.slice(5, 7));
}

describe("BOOX Leaf3 Pocket Todo", () => {
  test("resolves against the exact private device contract", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(BOOX_LEAF3_ANDROID_DEV_TARGET_ID);
    expect(BOOX_LEAF3_DEV_CONTRACTS.targets[BOOX_LEAF3_ANDROID_DEV_TARGET_ID]).toEqual({
      hostAbi: BOOX_LEAF3_HOST_ABI,
      platform: "android-boox",
      form: "takeover",
      display: {
        physicalViewport: BOOX_LEAF3_PHYSICAL_VIEWPORT,
        logicalViewports: [BOOX_LEAF3_LOGICAL_VIEWPORT],
        presentations: ["stretch"],
        rasterDensity: BOOX_LEAF3_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });

    const plan = resolveBooxLeaf3BuildPlan(manifest());
    expect(plan.target).toEqual({
      id: BOOX_LEAF3_ANDROID_DEV_TARGET_ID,
      hostAbi: BOOX_LEAF3_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: BOOX_LEAF3_LOGICAL_VIEWPORT,
      physical: BOOX_LEAF3_PHYSICAL_VIEWPORT,
      presentation: "stretch",
      rasterDensity: BOOX_LEAF3_RASTER_DENSITY,
      policy: "fixed",
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
    expect(plan.app.entry).toBe("apps/boox-todo/main.tsx");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("uses neutral e-ink colors for every rendered palette role", () => {
    for (const color of [
      CLEAR_EINK_PALETTE.canvas,
      CLEAR_EINK_PALETTE.foreground,
      CLEAR_EINK_PALETTE.mutedForeground,
      CLEAR_EINK_PALETTE.disabledForeground,
      CLEAR_EINK_PALETTE.edgeLight.slice(0, 7),
      CLEAR_EINK_PALETTE.edgeDark.slice(0, 7),
      CLEAR_EINK_PALETTE.countCell.slice(0, 7),
      CLEAR_EINK_PALETTE.doneFrom,
      CLEAR_EINK_PALETTE.doneTo,
      CLEAR_EINK_PALETTE.doneText,
      CLEAR_EINK_PALETTE.completeFrom,
      CLEAR_EINK_PALETTE.completeTo,
      CLEAR_EINK_PALETTE.completeIcon,
      CLEAR_EINK_PALETTE.deleteIcon,
      CLEAR_EINK_PALETTE.flapFrom,
      CLEAR_EINK_PALETTE.flapTo,
      ...CLEAR_EINK_PALETTE.todoRows(3, 9),
      ...CLEAR_EINK_PALETTE.listRows(3, 9),
      CLEAR_EINK_PALETTE.keyboard.panelFrom,
      CLEAR_EINK_PALETTE.keyboard.panelTo,
      CLEAR_EINK_PALETTE.keyboard.divider,
      ...CLEAR_EINK_PALETTE.keyboard.char,
      ...CLEAR_EINK_PALETTE.keyboard.action,
      ...CLEAR_EINK_PALETTE.keyboard.engaged,
      CLEAR_EINK_PALETTE.keyboard.keyText,
      CLEAR_EINK_PALETTE.keyboard.engagedText,
      CLEAR_EINK_PALETTE.keyboard.popupFrom,
      CLEAR_EINK_PALETTE.keyboard.popupTo,
      CLEAR_EINK_PALETTE.keyboard.popupBorder,
    ]) {
      expectGray(color);
    }
  });

  test("type-checks the BOOX entry and shared Clear implementation", () => {
    const result = checkAppTypes({
      entry: join(repository, "apps/boox-todo/main.tsx"),
      tsconfigPath: join(repository, "tsconfig.json"),
      declarationFiles: [join(repository, "framework/src/jsx.d.ts")],
    });
    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.category === "error")
        .map((diagnostic) => diagnostic.message),
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("pins the APK identity and Android compatibility range", () => {
    const toolchain = JSON.parse(
      readFileSync(join(repository, "tools/cli/boox-android-toolchain.json"), "utf8"),
    );
    expect(toolchain.android).toMatchObject({
      minApiLevel: 18,
      targetApiLevel: 30,
      abi: "armeabi-v7a",
    });
    expect(toolchain.app).toMatchObject({
      manifest: "apps/boox-todo/pocket.json",
      output: "dist/boox-android/pocketjs-boox-todo.apk",
    });
  });
});
