import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Development profile for the original Windows CE 6 Meizu M8/M8SE.
 *
 * The logical surface matches the 480x720 LCD. Host ABI 8's wide touch words
 * carry the full native coordinate range without device-specific app input.
 * It remains private until the full hardware acceptance receipt passes.
 */
export const MEIZU_M8_DEV_TARGET_ID = "meizu-m8-dev";
export const MEIZU_M8_DEV_HOST_ABI = 8;
export const MEIZU_M8_LOGICAL_VIEWPORT = [480, 720] as const;
export const MEIZU_M8_PHYSICAL_VIEWPORT = [480, 720] as const;

export const MEIZU_M8_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [MEIZU_M8_DEV_TARGET_ID]: {
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
    },
  }),
);

export function resolveMeizuM8BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: MEIZU_M8_DEV_TARGET_ID },
    MEIZU_M8_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket meizu-m8: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
