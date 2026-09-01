import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the iPhone 4S running iOS 6.1.3. */
export const IPHONE4S_DEV_TARGET_ID = "iphone4s-dev";
export const IPHONE4S_DEV_HOST_ABI = 8;
export const IPHONE4S_LOGICAL_VIEWPORT = [320, 480] as const;
export const IPHONE4S_PHYSICAL_VIEWPORT = [640, 960] as const;
export const IPHONE4S_RASTER_DENSITY = 2;

export const IPHONE4S_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPHONE4S_DEV_TARGET_ID]: {
      hostAbi: IPHONE4S_DEV_HOST_ABI,
      platform: "iphoneos",
      form: "takeover",
      display: {
        physicalViewport: IPHONE4S_PHYSICAL_VIEWPORT,
        logicalViewports: [IPHONE4S_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: IPHONE4S_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    },
  }),
);

export function resolveIPhone4SBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPHONE4S_DEV_TARGET_ID },
    IPHONE4S_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket iphone4s: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
