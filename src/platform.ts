import type { PocketCapabilityId } from "../spec/platforms.ts";

// Replaced by scripts/build.ts for manifest-driven bundles. `typeof` keeps
// legacy and test builds valid until they opt into pocket.json.
declare const __POCKET_TARGET__: string;
declare const __POCKET_FEATURES__: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;

export interface PocketPlatform {
  readonly target: string;
  /** Availability of APIs declared under engine.capabilities in pocket.json. */
  readonly features: Readonly<Partial<Record<PocketCapabilityId, boolean>>>;
}

const features = typeof __POCKET_FEATURES__ === "object" && __POCKET_FEATURES__ !== null
  ? Object.freeze({ ...__POCKET_FEATURES__ })
  : Object.freeze({});

/** Build-time host API availability. Permissions and live device state are separate APIs. */
export const platform: PocketPlatform = Object.freeze({
  target: typeof __POCKET_TARGET__ === "string" ? __POCKET_TARGET__ : "unknown",
  features,
});

// Literal calls are folded by the PocketJS compiler. Keeping this runtime
// lookup supports computed feature ids and non-manifest builds.
export function hasFeature(feature: PocketCapabilityId): boolean {
  return platform.features[feature] === true;
}
