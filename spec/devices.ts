// spec/devices.ts — DEVICE PROFILES: one Tailwind app source, many device sizes.
//
// A `device profile` is the single knob that adapts an app to a physical target.
// The build picks ONE profile (scripts/build.ts --device=<name>, default "psp")
// and it drives three things:
//   1. the core's logical screen size (SCREEN_W/H — see core/build.rs, fed via
//      POCKETJS_SCREEN_W/H by the per-target build scripts),
//   2. static Tailwind variant resolution (breakpoints + capability flags —
//      compiler/tailwind.ts folds the matching ones into the style record and
//      drops the rest AT BUILD TIME, so there is zero runtime cost, unlike the
//      web where `md:` is a live media query),
//   3. (reserved) font-atlas density via `fontScale` — always 1.0 in v1.
//
// Flexbox already does the fluid reflow (flex-1/grow/justify-between/gap/w-full),
// so a cleanly-authored app mostly "just works" at a new width; the variants
// below cover the cases pure reflow can't (see DESIGN.md "Device profiles").

export interface DeviceProfile {
  /** Profile id — also usable as a device variant prefix (e.g. `psp:`, `3ds:`). */
  name: string;
  /** Logical screen width in px (the core's SCREEN_W for this build). */
  width: number;
  /** Logical screen height in px (the core's SCREEN_H for this build). */
  height: number;
  /**
   * Capability tags — each is usable as a device variant prefix (e.g.
   * `touch:hidden`). A `<cap>:` token applies iff the active profile lists it.
   */
  caps: readonly string[];
  /**
   * Font-size density multiplier. Reserved future knob (bake-font would scale
   * every atlas slot by this); pinned to 1.0 in v1 since our targets are close
   * in size and we prefer absolute-px utilities + flex reflow.
   */
  fontScale: number;
}

/**
 * The device registry. Add a profile per physical target; the APP SOURCE never
 * changes — only which profile the build selects.
 *   - psp:  Sony PSP, the original target (480×272).
 *   - 3ds:  Nintendo 3DS TOP screen (400×240). v1 uses the top screen only; the
 *           bottom screen (320×240, touch) is a follow-up behind the `touch`/
 *           `dualscreen` caps.
 *   - web:  browser/wasm dev host + Bun goldens (matches PSP so goldens align).
 */
export const DEVICE_PROFILES: Record<string, DeviceProfile> = {
  psp: { name: "psp", width: 480, height: 272, caps: ["dpad", "analog"], fontScale: 1 },
  "3ds": {
    name: "3ds",
    width: 400,
    height: 240,
    caps: ["dpad", "circlepad", "touch", "dualscreen"],
    fontScale: 1,
  },
  web: { name: "web", width: 480, height: 272, caps: ["dpad", "keyboard"], fontScale: 1 },
};

/** Default when no --device is passed: preserves today's PSP behaviour exactly. */
export const DEFAULT_DEVICE = "psp";

/**
 * Width breakpoints, tuned for HANDHELD/console screens — NOT Tailwind's web
 * defaults (640/768/1024, all far above our 320–480 px screens, so they'd never
 * fire). `md:` deliberately sits between the 3DS (400) and PSP (480) so the two
 * can diverge; `sm:` is below both so both get it. A `bp:` token applies iff
 * `profile.width >= threshold`.
 */
export const BREAKPOINTS: Record<string, number> = {
  sm: 360,
  md: 440,
  lg: 520,
  xl: 600,
};

/** Every string usable as a *device* variant prefix (profile names ∪ all caps). */
export const DEVICE_FLAGS: ReadonlySet<string> = new Set(
  Object.values(DEVICE_PROFILES).flatMap((p) => [p.name, ...p.caps]),
);

export function resolveProfile(name: string = DEFAULT_DEVICE): DeviceProfile {
  const p = DEVICE_PROFILES[name];
  if (!p) {
    throw new Error(
      `PocketJS: unknown device profile "${name}" (known: ${Object.keys(DEVICE_PROFILES).join(", ")})`,
    );
  }
  return p;
}

/** How a colon-prefix classifies against a profile (see compiler/tailwind.ts). */
export type BuildVariant =
  | { kind: "breakpoint"; matches: boolean }
  | { kind: "device"; matches: boolean }
  | null; // not a build-time variant prefix

/**
 * Classify a compile-time variant prefix.
 *   - a breakpoint (`sm`/`md`/…): matches iff the profile is at least that wide;
 *   - a device flag (a known profile name or capability): matches iff the active
 *     profile IS that device or lists that capability. Crucially a KNOWN flag
 *     that does not match (e.g. `psp:` on a 3ds build) is still classified — it
 *     is valid-but-inert, never an "unknown token" that would disqualify the
 *     whole literal from being a class string;
 *   - `null`: not a build-time variant (caller decides: state variant, or the
 *     literal is not a class string at all).
 */
export function classifyBuildVariant(prefix: string, profile: DeviceProfile): BuildVariant {
  if (prefix in BREAKPOINTS) {
    return { kind: "breakpoint", matches: profile.width >= BREAKPOINTS[prefix] };
  }
  if (DEVICE_FLAGS.has(prefix)) {
    return { kind: "device", matches: prefix === profile.name || profile.caps.includes(prefix) };
  }
  return null;
}
