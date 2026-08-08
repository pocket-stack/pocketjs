import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Transitional Nintendo 3DS profile used only by `bun run 3ds`.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the citro3d host has passed the full hardware acceptance suite. The app owns
 * the 400x240 top screen: the PICA200 render target is that panel exactly, so
 * the only presentation is native at density 1.
 *
 * The touchscreen is the *bottom* screen (320x240) and is not advertised —
 * reporting its contacts as logical coordinates inside the top screen's space
 * would be a lie. That needs a second-surface design, not a capability id.
 */
export const THREE_DS_DEV_TARGET_ID = "3ds-dev";
export const THREE_DS_DEV_HOST_ABI = 7;
export const THREE_DS_VIEWPORT = [400, 240] as const;

export const THREE_DS_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [THREE_DS_DEV_TARGET_ID]: {
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
    },
  }),
);

export function resolve3dsBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: THREE_DS_DEV_TARGET_ID },
    THREE_DS_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket 3ds: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
