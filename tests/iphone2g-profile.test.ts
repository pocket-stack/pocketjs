import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  IPHONE2G_DEV_CONTRACTS,
  IPHONE2G_DEV_HOST_ABI,
  IPHONE2G_DEV_TARGET_ID,
  IPHONE2G_VIEWPORT,
  resolveIPhone2GBuildPlan,
} from "../tools/iphone2g-profile.ts";

const REPOSITORY = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = join(REPOSITORY, "apps/iphone2g-demo/pocket.json");
const ENTRY_PATH = join(REPOSITORY, "apps/iphone2g-demo/main.tsx");
const APP_PATH = join(REPOSITORY, "apps/iphone2g-demo/app.tsx");
const INFO_PLIST_PATH = join(REPOSITORY, "hosts/iphone2g/Info.plist");
const RUNTIME_PATH = join(REPOSITORY, "hosts/iphone2g/runtime.c");
const ROOT_TSCONFIG = join(REPOSITORY, "tsconfig.json");
const JSX_DECLARATIONS = join(REPOSITORY, "framework/src/jsx.d.ts");

function demoManifest(): Record<string, any> {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function typeErrors(result: ReturnType<typeof checkAppTypes>): string {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.category === "error")
    .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
    .join("\n");
}

describe("private iPhone 2G build profile", () => {
  test("stays private and describes the original device display", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(IPHONE2G_DEV_TARGET_ID);
    expect(IPHONE2G_DEV_CONTRACTS.targets[IPHONE2G_DEV_TARGET_ID]).toEqual({
      hostAbi: IPHONE2G_DEV_HOST_ABI,
      platform: "iphoneos",
      form: "takeover",
      display: {
        physicalViewport: IPHONE2G_VIEWPORT,
        logicalViewports: [IPHONE2G_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    });
  });

  test("resolves the touch-only smoke demo to an exact device plan", () => {
    const plan = resolveIPhone2GBuildPlan(demoManifest());

    expect(plan.target).toEqual({
      id: IPHONE2G_DEV_TARGET_ID,
      hostAbi: IPHONE2G_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: IPHONE2G_VIEWPORT,
      physical: IPHONE2G_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "text.glyphs.baked": true,
    });
    expect(plan.app.entry).toBe("apps/iphone2g-demo/main.tsx");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("refuses capabilities and viewports the device profile cannot provide", () => {
    const needsButtons = demoManifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveIPhone2GBuildPlan(needsButtons)).toThrow(
      "input.buttons",
    );

    const wrongViewport = demoManifest();
    wrongViewport.app.viewport.fixed.logical = [480, 272];
    expect(() => resolveIPhone2GBuildPlan(wrongViewport)).toThrow("480x272");
  });

  test("type-checks the demo's explicit Solid and PocketJS imports", () => {
    const result = checkAppTypes({
      entry: ENTRY_PATH,
      tsconfigPath: ROOT_TSCONFIG,
      declarationFiles: [JSX_DECLARATIONS],
    });

    expect(typeErrors(result)).toBe("");
    expect(result.ok).toBe(true);
    expect(
      result.checkedFiles.some((file) =>
        file.endsWith("/apps/iphone2g-demo/main.tsx"),
      ),
    ).toBe(true);
    expect(
      result.checkedFiles.some((file) =>
        file.endsWith("/apps/iphone2g-demo/app.tsx"),
      ),
    ).toBe(true);
  });

  test("targets the restored 7E18 runtime with UIKit 3 launch and touch fallbacks", () => {
    const info = readFileSync(INFO_PLIST_PATH, "utf8");
    const runtime = readFileSync(RUNTIME_PATH, "utf8");
    const app = readFileSync(APP_PATH, "utf8");

    expect(info).toContain("<key>MinimumOSVersion</key>\n  <string>3.1.3</string>");
    expect(info).toContain("<key>CFBundleSupportedPlatforms</key>");
    expect(info).toContain("<string>iPhoneOS</string>");
    expect(info).toContain("<string>pocketjs-iphone2g-demo</string>");
    expect(info).toContain("<key>UIStatusBarHidden</key>\n  <true/>");

    expect(runtime).toContain('dlsym(handle, "UIGraphicsGetCurrentContext")');
    expect(runtime).toContain('dlsym(handle, "UICurrentContext")');
    expect(runtime).toContain('dlsym(handle, "GSEventGetLocationInWindow")');
    expect(runtime).not.toContain("extern CGPoint GSEventGetLocationInWindow");
    expect(runtime).toContain('sel_registerName("touchesBegan:withEvent:")');
    expect(runtime).toContain('sel_registerName("touchesCancelled:withEvent:")');
    expect(runtime).toContain("g_last_touch_hit = g_touch_hit");
    expect(runtime).toContain("g_last_touch_hit,");
    expect(runtime).toContain('sel_registerName("application:didFinishLaunchingWithOptions:")');
    expect(runtime).toContain('responds_to(g_window, "makeKeyAndVisible")');
    expect(runtime).not.toContain("extern CGContextRef UICurrentContext");
    expect(app).toContain("iPhone OS 3.1.3 / 7E18 / 320 x 480");
  });
});
