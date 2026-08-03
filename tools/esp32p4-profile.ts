import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * Experimental full-PocketJS guest profile for the Waveshare 7B host.
 *
 * This deliberately stays outside the production `POCKET_TARGETS` registry.
 * The native QuickJS/HostOps host is still being brought up, so only the
 * manifest compiler may opt into this profile today.
 *
 * The guest surface follows the PocketBook precedent: PocketJS renders its
 * 480x272 logical viewport at density 2 into a nominal 960x544 RGB565 surface.
 * The board presenter centers that surface on the real 1024x600 panel. Keeping
 * the two facts separate preserves the exact integer-fit guest contract while
 * retaining truthful board geometry for input and presentation integration.
 */
export const ESP32P4_WAVESHARE_7B_DEV_TARGET_ID = "esp32p4-waveshare-7b-dev";
export const ESP32P4_WAVESHARE_7B_DEV_HOST_ABI = 6;
export const ESP32P4_WAVESHARE_7B_BOARD_ID =
  "waveshare-esp32-p4-wifi6-touch-lcd-7b";
export const ESP32P4_WAVESHARE_7B_LOGICAL_VIEWPORT = [480, 272] as const;
export const ESP32P4_WAVESHARE_7B_GUEST_SURFACE = [960, 544] as const;
export const ESP32P4_WAVESHARE_7B_PANEL = [1024, 600] as const;
export const ESP32P4_WAVESHARE_7B_CONTENT_RECT = {
  x: 32,
  y: 28,
  width: 960,
  height: 544,
} as const;

export const ESP32P4_WAVESHARE_7B_DEV_CONTRACTS =
  definePlatformContractRegistry(
    POCKET_CAPABILITIES,
    defineTargetRegistry({
      [ESP32P4_WAVESHARE_7B_DEV_TARGET_ID]: {
        hostAbi: ESP32P4_WAVESHARE_7B_DEV_HOST_ABI,
        platform: "esp32p4",
        form: "takeover",
        display: {
          physicalViewport: ESP32P4_WAVESHARE_7B_GUEST_SURFACE,
          logicalViewports: [ESP32P4_WAVESHARE_7B_LOGICAL_VIEWPORT],
          presentations: ["integer-fit"],
          rasterDensity: 2,
        },
        capabilities: [
          "input.buttons",
          "input.touch",
          "text.glyphs.baked",
        ],
      },
    }),
  );

export function resolveEsp32P4Waveshare7BBuildPlan(
  input: unknown,
): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: ESP32P4_WAVESHARE_7B_DEV_TARGET_ID },
    ESP32P4_WAVESHARE_7B_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket esp32p4: manifest did not resolve: ${resolution.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.path || "/"}: ${diagnostic.message}`,
        )
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
