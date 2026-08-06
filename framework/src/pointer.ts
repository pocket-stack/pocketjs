// Target-neutral pointer snapshot delivered at the start of each host frame
// (input.pointer). Coordinates are logical PocketJS pixels, so applications
// never compensate for a window's raster density or scale factor.
//
// This is the REAL absolute pointer of a mouse/trackpad host, distinct from
// input.cursor's nub-synthesized cursor: it reports hover (motion with no
// button held), which a finger on a panel cannot produce and a nub-steered
// cursor only approximates. Hosts without one simply never pass the argument,
// and every existing host, tape and golden is unchanged.

export interface PointerSnapshot {
  /** Logical viewport X coordinate. */
  readonly x: number;
  /** Logical viewport Y coordinate. */
  readonly y: number;
  /** Whether the primary button is held this frame. */
  readonly down: boolean;
}

const COORD_BITS = 10;
const COORD_MASK = (1 << COORD_BITS) - 1;
const DOWN_BIT = 1 << (COORD_BITS * 2);

let snapshot: PointerSnapshot | null = null;

/**
 * Internal host-frame hook.
 *
 * Packed as `(down << 20) | (y << 10) | x`, 10 bits per axis (logical
 * coordinates up to 1023). `undefined` means the host has no pointer this
 * frame — the cursor holds its last position rather than jumping to an
 * origin, which is what a pointer leaving the window should look like.
 */
export function __setPointer(packed: number | undefined): void {
  if (packed === undefined) {
    snapshot = null;
    return;
  }
  snapshot = Object.freeze({
    x: packed & COORD_MASK,
    y: (packed >>> COORD_BITS) & COORD_MASK,
    down: (packed & DOWN_BIT) !== 0,
  });
}

/** The host pointer for the current frame, or null when the host has none. */
export function pointer(): PointerSnapshot | null {
  return snapshot;
}

export function __resetPointer(): void {
  snapshot = null;
}

/** Test/native helper matching the native frame wire format. */
export function __packPointer(x: number, y: number, down: boolean): number {
  return (
    ((down ? 1 : 0) << (COORD_BITS * 2)) |
    ((y & COORD_MASK) << COORD_BITS) |
    (x & COORD_MASK)
  ) >>> 0;
}
