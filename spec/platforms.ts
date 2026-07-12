// PocketJS platform capability registry.
//
// Capability ids name stable, public framework behavior that applications can
// observe. Do not name hardware, permissions, runtime availability, backend
// implementations, or wire formats. Register an id only after a stock host
// implements and tests the whole contract. Hosts with the same observable
// semantics share an id; a different execution level or guarantee gets a new
// id.

export type CapabilityRegistry = readonly string[];

export function defineCapabilityRegistry<const T extends CapabilityRegistry>(registry: T): T {
  return registry;
}

export type CapabilityId<T extends CapabilityRegistry> = T[number];

export const PRESENTATION_MODES = ["fill", "fit", "integer-fit", "native", "stretch"] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];
export type Viewport = readonly [width: number, height: number];

export interface DisplayProfile {
  readonly physicalViewport: Viewport;
  readonly logicalViewports: readonly Viewport[];
  readonly presentations: readonly PresentationMode[];
  /**
   * Target raster samples per logical pixel for baked text, vectors, masks,
   * and target-selected image variants. This is a rendering contract, not an
   * API capability or a promise that presentation scale has the same value.
   */
  readonly rasterDensity: number;
}

export interface TargetProfile<C extends string = string> {
  /** JS/native HostOps wire generation embedded by the selected backend. */
  readonly hostAbi: number;
  readonly display: DisplayProfile;
  /** Framework APIs implemented and tested by this stock host. */
  readonly capabilities: readonly C[];
}

export type TargetRegistry<C extends string = string> = Readonly<Record<string, TargetProfile<C>>>;

export function defineTargetRegistry<
  C extends string,
  const T extends TargetRegistry<C>,
>(registry: T): T {
  return registry;
}

export type TargetId<T extends TargetRegistry> = Extract<keyof T, string>;

export const POCKET_CAPABILITIES = defineCapabilityRegistry([
  "input.analog.left",
  "input.buttons",
  "text.glyphs.baked",
] as const);

export type PocketCapabilityId = CapabilityId<typeof POCKET_CAPABILITIES>;

/** Production profiles advertise only capabilities delivered by stock hosts. */
export const POCKET_TARGETS = defineTargetRegistry<PocketCapabilityId, {
  readonly psp: TargetProfile<PocketCapabilityId>;
  readonly vita: TargetProfile<PocketCapabilityId>;
}>({
  psp: {
    hostAbi: 1,
    display: {
      physicalViewport: [480, 272],
      logicalViewports: [[480, 272]],
      // integer-fit at scale 1 is the portable spelling of the native PSP
      // surface and can be satisfied unchanged by higher-resolution hosts.
      presentations: ["native", "integer-fit"],
      rasterDensity: 1,
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "text.glyphs.baked",
    ],
  },
  vita: {
    hostAbi: 1,
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "text.glyphs.baked",
    ],
  },
});

export type PocketTargetId = TargetId<typeof POCKET_TARGETS>;

export interface PlatformContractRegistry<
  C extends CapabilityRegistry = CapabilityRegistry,
  T extends TargetRegistry<CapabilityId<C>> = TargetRegistry<CapabilityId<C>>,
> {
  readonly capabilities: C;
  readonly targets: T;
}

export function definePlatformContractRegistry<
  const C extends CapabilityRegistry,
  const T extends TargetRegistry<CapabilityId<C>>,
>(capabilities: C, targets: T): PlatformContractRegistry<C, T> {
  return { capabilities, targets };
}

export const POCKET_PLATFORM_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  POCKET_TARGETS,
);
