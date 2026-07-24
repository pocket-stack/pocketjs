import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Transitional Nokia E7 profile used only by `pocket symbian`.
 *
 * It deliberately stays out of the production `POCKET_TARGETS` registry until
 * the E7 host has passed the full hardware acceptance suite. The Qt window is
 * the PocketJS surface: its 640x360 landscape and 360x640 portrait geometries
 * are native logical viewports, with live relayout when Symbian rotates it.
 */
export const SYMBIAN_E7_DEV_TARGET_ID = "symbian-e7-dev";
export const SYMBIAN_E7_DEV_HOST_ABI = 1;
export const SYMBIAN_E7_DEFAULT_VIEWPORT = [640, 360] as const;
export const SYMBIAN_E7_MIN_VIEWPORT = [360, 360] as const;
export const SYMBIAN_E7_MAX_VIEWPORT = [640, 640] as const;

export const SYMBIAN_E7_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [SYMBIAN_E7_DEV_TARGET_ID]: {
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
      platform: "symbian",
      form: "window",
      display: {
        physicalViewport: SYMBIAN_E7_DEFAULT_VIEWPORT,
        logicalViewports: [SYMBIAN_E7_DEFAULT_VIEWPORT],
        dynamicViewport: {
          min: SYMBIAN_E7_MIN_VIEWPORT,
          max: SYMBIAN_E7_MAX_VIEWPORT,
        },
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.buttons",
        "display.viewport.live",
        "text.glyphs.baked",
      ],
    },
  }),
);

export function resolveSymbianE7BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: SYMBIAN_E7_DEV_TARGET_ID },
    SYMBIAN_E7_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket symbian: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
