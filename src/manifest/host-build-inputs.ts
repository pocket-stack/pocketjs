import {
  PRESENTATION_MODES,
  type PresentationMode,
  type Viewport,
} from "../../spec/platforms.ts";
import { verifyPlanHash, type ResolvedBuildPlan } from "./plan.ts";

/** Stable subset of the internal build plan consumed by custom native hosts. */
export interface HostBuildInputs {
  readonly appOutput: string;
  readonly target: string;
  readonly hostAbi: number;
  readonly viewport: {
    readonly logical: Viewport;
    readonly physical: Viewport;
    readonly presentation: PresentationMode;
    readonly rasterDensity: number;
  };
}

export interface ExtractHostBuildInputsOptions {
  readonly expectedTarget?: string;
}

export interface HostBuildEnvironmentOptions {
  readonly outputDirectory: string;
  readonly embedApp: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isViewport(value: unknown): value is Viewport {
  return Array.isArray(value) && value.length === 2 && value.every((part) =>
    typeof part === "number" && Number.isInteger(part) && part > 0
  );
}

function hasHostInputShape(input: unknown): input is ResolvedBuildPlan {
  if (!isRecord(input) || !isRecord(input.app) || !isRecord(input.target)) return false;
  if (!isRecord(input.viewport) || !isRecord(input.features)) return false;
  if (
    typeof input.app.id !== "string" || input.app.id.length === 0 ||
    typeof input.app.title !== "string" || input.app.title.length === 0
  ) return false;
  if (typeof input.app.output !== "string" || input.app.output.length === 0) return false;
  if (typeof input.target.id !== "string" || input.target.id.length === 0) return false;
  if (!Number.isInteger(input.target.hostAbi) || (input.target.hostAbi as number) < 1) return false;
  if (!isViewport(input.viewport.logical) || !isViewport(input.viewport.physical)) return false;
  if (!PRESENTATION_MODES.includes(input.viewport.presentation as PresentationMode)) return false;
  if (
    !Number.isInteger(input.viewport.rasterDensity) ||
    (input.viewport.rasterDensity as number) < 1 ||
    (input.viewport.rasterDensity as number) > 255
  ) return false;
  if (typeof input.planHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.planHash)) return false;
  return Object.values(input.features).every((available) => typeof available === "boolean");
}

function readVerifiedPlan(input: unknown): ResolvedBuildPlan {
  if (!hasHostInputShape(input)) {
    throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan shape");
  }
  try {
    if (!verifyPlanHash(input)) {
      throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan checksum");
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("PocketJS host build:")) {
      throw error;
    }
    throw new TypeError("PocketJS host build: invalid ResolvedBuildPlan shape", { cause: error });
  }
  return input;
}

/**
 * Verify an internal plan and project it onto the stable custom-host boundary.
 * Custom hosts should not import or retain the complete ResolvedBuildPlan.
 */
export function extractHostBuildInputs(
  input: unknown,
  options: ExtractHostBuildInputsOptions = {},
): HostBuildInputs {
  const plan = readVerifiedPlan(input);
  if (options.expectedTarget && plan.target.id !== options.expectedTarget) {
    throw new TypeError(
      `PocketJS host build: expected target ${options.expectedTarget}, got ${plan.target.id}`,
    );
  }
  return {
    appOutput: plan.app.output,
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    viewport: {
      logical: plan.viewport.logical,
      physical: plan.viewport.physical,
      presentation: plan.viewport.presentation,
      rasterDensity: plan.viewport.rasterDensity,
    },
  };
}

/** Build the target-neutral environment shared by framework and custom crates. */
export function hostBuildEnvironment(
  inputs: HostBuildInputs,
  options: HostBuildEnvironmentOptions,
): Readonly<Record<string, string>> {
  return {
    POCKETJS_APP_OUTPUT: inputs.appOutput,
    POCKETJS_EMBED_APP: options.embedApp ? "1" : "0",
    POCKETJS_OUTPUT_DIR: options.outputDirectory,
    POCKETJS_TARGET: inputs.target,
    POCKETJS_HOST_ABI: String(inputs.hostAbi),
    POCKETJS_LOGICAL_WIDTH: String(inputs.viewport.logical[0]),
    POCKETJS_LOGICAL_HEIGHT: String(inputs.viewport.logical[1]),
    POCKETJS_PHYSICAL_WIDTH: String(inputs.viewport.physical[0]),
    POCKETJS_PHYSICAL_HEIGHT: String(inputs.viewport.physical[1]),
    POCKETJS_PRESENTATION: inputs.viewport.presentation,
    POCKETJS_RASTER_DENSITY: String(inputs.viewport.rasterDensity),
  };
}
