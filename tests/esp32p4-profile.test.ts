import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { assertNativeHostContract, type HostOps } from "../framework/src/host.ts";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import { validatePlatformContractRegistry } from "../framework/src/manifest/resolve.ts";
import {
  ESP32P4_WAVESHARE_7B_BOARD_ID,
  ESP32P4_WAVESHARE_7B_CONTENT_RECT,
  ESP32P4_WAVESHARE_7B_DEV_CONTRACTS,
  ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
  ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
  ESP32P4_WAVESHARE_7B_GUEST_SURFACE,
  ESP32P4_WAVESHARE_7B_LOGICAL_VIEWPORT,
  ESP32P4_WAVESHARE_7B_PANEL,
  resolveEsp32P4Waveshare7BBuildPlan,
} from "../tools/esp32p4-profile.ts";
import {
  planEsp32P4Bundle,
  resolveEsp32P4ManifestPath,
} from "../tools/esp32p4.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromeManifestPath = join(root, "apps/chrome/pocket.json");
const chromeManifest: unknown = JSON.parse(await Bun.file(chromeManifestPath).text());

describe("experimental ESP32-P4 Waveshare 7B profile", () => {
  test("stays private and separates the guest surface from the physical panel", () => {
    expect(Object.hasOwn(POCKET_TARGETS, ESP32P4_WAVESHARE_7B_DEV_TARGET_ID)).toBe(false);
    expect(validatePlatformContractRegistry(ESP32P4_WAVESHARE_7B_DEV_CONTRACTS)).toEqual([]);

    const profile = ESP32P4_WAVESHARE_7B_DEV_CONTRACTS.targets[
      ESP32P4_WAVESHARE_7B_DEV_TARGET_ID
    ];
    expect(profile).toEqual({
      hostAbi: 6,
      platform: "esp32p4",
      form: "takeover",
      display: {
        physicalViewport: [960, 544],
        logicalViewports: [[480, 272]],
        presentations: ["integer-fit"],
        rasterDensity: 2,
      },
      capabilities: ["input.buttons", "input.touch", "text.glyphs.baked"],
    });
    expect(ESP32P4_WAVESHARE_7B_LOGICAL_VIEWPORT).toEqual([480, 272]);
    expect(ESP32P4_WAVESHARE_7B_GUEST_SURFACE).toEqual([960, 544]);
    expect(ESP32P4_WAVESHARE_7B_PANEL).toEqual([1024, 600]);
    expect(ESP32P4_WAVESHARE_7B_CONTENT_RECT).toEqual({
      x: 32,
      y: 28,
      width: 960,
      height: 544,
    });
  });

  test("resolves a target-bound density-2 plan with the private host identity", async () => {
    const plan = resolveEsp32P4Waveshare7BBuildPlan(chromeManifest);
    expect(plan.target).toEqual({
      id: "esp32p4-waveshare-7b-dev",
      hostAbi: 6,
    });
    expect(plan.viewport).toEqual({
      logical: [480, 272],
      physical: [960, 544],
      presentation: "integer-fit",
      rasterDensity: 2,
    });
    expect(plan.features).toEqual({
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    expect(verifyPlanHash(plan)).toBe(true);

    const touchManifest: unknown = await Bun.file(
      new URL("./fixtures/manifests/requires-touch.json", import.meta.url),
    ).json();
    expect(
      resolveEsp32P4Waveshare7BBuildPlan(touchManifest).features["input.touch"],
    ).toBe(true);
  });

  test("binds bundles to the exact native target and ABI", () => {
    const plan = resolveEsp32P4Waveshare7BBuildPlan(chromeManifest);
    expect(
      extractHostBuildInputs(plan, {
        expectedTarget: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
      }),
    ).toMatchObject({
      appOutput: "chrome-main",
      target: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
      hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
    });

    const matching = {
      __host: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
      __hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
    } as HostOps;
    expect(() =>
      assertNativeHostContract(matching, {
        target: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
        hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
      })
    ).not.toThrow();
    expect(() =>
      assertNativeHostContract(
        { ...matching, __host: "psp" },
        {
          target: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
          hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
        },
      )
    ).toThrow("native target mismatch");
    expect(() =>
      assertNativeHostContract(
        { ...matching, __hostAbi: 5 },
        {
          target: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
          hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
        },
      )
    ).toThrow("native host ABI mismatch");
  });
});

describe("ESP32-P4 bundle artifact planning", () => {
  test("accepts a stock app name or an explicit manifest path", () => {
    expect(resolveEsp32P4ManifestPath("chrome", { frameworkRoot: root })).toBe(
      chromeManifestPath,
    );
    expect(
      resolveEsp32P4ManifestPath("apps/chrome/pocket.json", {
        cwd: root,
        frameworkRoot: root,
      }),
    ).toBe(chromeManifestPath);
  });

  test("plans deterministic target-bound JS, PAK, and plan artifacts", () => {
    const artifacts = planEsp32P4Bundle("chrome", {
      cwd: root,
      frameworkRoot: root,
    });
    expect(artifacts.target).toEqual({
      id: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID,
      hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
    });
    expect(artifacts.board).toEqual({
      id: ESP32P4_WAVESHARE_7B_BOARD_ID,
      panel: [1024, 600],
      contentRect: { x: 32, y: 28, width: 960, height: 544 },
    });
    expect(artifacts.manifestPath).toBe(chromeManifestPath);
    expect(artifacts.frameworkRoot).toBe(root);
    expect(artifacts.projectRoot).toBe(root);
    expect(artifacts.outputDirectory).toBe(join(root, "dist/esp32p4"));
    expect(artifacts.planPath).toBe(join(root, "dist/esp32p4/chrome-main.plan.json"));
    expect(artifacts.javascriptPath).toBe(join(root, "dist/esp32p4/chrome-main.js"));
    expect(artifacts.pakPath).toBe(join(root, "dist/esp32p4/chrome-main.pak"));
    expect(planEsp32P4Bundle("chrome", { frameworkRoot: root })).toEqual(artifacts);
  });
});
