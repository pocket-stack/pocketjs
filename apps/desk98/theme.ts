// apps/desk98/theme.ts — the Windows 98 classic look as PocketJS class
// literals, translated from sheru's win98 theme (packages/themes/src/win98)
// the way pocket-shell's cooked skin does it: one bevel system over
// button-face gray. Raised chrome is a two-ring outset bevel, pressing
// inverts it, content wells are sunken; nothing is rounded, nothing
// animates. bevel-[outerTL,outerBR,innerTL,innerBR] per the compiler
// grammar (engine bevel rings, spec PROP.bevelOuter*).

/** Baked W95FA slots (apps/desk98/gen-assets.ts → pak.json). */
export const FONT = 19; // 12.5px regular
export const FONT_B = 20; // 12.5px synthetic bold
export const FONT_XL = 21; // 25px regular (start-menu banner)

// The bevel recipes (they repeat as FULL literals in the components — the
// class table compiles at build time and template-interpolated fragments
// are a compile error):
//   raised control  bevel-[#ffffff,#000000,#dfdfdf,#808080]
//   pressed         bevel-[#000000,#ffffff,#808080,#dfdfdf]
//   window frame    bevel-[#dfdfdf,#000000,#ffffff,#808080]
//   sunken well     bevel-[#808080,#ffffff,#000000,#dfdfdf]
//   thin raised     bevel-[#ffffff,#808080]   thin sunken  bevel-[#808080,#ffffff]

export const CAPTION_ACTIVE =
  "flex-row items-center h-[18] pl-[3] pr-[2] bg-gradient-to-r from-[#000080] to-[#1084d0] mb-[1]";
export const CAPTION_INACTIVE =
  "flex-row items-center h-[18] pl-[3] pr-[2] bg-gradient-to-r from-[#808080] to-[#b5b5b5] mb-[1]";

// Chrome metrics (mirrored by wm.ts hit testing — change both together).
export const FRAME = 3;
export const TITLE_H = 18;
export const TITLE_GAP = 1; // face-gray hairline under the caption
export const BTN_W = 16;
export const BTN_H = 14; // all caption buttons sit flush, no close gap
export const MENU_H = 18; // menu bar row
export const TASK_H = 28; // taskbar
export const RESIZE_BAND = 4;
export const RESIZE_CORNER = 14;
