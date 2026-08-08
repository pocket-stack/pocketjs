import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { POCKET_PACKAGE_TARGET_BYTES } from "../contracts/spec/pocket-package.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  validateAndResolveBuildPlan,
  validatePlatformContractRegistry,
} from "../framework/src/manifest/resolve.ts";
import {
  resolve3dsBuildPlan,
  THREE_DS_DEV_CONTRACTS,
  THREE_DS_DEV_HOST_ABI,
  THREE_DS_DEV_TARGET_ID,
  THREE_DS_VIEWPORT,
} from "../tools/3ds-profile.ts";

/** A guest app declaring the top screen exactly: 400x240 logical, native. */
function topScreenManifest(): Record<string, any> {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.pocket-stack.3ds-demo",
    name: "pocketjs-3ds-hero",
    title: "PocketJS: 3DS Hero",
    version: "0.1.0",
    engine: {
      capabilities: {
        requires: ["input.buttons", "text.glyphs.baked"],
        enhances: ["input.analog.left", "audio.pcm"],
      },
    },
    app: {
      entry: "apps/3ds-demo/main.tsx",
      output: "pocket3ds-demo-main",
      framework: "solid",
      viewport: {
        fixed: { logical: [400, 240], presentation: "native" },
      },
    },
  };
}

function diagnosticCodes(manifest: unknown): string[] {
  const resolution = validateAndResolveBuildPlan(
    manifest,
    { target: THREE_DS_DEV_TARGET_ID },
    THREE_DS_DEV_CONTRACTS,
  );
  expect(resolution.ok).toBe(false);
  return resolution.ok ? [] : resolution.diagnostics.map((d) => d.code);
}

describe("private Nintendo 3DS build profile", () => {
  test("stays private and describes the top screen", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(THREE_DS_DEV_TARGET_ID);
    expect(THREE_DS_DEV_CONTRACTS.targets[THREE_DS_DEV_TARGET_ID]).toEqual({
      hostAbi: THREE_DS_DEV_HOST_ABI,
      platform: "3ds",
      form: "takeover",
      display: {
        physicalViewport: THREE_DS_VIEWPORT,
        logicalViewports: [THREE_DS_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.analog.left",
        "input.buttons",
        "input.cursor",
        "text.glyphs.baked",
      ],
    });
    expect(validatePlatformContractRegistry(THREE_DS_DEV_CONTRACTS)).toEqual([]);
  });

  test("takes the next hostAbi in the registry-wide sequence", () => {
    // hostAbi is one sequence across every profile, private ones included:
    // 1 psp, 2 vita, 3 macos-widget, 4 symbian-e7-dev, 5 pocketbook,
    // 6 iphone2g-dev. A collision would let a bundle mount on the wrong host.
    expect(THREE_DS_DEV_HOST_ABI).toBe(7);
    expect(
      Object.values(POCKET_TARGETS).map((profile) => profile.hostAbi),
    ).not.toContain(THREE_DS_DEV_HOST_ABI);
    // The .pocket container stores the target id in a NUL-padded fixed field.
    expect(new TextEncoder().encode(THREE_DS_DEV_TARGET_ID).length).toBeLessThan(
      POCKET_PACKAGE_TARGET_BYTES,
    );
  });

  test("resolves a 400x240 native app to an exact device plan", () => {
    const plan = resolve3dsBuildPlan(topScreenManifest());

    expect(plan.target).toEqual({
      id: THREE_DS_DEV_TARGET_ID,
      hostAbi: THREE_DS_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: THREE_DS_VIEWPORT,
      physical: THREE_DS_VIEWPORT,
      presentation: "native",
      rasterDensity: 1,
      policy: "fixed",
    });
    // The nub is provided, so the enhancement resolves true; the host ships no
    // audio module in v1, so audio.pcm resolves false instead of failing.
    expect(plan.features).toEqual({
      "audio.pcm": false,
      "input.analog.left": true,
      "input.buttons": true,
      "text.glyphs.baked": true,
    });
    expect(plan.app.entry).toBe("apps/3ds-demo/main.tsx");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("rejects the 480x272 integer-fit corpus", () => {
    // The top screen is smaller than 480x272 on both axes and the resolver has
    // no scaling fallback, so the stock PSP-shaped app corpus cannot be
    // admitted here — 3DS apps declare their own 400x240 native viewport.
    const psp = topScreenManifest();
    psp.app.viewport.fixed = {
      logical: [480, 272],
      presentation: "integer-fit",
    };
    expect(diagnosticCodes(psp)).toEqual([
      "viewport.logicalUnsupported",
      "viewport.presentationUnsupported",
      // 400/480 and 240/272 are not one positive integer scale.
      "viewport.integerFitMismatch",
    ]);
    expect(() => resolve3dsBuildPlan(psp)).toThrow("480x272");
  });

  test("refuses capabilities the top-screen host cannot provide", () => {
    // The touchscreen is the bottom screen: its contacts are not top-screen
    // logical coordinates, so input.touch is not advertised.
    const needsTouch = topScreenManifest();
    needsTouch.engine.capabilities.requires.push("input.touch");
    expect(diagnosticCodes(needsTouch)).toEqual(["capability.unavailable"]);
    expect(() => resolve3dsBuildPlan(needsTouch)).toThrow("input.touch");

    const needsRuntimeGlyphs = topScreenManifest();
    needsRuntimeGlyphs.engine.capabilities.requires.push("text.glyphs.runtime");
    expect(diagnosticCodes(needsRuntimeGlyphs)).toEqual([
      "capability.unavailable",
    ]);
  });

  test("forbids a dynamic viewport on a takeover form", () => {
    const dynamic = topScreenManifest();
    dynamic.app.viewport = { dynamic: { default: [400, 240] } };
    expect(diagnosticCodes(dynamic)).toEqual(["viewport.fixedRequired"]);
  });

  test("publishes the core's viewport as ui.__viewport", () => {
    // framework/src/index.ts sizes the mounted app and overlay layers from
    // ui.__viewport and falls back to the 480x272 spec screen when a host
    // omits it, which lays a 400x240 app out 80 px too wide and pushes every
    // right-anchored element off the panel. Nothing catches that without an
    // emulator, so the publication is pinned here — read back from the core
    // rather than re-derived, so the JS layer and the native root cannot drift.
    const qjs = readFileSync(
      join(new URL("..", import.meta.url).pathname, "hosts/3ds/src/qjs.c"),
      "utf8",
    );
    expect(qjs).toContain('JS_SetPropertyStr(context, ui, "__viewport", viewport)');
    expect(qjs).toContain("ui_viewport_width()");
    expect(qjs).toContain("ui_viewport_height()");
  });
});
