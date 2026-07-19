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
  /**
   * Present when the logical viewport is runtime-mutable (desktop windows):
   * any logical size within [min, max] is admissible, and the host resizes
   * the core live (`display.viewport.live`). `logicalViewports` then lists
   * the DEFAULT size a plan bakes assets for.
   */
  readonly dynamicViewport?: { readonly min: Viewport; readonly max: Viewport };
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
  // Framework-synthesized pointer for targets without a native one: the
  // analog nub steers a screen cursor, hover applies `focus:`, the press
  // button applies `active:` and clicks on release. Opt-in per app
  // (enableCursor + pocket.json requires/enhances) — d-pad focus traversal
  // remains the portable default interaction.
  "input.cursor",
  // OS text composition: preedit renders inline at the caret with its own
  // cursor, commits arrive as ordinary text insertions, and the host docks
  // the candidate window at the caret rect the app reports. Distinct from
  // input.text — a host can have a keyboard without an IME.
  "input.ime",
  // A REAL absolute pointer (mouse/trackpad): position plus press/drag/
  // release edges, hover resolves focus. A different guarantee than
  // input.cursor's synthesized nub-pointer, hence a different id (see the
  // header rule).
  "input.pointer",
  // A hardware text stream: layout-applied characters plus named editing
  // keys (Backspace/Enter/arrows/Home/End/…), key repeat included. The OSK
  // is the fallback spelling on targets without it.
  "input.text",
  "input.touch",
  // Copy/cut/paste round-trips with the OS clipboard.
  "host.clipboard",
  // The logical viewport is runtime-mutable: the app is told about live
  // window resizes and relayouts (framework resizeViewport). Console
  // targets never provide this — their viewport is a platform constant.
  "display.viewport.live",
  "text.glyphs.baked",
  // Codepoints outside the baked charset still render: the host extends
  // the font atlases at runtime (system-font rasterization + loadFontAtlas
  // reload). Required by any app that accepts arbitrary text input.
  "text.glyphs.runtime",
] as const);

export type PocketCapabilityId = CapabilityId<typeof POCKET_CAPABILITIES>;

/**
 * Production profiles advertise only capabilities delivered by stock hosts.
 *
 * Console targets are named by device (`psp`, `vita`). Host-windowed targets
 * follow `<class>-<form>-<os>`: class names the device family (`desktop`),
 * form the shell posture (`widget` — small always-on-top surface; future
 * `app`, `kiosk`), os the platform (`macos`; future `linux`, `windows`).
 * Form and os both change the truthful profile (viewport ranges, densities,
 * IME/clipboard semantics), so both belong in the id.
 */
export const POCKET_TARGETS = defineTargetRegistry<PocketCapabilityId, {
  readonly psp: TargetProfile<PocketCapabilityId>;
  readonly vita: TargetProfile<PocketCapabilityId>;
  readonly "desktop-widget-macos": TargetProfile<PocketCapabilityId>;
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
      "input.cursor",
      "text.glyphs.baked",
    ],
  },
  vita: {
    hostAbi: 2,
    display: {
      physicalViewport: [960, 544],
      logicalViewports: [[480, 272]],
      presentations: ["integer-fit"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.analog.left",
      "input.buttons",
      "input.cursor",
      "input.touch",
      "text.glyphs.baked",
    ],
  },
  // The flat pocket-widget shell (examples/note-widget is the stock host):
  // a resizable always-on-top window whose logical viewport IS the window,
  // rendered at density 2 for Retina. No nub, no synthesized cursor — the
  // pointer is real, text comes from the keyboard/IME, and unseen glyphs
  // bake at runtime.
  "desktop-widget-macos": {
    hostAbi: 3,
    display: {
      physicalViewport: [840, 1120],
      logicalViewports: [[420, 560]],
      dynamicViewport: { min: [240, 180], max: [4096, 4096] },
      presentations: ["native"],
      rasterDensity: 2,
    },
    capabilities: [
      "input.buttons",
      "input.ime",
      "input.pointer",
      "input.text",
      "host.clipboard",
      "display.viewport.live",
      "text.glyphs.baked",
      "text.glyphs.runtime",
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
