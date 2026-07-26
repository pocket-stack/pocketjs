// Target-neutral touch snapshot delivered at the start of each host frame.
// Coordinates are logical PocketJS pixels, so applications never compensate
// for a Vita panel's sampling grid or the target raster density.

export interface TouchContact {
  /** Stable while this contact remains down; ids may be reused after release. */
  readonly id: number;
  /** Logical viewport X coordinate. */
  readonly x: number;
  /** Logical viewport Y coordinate. */
  readonly y: number;
}

const LEGACY_COORD_BITS = 9;
const LEGACY_COORD_MASK = (1 << LEGACY_COORD_BITS) - 1;
const LEGACY_ID_SHIFT = LEGACY_COORD_BITS * 2;
const WIDE_MARKER = 0x80000000;
const WIDE_COORD_BITS = 10;
const WIDE_COORD_MASK = (1 << WIDE_COORD_BITS) - 1;
const WIDE_ID_SHIFT = WIDE_COORD_BITS * 2;
const EMPTY: readonly TouchContact[] = Object.freeze([]);

let snapshot: readonly TouchContact[] = EMPTY;

/**
 * Internal host-frame hook.
 *
 * Existing hosts pack x:9, y:9, id:8 with bit 31 clear. Native viewports
 * wider than 512 use the append-only wide form: bit31=1, x:10, y:10, id:8.
 * Per-contact detection keeps every PSP/Vita tape and host byte-compatible.
 */
export function __setTouches(packed: readonly number[] | undefined): void {
  if (!packed || packed.length === 0) {
    snapshot = EMPTY;
    return;
  }
  snapshot = Object.freeze(
    packed.slice(0, 8).map((value) => {
      const wide = (value & WIDE_MARKER) !== 0;
      const coordBits = wide ? WIDE_COORD_BITS : LEGACY_COORD_BITS;
      const coordMask = wide ? WIDE_COORD_MASK : LEGACY_COORD_MASK;
      const idShift = wide ? WIDE_ID_SHIFT : LEGACY_ID_SHIFT;
      return Object.freeze({
        id: (value >>> idShift) & 0xff,
        x: value & coordMask,
        y: (value >>> coordBits) & coordMask,
      });
    }),
  );
}

/** Front-panel contacts for the current frame, in logical viewport pixels. */
export function touches(): readonly TouchContact[] {
  return snapshot;
}

export function __resetTouches(): void {
  snapshot = EMPTY;
}

/** Test/capture helper matching the native frame wire format. */
export function __packTouch(id: number, x: number, y: number): number {
  return (
    ((id & 0xff) << LEGACY_ID_SHIFT) |
    ((y & LEGACY_COORD_MASK) << LEGACY_COORD_BITS) |
    (x & LEGACY_COORD_MASK)
  ) >>> 0;
}

/** Test/native helper for logical viewports up to 1024 pixels per axis. */
export function __packTouchWide(id: number, x: number, y: number): number {
  return (
    WIDE_MARKER |
    ((id & 0xff) << WIDE_ID_SHIFT) |
    ((y & WIDE_COORD_MASK) << WIDE_COORD_BITS) |
    (x & WIDE_COORD_MASK)
  ) >>> 0;
}
