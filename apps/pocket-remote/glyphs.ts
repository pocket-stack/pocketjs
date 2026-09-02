// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/glyphs.ts — the remote's own icons, as Nerd Font
// symbols (Material Design Icons through the nf-md range). Omarchy's bar and
// menu draw from the same set, so the remote wears the desktop's iconography
// as well as its palette. The characters are written literally: the build's
// pass-1 scan collects codepoints from string literals, and the atlas baker
// takes glyphs Inter lacks from the fallback face fonts.json names.
//
// Hex is nf-md-<name>'s codepoint from nerd-fonts glyphnames.json.

export const GLYPH = {
  /** U+F05A9 */
  wifi: "󰖩",
  /** U+F05AA */
  wifiOff: "󰖪",
  /** U+F057E */
  volume: "󰕾",
  /** U+F0580 */
  volumeMid: "󰖀",
  /** U+F0581 */
  volumeOff: "󰖁",
  /** U+F00DF */
  brightness: "󰃟",
  /** U+F075A */
  music: "󰝚",
  /** U+F040A */
  play: "󰐊",
  /** U+F03E4 */
  pause: "󰏤",
  /** U+F04AD */
  next: "󰒭",
  /** U+F04AE */
  prev: "󰒮",
  /** U+F0100 */
  camera: "󰄀",
  /** U+F030C */
  keyboard: "󰌌",
  /** U+F056E */
  stage: "󰕮",
  /** U+F0322 */
  deck: "󰌢",
  /** U+F062E */
  tune: "󰘮",
  /** U+F0156 */
  close: "󰅖",
  /** U+F012C */
  check: "󰄬",
  /** U+F0142 */
  chevronRight: "󰅂",
  /** U+F0141 */
  chevronLeft: "󰅁",
  /** U+F004D */
  back: "󰁍",
  /** U+F0293 */
  fullscreen: "󰊓",
  /** U+F0294 */
  fullscreenExit: "󰊔",
  /** U+F05B2 */
  float: "󰖲",
  /** U+F0570 */
  tile: "󰕰",
  /** U+F0594 */
  night: "󰖔",
  /** U+F03CC */
  launch: "󰏌",
  /** U+F018D */
  terminal: "󰆍",
  /** U+F059F */
  browser: "󰖟",
  /** U+F024B */
  files: "󰉋",
  /** U+F06A9 */
  robot: "󰚩",
  /** U+F06B0 */
  update: "󰚰",
  /** U+F0765 */
  dot: "󰝥",
  /** U+F07F8 */
  trackpad: "󰟸",
  /** U+F035C */
  menu: "󰍜",
  /** U+F003B */
  apps: "󰀻",
  /** U+F01C0 */
  cursor: "󰇀",
} as const;

export type GlyphName = keyof typeof GLYPH;
