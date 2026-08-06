import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
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
const ICON_PATH = join(REPOSITORY, "hosts/iphone2g/Icon.png");
const RUNTIME_PATH = join(REPOSITORY, "hosts/iphone2g/runtime.c");
const POCKET_RUNTIME_PATH = join(REPOSITORY, "hosts/iphone2g/pocket_runtime.c");
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

  test("resolves the touch-only Hero demo to an exact device plan", () => {
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

  test("ships a precomposed skeuomorphic metal SpringBoard icon", async () => {
    expect(
      createHash("sha256").update(readFileSync(ICON_PATH)).digest("hex"),
    ).toBe("198a1c3768a028d825da6b1e2213434766ad1ed0fe9c4350f901440cad062a2f");
    const image = await loadImage(ICON_PATH);
    expect([image.width, image.height]).toEqual([59, 60]);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixelAt = (x: number, y: number) =>
      Array.from(context.getImageData(x, y, 1, 1).data);
    const alphaAt = (x: number, y: number) => pixelAt(x, y)[3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(58, 0)).toBe(0);
    expect(alphaAt(0, 59)).toBe(0);
    expect(alphaAt(58, 59)).toBe(0);
    expect(alphaAt(29, 29)).toBe(255);
    expect(pixelAt(10, 48)).toEqual([5, 5, 4, 255]);
    expect(pixelAt(29, 0)).toEqual([176, 180, 188, 255]);
    expect(pixelAt(29, 8)).toEqual([110, 109, 109, 255]);
    expect(pixelAt(29, 29).slice(0, 3)).toEqual([249, 249, 249]);
  });

  test("targets the restored 7E18 runtime with UIKit 3 and action-level acceptance", () => {
    const info = readFileSync(INFO_PLIST_PATH, "utf8");
    const runtime = readFileSync(RUNTIME_PATH, "utf8");
    const pocketRuntime = readFileSync(POCKET_RUNTIME_PATH, "utf8");
    const app = readFileSync(APP_PATH, "utf8");

    expect(info).toContain(
      "<key>MinimumOSVersion</key>\n  <string>3.1.3</string>",
    );
    expect(info).toContain("<key>CFBundleSupportedPlatforms</key>");
    expect(info).toContain("<string>iPhoneOS</string>");
    expect(info).toContain("<string>pocketjs-iphone2g-demo</string>");
    expect(info).toContain("<key>UIStatusBarHidden</key>\n  <true/>");

    expect(runtime).toContain('dlsym(handle, "UIGraphicsGetCurrentContext")');
    expect(runtime).toContain('dlsym(handle, "UICurrentContext")');
    expect(runtime).toContain('dlsym(handle, "GSEventGetLocationInWindow")');
    expect(runtime).not.toContain("extern CGPoint GSEventGetLocationInWindow");
    expect(runtime).toContain('sel_registerName("touchesBegan:withEvent:")');
    expect(runtime).toContain(
      'sel_registerName("touchesCancelled:withEvent:")',
    );
    expect(runtime).toContain(
      '"schema=2\\nbuild_id=%s\\nstate=%s\\npid=%ld\\nwritten_at=%ld\\nheartbeat=%lu\\n"',
    );
    expect(runtime).toContain(
      "completed_touch = !delivered_touch && g_touch_awaiting_completion",
    );
    expect(runtime).toContain("g_completed_touch_sequences += 1");
    expect(runtime).toContain("POCKET_STATUS_HEARTBEAT_FRAMES");
    expect(runtime).not.toContain("g_guest_frames == 1 || delivered_touch");
    expect(pocketRuntime).toContain('"__reportAppAction"');
    expect(pocketRuntime).toContain("reported_action_sequence += 1");
    expect(runtime).toContain(
      'sel_registerName("application:didFinishLaunchingWithOptions:")',
    );
    expect(runtime).toContain('responds_to(g_window, "makeKeyAndVisible")');
    expect(runtime).not.toContain("extern CGContextRef UICurrentContext");
    expect(app).toContain('actionLabel="Tap Hero"');
    expect(app).toContain('headline="JSX on ARMv6."');
    expect(app).toContain('reportAppAction("hero_tap", count)');
    expect(app).toContain("presentationHz={60}");
  });
});
