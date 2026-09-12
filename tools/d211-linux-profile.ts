import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Development profile for the ArtInChip D211DBV running Luban
 * Linux 5.10.
 *
 * The logical surface is the full 800x480 panel at raster density 1. Host ABI
 * 11 reserves the wire generation for this host while it remains private.
 */
export const D211_LINUX_DEV_TARGET_ID = "d211-linux-dev";
export const D211_LINUX_DEV_HOST_ABI = 11;
export const D211_LINUX_LOGICAL_VIEWPORT = [800, 480] as const;
export const D211_LINUX_PHYSICAL_VIEWPORT = [800, 480] as const;

export const D211_LINUX_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [D211_LINUX_DEV_TARGET_ID]: {
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
    },
  }),
);

export function resolveD211LinuxBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: D211_LINUX_DEV_TARGET_ID },
    D211_LINUX_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket d211-linux: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
