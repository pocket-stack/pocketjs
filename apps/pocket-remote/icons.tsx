// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/icons.tsx — an icon is a glyph. The remote's symbols
// come from the Nerd Font face fonts.json adds to the atlas (glyphs.ts names
// them), so they are text: they recolour with the theme like every label,
// and Omarchy's menu rows carry the very glyphs the shell shows.
//
// A class string reaches the device as one literal looked up in the baked
// table, so every size x tone pair is spelled out here rather than composed.

import { Text } from "@pocketjs/framework/components";
import { type Role, themed } from "./theme.ts";

export type Tone = "fg" | "dim" | "accent" | "onAccent" | "danger" | "ok" | "warn";
export type Size = "sm" | "base" | "lg" | "xl" | "2xl";

const CLASS: Record<Size, Record<Tone, string>> = {
  sm: {
    fg: "text-sm text-[#a9b1d6]",
    dim: "text-sm text-[#565f89]",
    accent: "text-sm text-[#7aa2f7]",
    onAccent: "text-sm text-[#13141c]",
    danger: "text-sm text-[#f7768e]",
    ok: "text-sm text-[#9ece6a]",
    warn: "text-sm text-[#e0af68]",
  },
  base: {
    fg: "text-base text-[#a9b1d6]",
    dim: "text-base text-[#565f89]",
    accent: "text-base text-[#7aa2f7]",
    onAccent: "text-base text-[#13141c]",
    danger: "text-base text-[#f7768e]",
    ok: "text-base text-[#9ece6a]",
    warn: "text-base text-[#e0af68]",
  },
  lg: {
    fg: "text-lg text-[#a9b1d6]",
    dim: "text-lg text-[#565f89]",
    accent: "text-lg text-[#7aa2f7]",
    onAccent: "text-lg text-[#13141c]",
    danger: "text-lg text-[#f7768e]",
    ok: "text-lg text-[#9ece6a]",
    warn: "text-lg text-[#e0af68]",
  },
  xl: {
    fg: "text-xl text-[#a9b1d6]",
    dim: "text-xl text-[#565f89]",
    accent: "text-xl text-[#7aa2f7]",
    onAccent: "text-xl text-[#13141c]",
    danger: "text-xl text-[#f7768e]",
    ok: "text-xl text-[#9ece6a]",
    warn: "text-xl text-[#e0af68]",
  },
  "2xl": {
    fg: "text-2xl text-[#a9b1d6]",
    dim: "text-2xl text-[#565f89]",
    accent: "text-2xl text-[#7aa2f7]",
    onAccent: "text-2xl text-[#13141c]",
    danger: "text-2xl text-[#f7768e]",
    ok: "text-2xl text-[#9ece6a]",
    warn: "text-2xl text-[#e0af68]",
  },
};

const ROLE: Record<Tone, Role> = {
  fg: "text",
  dim: "textDim",
  accent: "textAccent",
  onAccent: "textOnAccent",
  danger: "textDanger",
  ok: "textOk",
  warn: "textWarn",
};

/** One glyph, coloured by tone, sized by the text scale. The parent centres
 *  it (a View with items-center justify-center). Tone and size may be
 *  functions for a glyph that changes with state. */
export function Icon(p: { glyph: string | (() => string); tone?: Tone | (() => Tone); size?: Size }) {
  const tone = () => (typeof p.tone === "function" ? p.tone() : (p.tone ?? "fg"));
  const glyph = () => (typeof p.glyph === "function" ? p.glyph() : p.glyph);
  const size = p.size ?? "base";
  return (
    <Text class={CLASS[size][tone()]} ref={themed(() => ROLE[tone()])}>
      {glyph()}
    </Text>
  );
}
