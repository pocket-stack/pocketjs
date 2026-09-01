import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

export const ROCKBOX_IPOD_CLASSIC_TARGET_ID = "rockbox-ipod-classic-dev";
export const ROCKBOX_IPOD_CLASSIC_HOST_ABI = 9;
export const ROCKBOX_IPOD_CLASSIC_VIEWPORT = [320, 240] as const;

/** Development-only until the .rock plugin passes physical click-wheel tests. */
export const ROCKBOX_IPOD_CLASSIC_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [ROCKBOX_IPOD_CLASSIC_TARGET_ID]: {
      hostAbi: ROCKBOX_IPOD_CLASSIC_HOST_ABI,
      platform: "rockbox-ipod-classic",
      form: "takeover",
      display: {
        physicalViewport: ROCKBOX_IPOD_CLASSIC_VIEWPORT,
        logicalViewports: [ROCKBOX_IPOD_CLASSIC_VIEWPORT],
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: ["input.buttons", "text.glyphs.baked"],
    },
  }),
);

export function resolveRockboxBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: ROCKBOX_IPOD_CLASSIC_TARGET_ID },
    ROCKBOX_IPOD_CLASSIC_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket rockbox: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
