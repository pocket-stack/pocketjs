import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Exact-device development profile for the ONYX BOOX Leaf3. */
export const BOOX_LEAF3_ANDROID_DEV_TARGET_ID = "boox-leaf3-android-dev";
export const BOOX_LEAF3_HOST_ABI = 9;
export const BOOX_LEAF3_LOGICAL_VIEWPORT = [320, 480] as const;
export const BOOX_LEAF3_PHYSICAL_VIEWPORT = [1264, 1680] as const;
export const BOOX_LEAF3_RASTER_DENSITY = 3;

export const BOOX_LEAF3_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [BOOX_LEAF3_ANDROID_DEV_TARGET_ID]: {
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
    },
  }),
);

export function resolveBooxLeaf3BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: BOOX_LEAF3_ANDROID_DEV_TARGET_ID },
    BOOX_LEAF3_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket boox-leaf3: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
