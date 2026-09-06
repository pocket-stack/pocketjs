import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Private exact-device profiles for the BlackBerry Classic (SQC100).
 *
 * The Classic has two PocketJS hosts that differ only below the QuickJS
 * bridge: `hosts/blackberry-classic-qnx` is a BlackBerry 10 Core Native
 * application, while `hosts/blackberry-classic-android` runs inside the
 * BlackBerry 10 Android Runtime.
 * Both present the same 720×720 panel, take the same keyboard, trackpad, and
 * touch input through the portable button and touch contracts, and mount the
 * same guest bundle shape, so they share one display and capability contract
 * and one host ABI. They are registered as two targets because the target id
 * is compiled into the guest and the native host and checked at boot.
 */
export const BLACKBERRY_QNX_DEV_TARGET_ID = "blackberry-qnx-dev";
export const BLACKBERRY_ANDROID_DEV_TARGET_ID = "blackberry-android-dev";
export type BlackBerryClassicTargetId =
  | typeof BLACKBERRY_QNX_DEV_TARGET_ID
  | typeof BLACKBERRY_ANDROID_DEV_TARGET_ID;

export const BLACKBERRY_CLASSIC_HOST_ABI = 9;
export const BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT = [360, 360] as const;
export const BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT = [720, 720] as const;
export const BLACKBERRY_CLASSIC_RASTER_DENSITY = 2;

const CLASSIC_DISPLAY = {
  physicalViewport: BLACKBERRY_CLASSIC_PHYSICAL_VIEWPORT,
  logicalViewports: [BLACKBERRY_CLASSIC_LOGICAL_VIEWPORT],
  presentations: ["native"],
  rasterDensity: BLACKBERRY_CLASSIC_RASTER_DENSITY,
} as const;

const CLASSIC_CAPABILITIES = [
  "input.buttons",
  "input.touch",
  "text.glyphs.baked",
] as const;

export const BLACKBERRY_CLASSIC_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [BLACKBERRY_QNX_DEV_TARGET_ID]: {
      hostAbi: BLACKBERRY_CLASSIC_HOST_ABI,
      platform: "blackberry10-qnx",
      form: "takeover",
      display: CLASSIC_DISPLAY,
      capabilities: CLASSIC_CAPABILITIES,
    },
    [BLACKBERRY_ANDROID_DEV_TARGET_ID]: {
      hostAbi: BLACKBERRY_CLASSIC_HOST_ABI,
      platform: "blackberry10-android",
      form: "takeover",
      display: CLASSIC_DISPLAY,
      capabilities: CLASSIC_CAPABILITIES,
    },
  }),
);

export function resolveBlackBerryClassicBuildPlan(
  input: unknown,
  target: BlackBerryClassicTargetId,
): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target },
    BLACKBERRY_CLASSIC_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket blackberry-classic: manifest did not resolve for ${target}: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
