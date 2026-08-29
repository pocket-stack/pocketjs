// Row colors. Pending rows sweep hot red at the top of the stack toward
// amber at the bottom (position-keyed, so completing or reordering re-tints
// every row); the done pile is a flat dark slab. Colors are '#rrggbb'
// strings because they ride the animatable gradFrom/gradTo props.

const PENDING_TOP: readonly [number, number, number] = [0xd3, 0x2b, 0x3a];
const PENDING_BOTTOM: readonly [number, number, number] = [0xe6, 0x99, 0x2e];
/** Positions beyond this depth all take the bottom color. */
const SWEEP_ROWS = 9;

export const DONE_FROM = "#20242c";
export const DONE_TO = "#1a1e25";
export const DONE_TEXT = "#5b6472";
export const PENDING_TEXT = "#ffffff";

function hex2(value: number): string {
  return (value < 16 ? "0" : "") + value.toString(16);
}

function sweep(t: number): string {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(PENDING_TOP[0] + (PENDING_BOTTOM[0] - PENDING_TOP[0]) * clamped);
  const g = Math.round(PENDING_TOP[1] + (PENDING_BOTTOM[1] - PENDING_TOP[1]) * clamped);
  const b = Math.round(PENDING_TOP[2] + (PENDING_BOTTOM[2] - PENDING_TOP[2]) * clamped);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Gradient endpoints for the pending row at `index`. Each row spans a
 *  slice of the sweep so adjacent rows meet without a visible step. */
export function pendingRowColors(index: number): readonly [string, string] {
  return [sweep(index / SWEEP_ROWS), sweep((index + 0.9) / SWEEP_ROWS)];
}

/** The pull-to-create flap tracks the top-of-stack color. */
export const FLAP_FROM = sweep(-0.9 / SWEEP_ROWS);
export const FLAP_TO = sweep(0);
