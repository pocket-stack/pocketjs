import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Private connected-device profile for the iPod touch (6th generation).
 *
 * The A8 device has a 640x1136 Retina display. UIKit exposes that as a
 * 320x568-point surface, and PocketSurfaceView rasterizes it at density 2.
 * The profile remains outside POCKET_TARGETS until the hardware path has a
 * repeatable build, deployment, launch, rendered-frame, and touch receipt.
 */
export const IPODTOUCH_DEV_TARGET_ID = "ipodtouch-dev";
export const IPODTOUCH_DEV_HOST_ABI = 7;
export const IPODTOUCH_LOGICAL_VIEWPORT = [320, 568] as const;
export const IPODTOUCH_RASTER_DENSITY = 2;
export const IPODTOUCH_PHYSICAL_VIEWPORT = [640, 1136] as const;

export const IPODTOUCH_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPODTOUCH_DEV_TARGET_ID]: {
      hostAbi: IPODTOUCH_DEV_HOST_ABI,
      platform: "iphoneos",
      form: "takeover",
      display: {
        physicalViewport: IPODTOUCH_PHYSICAL_VIEWPORT,
        logicalViewports: [IPODTOUCH_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPODTOUCH_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    },
  }),
);

export function resolveIPodTouchBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPODTOUCH_DEV_TARGET_ID },
    IPODTOUCH_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket ipodtouch: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
