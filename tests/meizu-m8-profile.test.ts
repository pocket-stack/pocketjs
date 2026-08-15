import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  MEIZU_M8_DEV_CONTRACTS,
  MEIZU_M8_DEV_HOST_ABI,
  MEIZU_M8_DEV_TARGET_ID,
  MEIZU_M8_LOGICAL_VIEWPORT,
  MEIZU_M8_PHYSICAL_VIEWPORT,
  resolveMeizuM8BuildPlan,
} from "../tools/meizu-m8-profile.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/meizu-m8-demo/pocket.json");

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("private Meizu M8 build profile", () => {
  test("uses the WinCE display and touch contract without changing public targets", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(MEIZU_M8_DEV_TARGET_ID);
    expect(MEIZU_M8_DEV_CONTRACTS.targets[MEIZU_M8_DEV_TARGET_ID]).toEqual({
      hostAbi: MEIZU_M8_DEV_HOST_ABI,
      platform: "wince",
      form: "takeover",
      display: {
        physicalViewport: MEIZU_M8_PHYSICAL_VIEWPORT,
        logicalViewports: [MEIZU_M8_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

  test("resolves the demo to the exact hardware plan", () => {
    const plan = resolveMeizuM8BuildPlan(manifest());
    expect(plan.target).toEqual({
      id: MEIZU_M8_DEV_TARGET_ID,
      hostAbi: MEIZU_M8_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: MEIZU_M8_LOGICAL_VIEWPORT,
      physical: MEIZU_M8_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("rejects unsupported buttons and a non-native logical viewport", () => {
    const needsButtons = manifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveMeizuM8BuildPlan(needsButtons)).toThrow("input.buttons");

    const stretched = manifest();
    stretched.app.viewport.fixed.logical = [320, 480];
    expect(() => resolveMeizuM8BuildPlan(stretched)).toThrow("320x480");
  });

  test("type-checks explicit PocketJS imports in the Solid demo", () => {
    const result = checkAppTypes({
      entry: join(repository, "apps/meizu-m8-demo/main.tsx"),
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

  test("pins the device, SDK, compiler image, QuickJS, and RAPI source", () => {
    const toolchain = JSON.parse(
      readFileSync(join(repository, "tools/cli/meizu-m8-toolchain.json"), "utf8"),
    );
    expect(toolchain).toMatchObject({
      toolchainVersion: "meizu-m8-wince6-armv4i-v1",
      device: {
        name: "MEIZU M8SE USB Serial",
        usbVendorId: "0547",
        usbProductId: "2720",
        platform: "Windows CE 6.0",
        physicalViewport: [480, 720],
      },
      transport: {
        protocol: "WceUsbSh ActiveSync serial",
        bulkInEndpoint: "81",
        bulkOutEndpoint: "02",
      },
    });
    expect(toolchain.sdk.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(toolchain.compiler.image).toContain("@sha256:");
    expect(toolchain.compiler.quickJsRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(toolchain.rapi.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the WinCE host records rendering and action-level hardware receipts", () => {
    const runtime = readFileSync(join(repository, "hosts/meizu-m8/runtime.c"), "utf8");
    const bridge = readFileSync(join(repository, "tools/meizu-m8/usb-serial.c"), "utf8");
    const stopOld = readFileSync(join(repository, "hosts/meizu-m8/stop-old.c"), "utf8");
    const tooling = readFileSync(join(repository, "tools/meizu-m8.ts"), "utf8");
    const sessionScript = readFileSync(
      join(repository, "tools/meizu-m8/start-session-macos.sh"),
      "utf8",
    );
    const app = readFileSync(join(repository, "apps/meizu-m8-demo/app.tsx"), "utf8");
    const shellIcon = readFileSync(join(repository, "apps/meizu-m8-demo/icon80.png"));
    const guestRuntime = readFileSync(
      join(repository, "hosts/iphone2g/pocket_runtime.c"),
      "utf8",
    );
    expect(runtime).toContain("SetDIBitsToDevice(");
    expect(runtime).not.toContain("HWND_TOPMOST");
    expect(runtime).toContain("word == VK_HOME || word == VK_ESCAPE");
    expect(runtime).not.toContain("case WM_ACTIVATE:");
    expect(guestRuntime).toContain("0x80000000U | (y << 10) | x");
    expect(tooling).toContain('fields.logical_viewport !== receipt.hostContract.viewport.logical.join("x")');
    expect(tooling).toContain("bytes.readInt32LE(18)");
    expect(tooling).toContain("bytes.readInt32LE(22)");
    expect(tooling).toContain('"SOFTWARE\\\\Meizu\\\\MiniOneShell\\\\Main\\\\PocketJS"');
    expect(tooling).toContain('"ExecFileName"');
    expect(tooling).toContain('"DefaultIcon"');
    expect(shellIcon.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(shellIcon.readUInt32BE(16)).toBe(80);
    expect(shellIcon.readUInt32BE(20)).toBe(80);
    expect(createHash("sha256").update(shellIcon).digest("hex")).toBe(
      "f0955dd664d26809c4b82d7dfd230cc81365ba2531e9418250e6dd6ddd93c28b",
    );
    expect(tooling).toContain("shipped iPhone 2G PocketJS Icon.png");
    expect(sessionScript).toContain('/usr/bin/pgrep -P "$PPPD_PID"');
    expect(sessionScript).toContain('kill -KILL "$PPPD_PID"');
    expect(runtime).toContain('"gdi_composites=%lu\\r\\n"');
    expect(runtime).toContain("pocket_runtime_hit_test_bounds");
    expect(runtime).toContain("pocket_runtime_action_sequence");
    expect(runtime).toContain('L".frame.bmp"');
    expect(runtime).toContain("POCKET_WIDEN(POCKET_BUILD_ID)");
    expect(runtime).toContain('"capture_successes=%lu\\r\\n"');
    expect(bridge).toContain('"CLIENTSERVER"');
    expect(stopOld).toContain("PROCESS_TERMINATE");
    expect(stopOld).toContain("WM_CLOSE");
    expect(stopOld).toContain('L"PocketJS-"');
    expect(app).toContain('reportAppAction("hero_tap", count)');
    expect(app).toContain('headline="JSX on M8"');
    expect(app).toContain("largeLayout");
    expect(app).not.toContain("JSX on Meizu M8");
  });
});
