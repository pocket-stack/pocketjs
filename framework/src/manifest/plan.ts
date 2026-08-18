import { createHash } from "node:crypto";
import type {
  NetworkConnectProtocol,
  NetworkListenProtocol,
  NetworkResourceMinimum,
  PocketManifest,
} from "../../../contracts/spec/pocket-manifest.ts";
import type { PresentationMode, Viewport } from "../../../contracts/spec/platforms.ts";

export type NetworkBackendRole =
  | "http.client"
  | "http.server"
  | "websocket.client"
  | "websocket.server"
  | "mqtt.client";

export type NetworkTlsRole = NetworkBackendRole | "tcp.client" | "tcp.server";

export interface ResolvedNetworkProviders {
  readonly backendByRole: Readonly<Partial<Record<NetworkBackendRole, string>>>;
  readonly tlsByRole: Readonly<Partial<Record<NetworkTlsRole, Readonly<{
    source: "provider" | "backend";
    id: string;
  }>>>>;
  readonly netDriverId: string;
}

export type ResolvedNetworkPort =
  | Readonly<{ min: number; max: number }>
  | Readonly<{ ephemeral: true }>;

export interface ResolvedNetworkConnectPermission {
  readonly protocol: NetworkConnectProtocol;
  readonly host: string;
  readonly port: Exclude<ResolvedNetworkPort, Readonly<{ ephemeral: true }>>;
}

export interface ResolvedNetworkListenPermission {
  readonly protocol: NetworkListenProtocol;
  readonly address: string;
  readonly port: ResolvedNetworkPort;
}

export interface ResolvedNetworkPolicy {
  readonly version: 1;
  readonly connect: readonly ResolvedNetworkConnectPermission[];
  readonly listen: readonly ResolvedNetworkListenPermission[];
  readonly localNetwork: boolean;
  readonly insecureTransport: boolean;
  readonly broadcast: boolean;
  readonly multicast: boolean;
  readonly allowInvalidTlsForDevelopment: boolean;
  readonly browserAmbientCredentials: boolean;
  readonly browserOpaqueWebSocketRedirects: boolean;
  readonly credentials: readonly string[];
}

export interface ResolvedNetworkResourcePlan {
  readonly minimum: NetworkResourceMinimum;
}

export interface ResolvedNetworkBuildPlan {
  readonly policy: ResolvedNetworkPolicy;
  readonly providers: ResolvedNetworkProviders;
  readonly resources: ResolvedNetworkResourcePlan;
}

export interface ResolvedBuildPlanContent {
  readonly app: Pick<PocketManifest, "id" | "title"> &
    Pick<PocketManifest["app"], "entry" | "framework"> & {
    readonly output: string;
  };
  readonly target: {
    readonly id: string;
    readonly hostAbi: number;
  };
  readonly viewport: {
    readonly logical: Viewport;
    readonly physical: Viewport;
    readonly presentation: PresentationMode;
    /** Target-owned raster samples per logical pixel; layout stays logical. */
    readonly rasterDensity: number;
  };
  /** Required APIs are true; enhancements reflect target availability. */
  readonly features: Readonly<Record<string, boolean>>;
  /** One selected provider option per format-3 requiresOneOf group. */
  readonly selectedCapabilityOptions?: readonly (readonly string[])[];
  /** Present only when the build has admitted network authority. */
  readonly network?: ResolvedNetworkBuildPlan;
}

export interface ResolvedBuildPlan extends ResolvedBuildPlanContent {
  /** Self-checksum for the serialized plan; not a runtime compatibility hash. */
  readonly planHash: string;
}

/** RFC-8785-shaped canonical JSON for this JSON-only build input. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("build plan contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      const child = record[key];
      if (child === undefined) throw new TypeError(`build plan contains undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`build plan contains non-JSON value ${typeof value}`);
}

export function hashBuildPlanContent(content: ResolvedBuildPlanContent): string {
  return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`;
}

export function finalizeBuildPlan(content: ResolvedBuildPlanContent): ResolvedBuildPlan {
  return { ...content, planHash: hashBuildPlanContent(content) };
}

export function verifyPlanHash(plan: ResolvedBuildPlan): boolean {
  const { planHash, ...content } = plan;
  return planHash === hashBuildPlanContent(content);
}
