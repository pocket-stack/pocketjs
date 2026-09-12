import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  D211_LINUX_DEV_CONTRACTS,
  D211_LINUX_DEV_HOST_ABI,
  D211_LINUX_DEV_TARGET_ID,
  D211_LINUX_LOGICAL_VIEWPORT,
  D211_LINUX_PHYSICAL_VIEWPORT,
  resolveD211LinuxBuildPlan,
} from "../tools/d211-linux-profile.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/d211-demo/pocket.json");

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("private D211 Linux build profile", () => {
  test("uses the fbdev display and touch contract without changing public targets", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(D211_LINUX_DEV_TARGET_ID);
    expect(D211_LINUX_DEV_CONTRACTS.targets[D211_LINUX_DEV_TARGET_ID]).toEqual({
      hostAbi: D211_LINUX_DEV_HOST_ABI,
      platform: "linux",
      form: "takeover",
      display: {
        physicalViewport: D211_LINUX_PHYSICAL_VIEWPORT,
        logicalViewports: [D211_LINUX_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

  test("resolves the demo to the exact hardware plan", () => {
    const plan = resolveD211LinuxBuildPlan(manifest());
    expect(plan.target).toEqual({
      id: D211_LINUX_DEV_TARGET_ID,
      hostAbi: D211_LINUX_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: D211_LINUX_LOGICAL_VIEWPORT,
      physical: D211_LINUX_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("rejects unsupported capabilities and a stretched viewport", () => {
    const needsButtons = manifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveD211LinuxBuildPlan(needsButtons)).toThrow("input.buttons");

    const stretched = manifest();
    stretched.app.viewport.fixed.logical = [400, 240];
    expect(() => resolveD211LinuxBuildPlan(stretched)).toThrow("400x240");
  });

  test("type-checks explicit PocketJS imports in the Solid demo", () => {
    const result = checkAppTypes({
      entry: join(repository, "apps/d211-demo/main.tsx"),
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

  test("pins the Luban toolchain, Rust target, and QuickJS revision", () => {
    const toolchain = JSON.parse(
      readFileSync(join(repository, "tools/cli/d211-linux-toolchain.json"), "utf8"),
    );
    expect(toolchain).toMatchObject({
      toolchainVersion: "d211-linux-riscv64-luban-v1",
      luban: {
        outputDirectory: "output/d211",
        gccPrefix: "riscv64-unknown-linux-gnu",
      },
      rust: {
        toolchain: "nightly-2026-07-02",
        target: "riscv64gc-unknown-linux-gnu",
      },
      device: {
        name: "ArtInChip D211DBV (SPI NAND)",
        physicalViewport: [800, 480],
        logicalViewport: [800, 480],
        rasterDensity: 1,
      },
    });
    expect(toolchain.quickjs.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(toolchain).not.toHaveProperty("luban.sdkRoot");
    expect(JSON.stringify(toolchain)).not.toContain("/home/");
  });

  test("the fbdev host probes the framebuffer and never hard-codes the touch node", () => {
    const main = readFileSync(join(repository, "hosts/d211-linux/main.c"), "utf8");
    const input = readFileSync(join(repository, "hosts/d211-linux/input.c"), "utf8");
    const header = readFileSync(
      join(repository, "engine/ui-cabi/include/pocket_ui_cabi.h"),
      "utf8",
    );
    expect(main).toContain("FBIOGET_VSCREENINFO");
    expect(main).toContain("FBIOGET_FSCREENINFO");
    expect(main).toContain("FBIOPAN_DISPLAY");
    expect(main).toContain("ui_render_incremental_scaled(POCKET_RASTER_DENSITY)");
    expect(main).toContain("pocket_runtime_damage_bounds");
    expect(main).toContain("pocket_runtime_hit_test_bounds");
    expect(main).toContain("pocket_runtime_tick(&input)");
    expect(main).not.toContain("/dev/input/event0");
    expect(input).toContain("EVIOCGNAME");
    expect(input).toContain("EVIOCGBIT");
    expect(input).toContain("EVIOCGABS");
    expect(input).toContain("ABS_MT_POSITION_X");
    expect(input).not.toContain("/dev/input/event0");
    expect(header).toContain("ui_render_incremental_scaled");
  });

  test("the build bridges to LLD and installs on the rootfs", () => {
    const script = readFileSync(
      join(repository, "tools/d211-linux/build-runtime.sh"),
      "utf8",
    );
    const tooling = readFileSync(join(repository, "tools/d211-linux.ts"), "utf8");
    const workflow = readFileSync(
      join(repository, "tools/d211-linux/remote-build.sh"),
      "utf8",
    );
    expect(script).toContain("-fuse-ld=lld");
    expect(script).toContain("LLD_SHIM_DIR");
    expect(script).toContain("--no-undefined");
    expect(script.split('-DPOCKET_RASTER_DENSITY="$POCKET_RASTER_DENSITY"').length - 1).toBe(2);
    expect(script).not.toContain("rm -");
    expect(tooling).toContain('"bare-platform,software-only"');
    expect(tooling).toContain("D211_LUBAN_SDK");
    expect(tooling).toContain('const DEVICE_DIRECTORY = "/opt/pocketjs"');
    expect(tooling).not.toContain('"/tmp/pocketjs-d211"');
    expect(workflow).toContain("D211_REMOTE");
    expect(workflow).toContain("D211_REMOTE_PORT");
    expect(workflow).toContain("bun tools/d211-linux.ts build");
    expect(workflow).toContain("--delete");
    expect(workflow).not.toMatch(/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
