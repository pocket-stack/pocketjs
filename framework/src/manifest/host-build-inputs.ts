import {
  PRESENTATION_MODES,
  type PresentationMode,
  type Viewport,
} from "../../../contracts/spec/platforms.ts";
import {
  NETWORK_CONNECT_PROTOCOLS,
  NETWORK_LISTEN_PROTOCOLS,
} from "../../../contracts/spec/pocket-manifest.ts";
import {
  canonicalJson,
  verifyPlanHash,
  type ResolvedBuildPlan,
  type ResolvedNetworkBuildPlan,
} from "./plan.ts";

export interface HostNetworkBuildInputs extends ResolvedNetworkBuildPlan {
  readonly planHash: string;
  readonly features: Readonly<Record<string, boolean>>;
}

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
  /** Present only for a format-3 plan with admitted network authority. */
  readonly network?: HostNetworkBuildInputs;
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const known = new Set(allowed);
  return Object.keys(value).every((key) => known.has(key));
}

function isResolvedPort(value: unknown, ephemeral: boolean): boolean {
  if (!isRecord(value)) return false;
  if (ephemeral && value.ephemeral === true && hasOnlyKeys(value, ["ephemeral"])) return true;
  return hasOnlyKeys(value, ["min", "max"]) &&
    Number.isInteger(value.min) && Number.isInteger(value.max) &&
    (value.min as number) >= 1 && (value.max as number) <= 65535 &&
    (value.min as number) <= (value.max as number);
}

function isConnectPermission(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["protocol", "host", "port"]) &&
    NETWORK_CONNECT_PROTOCOLS.includes(value.protocol as never) &&
    typeof value.host === "string" && value.host.length > 0 &&
    isResolvedPort(value.port, false);
}

function isListenPermission(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, ["protocol", "address", "port"]) &&
    NETWORK_LISTEN_PROTOCOLS.includes(value.protocol as never) &&
    typeof value.address === "string" && value.address.length > 0 &&
    isResolvedPort(value.port, true);
}

const RESOURCE_KEYS: Readonly<Record<string, readonly string[]>> = {
  runtime: ["connections", "pendingOperations", "completionDescriptors", "nativeBufferBytes"],
  stream: ["receiveQueueBytes", "sendQueueBytes"],
  http: ["connections", "inflightRequests", "headerBytes", "headerCount", "bufferedBodyBytes"],
  websocket: ["connections", "messageBytes", "queuedMessages"],
  mqtt: ["connections", "packetBytes", "qos1Inflight", "receiveQueueBytes"],
  udp: ["sockets", "datagramBytes", "receiveDatagrams"],
};

function isResourceMinimum(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, Object.keys(RESOURCE_KEYS))) return false;
  return Object.entries(value).every(([group, limits]) =>
    isRecord(limits) && hasOnlyKeys(limits, RESOURCE_KEYS[group]!) &&
    Object.values(limits).every((limit) => Number.isSafeInteger(limit) && (limit as number) > 0)
  );
}

function hasNetworkPlanShape(value: unknown): value is ResolvedNetworkBuildPlan {
  if (!isRecord(value) || !isRecord(value.policy) || !isRecord(value.providers) ||
    !isRecord(value.resources)) return false;
  if (!hasOnlyKeys(value, ["policy", "providers", "resources"]) ||
    !hasOnlyKeys(value.policy, [
      "version",
      "connect",
      "listen",
      "localNetwork",
      "insecureTransport",
      "broadcast",
      "multicast",
      "allowInvalidTlsForDevelopment",
      "browserAmbientCredentials",
      "browserOpaqueWebSocketRedirects",
      "credentials",
    ]) || !hasOnlyKeys(value.providers, ["backendByRole", "tlsByRole", "netDriverId"]) ||
    !hasOnlyKeys(value.resources, ["minimum"])) return false;
  if (value.policy.version !== 1 || !Array.isArray(value.policy.connect) ||
    !Array.isArray(value.policy.listen) || !Array.isArray(value.policy.credentials)) return false;
  if (!value.policy.connect.every(isConnectPermission) ||
    !value.policy.listen.every(isListenPermission)) return false;
  for (const key of [
    "localNetwork",
    "insecureTransport",
    "broadcast",
    "multicast",
    "allowInvalidTlsForDevelopment",
    "browserAmbientCredentials",
    "browserOpaqueWebSocketRedirects",
  ]) {
    if (typeof value.policy[key] !== "boolean") return false;
  }
  if (!value.policy.credentials.every((credential) => typeof credential === "string")) return false;
  if (!isRecord(value.providers.backendByRole) || !isRecord(value.providers.tlsByRole) ||
    typeof value.providers.netDriverId !== "string" || value.providers.netDriverId.length === 0) return false;
  if (!hasOnlyKeys(value.providers.backendByRole, [
    "http.client",
    "http.server",
    "websocket.client",
    "websocket.server",
    "mqtt.client",
  ]) || !hasOnlyKeys(value.providers.tlsByRole, [
    "http.client",
    "http.server",
    "websocket.client",
    "websocket.server",
    "mqtt.client",
    "tcp.client",
    "tcp.server",
  ])) return false;
  // This boundary verifies the resolved plan's structure and checksum. The
  // resolver already validates provider-id syntax; Host descriptor admission
  // later requires exact id/role selection equality.
  if (!Object.values(value.providers.backendByRole).every((id) => typeof id === "string")) return false;
  if (!Object.values(value.providers.tlsByRole).every((selection) =>
    isRecord(selection) && hasOnlyKeys(selection, ["source", "id"]) &&
    (selection.source === "provider" || selection.source === "backend") &&
    typeof selection.id === "string"
  )) return false;
  return isResourceMinimum(value.resources.minimum);
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item))) as T;
  }
  if (isRecord(value)) {
    const clone = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneAndFreeze(child)]),
    );
    return Object.freeze(clone) as T;
  }
  return value;
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
  if (!Object.values(input.features).every((available) => typeof available === "boolean")) return false;
  if (input.selectedCapabilityOptions !== undefined &&
    (!Array.isArray(input.selectedCapabilityOptions) ||
      !input.selectedCapabilityOptions.every((option) =>
        Array.isArray(option) && option.every((capability) => typeof capability === "string")
      ))) return false;
  return input.network === undefined || hasNetworkPlanShape(input.network);
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
  const projected: HostBuildInputs = {
    appOutput: plan.app.output,
    target: plan.target.id,
    hostAbi: plan.target.hostAbi,
    viewport: {
      logical: plan.viewport.logical,
      physical: plan.viewport.physical,
      presentation: plan.viewport.presentation,
      rasterDensity: plan.viewport.rasterDensity,
    },
    ...(plan.network
      ? {
        network: cloneAndFreeze({
          planHash: plan.planHash,
          features: plan.features,
          ...plan.network,
        }),
      }
      : {}),
  };
  return projected;
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
    ...(inputs.network
      ? {
        POCKETJS_PLAN_HASH: inputs.network.planHash,
        POCKETJS_NETWORK_BUILD_INPUTS: canonicalJson(inputs.network),
      }
      : {}),
  };
}
