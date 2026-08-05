import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Transitional iPhone 2G profile used only by the private device toolchain.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the iPhone OS 3.1.3 host has passed the full hardware acceptance suite. The
 * application owns the original 320x480 display and receives touch input in
 * the same logical coordinate space.
 */
export const IPHONE2G_DEV_TARGET_ID = "iphone2g-dev";
export const IPHONE2G_DEV_HOST_ABI = 6;
export const IPHONE2G_VIEWPORT = [320, 480] as const;

export const IPHONE2G_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [IPHONE2G_DEV_TARGET_ID]: {
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
    },
  }),
);

export function resolveIPhone2GBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: IPHONE2G_DEV_TARGET_ID },
    IPHONE2G_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket iphone2g: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
