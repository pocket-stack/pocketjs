// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/design.ts — the remote's design tokens and the row
// arithmetic every list is built from. One place, because the paddings had
// drifted: each surface had picked its own icon inset, label offset and
// highlight bleed, and side by side they read as sloppy.
//
// A class string reaches the device as one baked literal, so a token cannot
// be interpolated into a class — radii and sizes therefore live here as
// NUMBERS for `style` objects, and the literals that must spell a radius out
// live in ui.tsx next to the primitive that owns them. Anything measured in
// pixels belongs in this file; anything drawn belongs there.

/** Spacing scale. Everything that separates two things uses one of these. */
export const SPACE = { xs: 2, sm: 4, md: 6, lg: 8, xl: 12, xxl: 16 } as const;

/**
 * Corner radii, by the thing they belong to. The literals in ui.tsx spell
 * these out; the numbers are here so geometry can reason about them (the
 * sheet's header squares off its own bottom corners, for instance).
 */
export const RADIUS = { card: 14, popup: 10, row: 8, control: 7, chip: 9, tab: 6, tile: 4 } as const;

/** Row heights, by the surface. A list row is 40; a menu popup's is 36. */
export const ROW_H = { list: 40, popup: 36, bar: 32, slider: 36 } as const;

/** The box every row's leading glyph is centred in. */
export const ICON_BOX = 24;
/** A row's leading and trailing inset. */
export const GUTTER = 10;
/** Gap between the icon box and the label. */
export const ICON_GAP = SPACE.lg;
/** The highlight behind a pressed or hovered row, inset from its edges. */
export const HIGHLIGHT_INSET = SPACE.sm;
/** A hairline between rows, inset from both ends. */
export const HAIRLINE_INSET = GUTTER;
/** The smallest a finger is asked to hit. */
export const TARGET_MIN = 28;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RowMetrics {
  h: number;
  /** Leading glyph box. */
  icon: Box;
  /** The label, vertically centred by `items-center` on this box. */
  label: Box;
  /** Trailing glyph box (a chevron, a tick), or null without one. */
  trailing: Box | null;
  /** The pressed/hot highlight. */
  highlight: Box;
  /** The hairline above the row (rows after the first draw it). */
  hairline: Box;
}

/**
 * One row's anatomy in a container `width` wide: leading icon, label, an
 * optional trailing glyph, the highlight and the hairline — all from the
 * same tokens, so two lists cannot disagree about their paddings.
 */
export function rowMetrics(width: number, h: number, trailing = false): RowMetrics {
  const iconY = Math.round((h - ICON_BOX) / 2);
  const labelX = GUTTER + ICON_BOX + ICON_GAP;
  const trailingX = width - GUTTER - ICON_BOX;
  return {
    h,
    icon: { x: GUTTER, y: iconY, w: ICON_BOX, h: ICON_BOX },
    label: { x: labelX, y: 0, w: (trailing ? trailingX - SPACE.md : width - GUTTER) - labelX, h },
    trailing: trailing ? { x: trailingX, y: iconY, w: ICON_BOX, h: ICON_BOX } : null,
    highlight: { x: HIGHLIGHT_INSET, y: HIGHLIGHT_INSET / 2, w: width - 2 * HIGHLIGHT_INSET, h: h - HIGHLIGHT_INSET },
    hairline: { x: HAIRLINE_INSET, y: 0, w: width - 2 * HAIRLINE_INSET, h: 1 },
  };
}
