import { createHash } from "node:crypto";
import type {
  CapabilityRequirement,
  PackageMetadata,
  PocketManifestV2,
} from "../../spec/pocket-manifest.ts";
import type { PresentationMode, ProvidedCapability, Viewport } from "../../spec/platforms.ts";

export interface RationalScale {
  readonly numerator: number;
  readonly denominator: number;
}

export interface ResolvedCapability {
  readonly requirement: CapabilityRequirement;
  readonly provided: ProvidedCapability;
}

export interface ResolvedEnhancement {
  readonly requirement: CapabilityRequirement;
  readonly status: "available" | "unavailable";
  readonly provided: ProvidedCapability | null;
}

export interface ResolvedBuildPlanContent {
  readonly pocket: 2;
  readonly app: Pick<PocketManifestV2, "id" | "name" | "title" | "version"> &
    Omit<PocketManifestV2["app"], "output"> & { readonly output: string };
  readonly target: {
    readonly id: string;
    readonly profileVersion: number;
    readonly hostAbi: number;
  };
  readonly package: {
    readonly format: string;
    readonly metadata: PackageMetadata;
  };
  readonly viewport: {
    readonly logical: Viewport;
    readonly physical: Viewport;
    readonly presentation: PresentationMode;
    readonly scale: {
      readonly x: RationalScale;
      readonly y: RationalScale;
    };
  };
  readonly capabilities: {
    readonly requires: readonly ResolvedCapability[];
    readonly enhances: readonly ResolvedEnhancement[];
  };
}

export interface ResolvedBuildPlan extends ResolvedBuildPlanContent {
  readonly contractHash: string;
}

/** RFC-8785-shaped canonical JSON for the JSON-only build contract. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("build contract contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      const child = record[key];
      if (child === undefined) throw new TypeError(`build contract contains undefined at ${key}`);
      return `${JSON.stringify(key)}:${canonicalJson(child)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`build contract contains non-JSON value ${typeof value}`);
}

export function hashBuildPlanContent(content: ResolvedBuildPlanContent): string {
  return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`;
}

export function finalizeBuildPlan(content: ResolvedBuildPlanContent): ResolvedBuildPlan {
  return { ...content, contractHash: hashBuildPlanContent(content) };
}

export function verifyBuildPlanHash(plan: ResolvedBuildPlan): boolean {
  const { contractHash, ...content } = plan;
  return contractHash === hashBuildPlanContent(content);
}
