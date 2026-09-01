import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/**
 * TI-Nspire CX II development profile.
 *
 * It stays outside POCKET_TARGETS until the Ndless binary has passed a real
 * calculator boot/render/input run. The CX II owns one 320x240 RGB565 screen.
 * Its touchpad is sampled as a two-axis controller; PocketJS can therefore
 * synthesize its hardware-neutral cursor without exposing Ndless APIs to apps.
 */
export const NSPIRE_CX2_DEV_TARGET_ID = "nspire-cx2-dev";
export const NSPIRE_CX2_DEV_HOST_ABI = 9;
export const NSPIRE_CX2_VIEWPORT = [320, 240] as const;

export const NSPIRE_CX2_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [NSPIRE_CX2_DEV_TARGET_ID]: {
      hostAbi: NSPIRE_CX2_DEV_HOST_ABI,
      platform: "nspire-cx2",
      form: "takeover",
      display: {
        physicalViewport: NSPIRE_CX2_VIEWPORT,
        logicalViewports: [NSPIRE_CX2_VIEWPORT],
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

export function resolveNspireCx2BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: NSPIRE_CX2_DEV_TARGET_ID },
    NSPIRE_CX2_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket nspire: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
