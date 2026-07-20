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

const COORD_BITS = 9;
const COORD_MASK = (1 << COORD_BITS) - 1;
const ID_SHIFT = COORD_BITS * 2;
const EMPTY: readonly TouchContact[] = Object.freeze([]);

let snapshot: readonly TouchContact[] = EMPTY;

/** Internal host-frame hook. Each u32 packs x:9, y:9, id:8. */
export function __setTouches(packed: readonly number[] | undefined): void {
  if (!packed || packed.length === 0) {
    snapshot = EMPTY;
    return;
  }
  snapshot = Object.freeze(
    packed.slice(0, 8).map((value) => Object.freeze({
      id: (value >>> ID_SHIFT) & 0xff,
      x: value & COORD_MASK,
      y: (value >>> COORD_BITS) & COORD_MASK,
    })),
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
    ((id & 0xff) << ID_SHIFT) |
    ((y & COORD_MASK) << COORD_BITS) |
    (x & COORD_MASK)
  ) >>> 0;
}
