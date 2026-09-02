// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/theme.ts — the remote wears the desktop's theme. Omarchy
// publishes its palette as colors.toml; the daemon forwards the keys the
// remote uses (protocol ThemeColors) whenever the theme changes, and every
// node that carries a themed colour re-paints through jump() on its
// NodeMirror. Class literals still carry Tokyo Night, Omarchy's default, so
// the first frame looks right before any theme line arrives.
//
// Why mirrors and not classes: a class string is a compile-time literal the
// device looks up in a baked table, so a colour that arrives at runtime can
// only reach a node as a prop write. Pressed states therefore live on
// separate overlay nodes (see desk.tsx) — a class flip on a themed node would
// re-apply the baked record over the runtime colour.

import { createEffect, createSignal, type Accessor } from "solid-js";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import type { ThemeColors } from "./protocol.ts";

export const TOKYO_NIGHT: ThemeColors = {
  bg: "#1a1b26",
  bgDark: "#13141c",
  fg: "#a9b1d6",
  fgDim: "#565f89",
  accent: "#7aa2f7",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#449dab",
  muted: "#414868",
};

/** What a themed node paints with which colour. */
export type Role =
  | "surface" //       bgColor = bg
  | "surfaceDark" //   bgColor = bgDark
  | "surfaceMuted" //  bgColor = muted
  | "surfaceMutedDim" // bgColor = muted at 50%
  | "surfaceRaised" //  bgColor = muted at 25% (a popup's body over the surface)
  | "surfaceVeil" //    bgColor = bgDark at 70% (behind a sheet)
  | "accentFill" //    bgColor = accent
  | "accentTint" //    bgColor = accent at 25%
  | "dangerFill" //    bgColor = red
  | "okFill" //        bgColor = green
  | "text" //          textColor = fg
  | "textDim" //       textColor = fgDim
  | "textAccent" //    textColor = accent
  | "textOnAccent" //  textColor = bgDark
  | "textDanger" //    textColor = red
  | "textOk" //        textColor = green
  | "textWarn" //      textColor = yellow
  | "okFillDot" //     bgColor = green (a status dot)
  | "warnFill" //      bgColor = yellow
  | "fgFill" //        bgColor = fg (icon strokes)
  | "fgDimFill" //     bgColor = fgDim
  | "borderMuted" //   borderColor = muted
  | "borderFg" //      borderColor = fg
  | "borderAccent" //  borderColor = accent
  | "borderDanger"; // borderColor = red

type Prop = "bgColor" | "textColor" | "borderColor";

function paint(role: Role, c: ThemeColors): [Prop, string] {
  switch (role) {
    case "surface":
      return ["bgColor", c.bg];
    case "surfaceDark":
      return ["bgColor", c.bgDark];
    case "surfaceMuted":
      return ["bgColor", c.muted];
    case "surfaceMutedDim":
      return ["bgColor", c.muted + "80"];
    case "surfaceRaised":
      return ["bgColor", c.muted + "40"];
    case "surfaceVeil":
      return ["bgColor", c.bgDark + "b3"];
    case "accentFill":
      return ["bgColor", c.accent];
    case "accentTint":
      return ["bgColor", c.accent + "40"];
    case "dangerFill":
      return ["bgColor", c.red];
    case "okFill":
      return ["bgColor", c.green];
    case "text":
      return ["textColor", c.fg];
    case "textDim":
      return ["textColor", c.fgDim];
    case "textAccent":
      return ["textColor", c.accent];
    case "textOnAccent":
      return ["textColor", c.bgDark];
    case "textDanger":
      return ["textColor", c.red];
    case "textOk":
      return ["textColor", c.green];
    case "textWarn":
      return ["textColor", c.yellow];
    case "okFillDot":
      return ["bgColor", c.green];
    case "warnFill":
      return ["bgColor", c.yellow];
    case "fgFill":
      return ["bgColor", c.fg];
    case "fgDimFill":
      return ["bgColor", c.fgDim];
    case "borderMuted":
      return ["borderColor", c.muted];
    case "borderFg":
      return ["borderColor", c.fg];
    case "borderAccent":
      return ["borderColor", c.accent];
    case "borderDanger":
      return ["borderColor", c.red];
  }
}

const [themeColorsSignal, setThemeColorsSignal] = createSignal<ThemeColors>(TOKYO_NIGHT);

/** The live palette as a signal, for anything that derives from it. */
export const themeColors: Accessor<ThemeColors> = themeColorsSignal;

/** Paint one role onto one node with the given palette. */
export function paintRole(node: NodeMirror, role: Role, colors: ThemeColors): void {
  const [prop, value] = paint(role, colors);
  jump(node, prop, value);
}

/**
 * A `ref` for a node that paints one themed colour. Repaints whenever the
 * palette changes — and, because the effect runs after Solid's render pass,
 * after any class flip on the same node, so a runtime colour always wins
 * over the baked record. Pass a function for a role that changes with state
 * (an active tab, a pressed key).
 */
export function themed(role: Role | (() => Role)): (node: NodeMirror) => void {
  return (node) => {
    createEffect(() => {
      const colors = themeColors();
      const current = typeof role === "function" ? role() : role;
      // The baked classes already carry Tokyo Night; painting it again on a
      // static role would only cost a prop write per node at boot.
      if (colors !== TOKYO_NIGHT || typeof role === "function") paintRole(node, current, colors);
    });
  };
}

/** Repaint every themed node with a new palette. */
export function setTheme(colors: ThemeColors): void {
  setThemeColorsSignal(colors);
}

export function currentTheme(): ThemeColors {
  return themeColors();
}

/** Validate a palette off the wire: every key present and a #rrggbb colour. */
export function isThemeColors(value: unknown): value is ThemeColors {
  if (!value || typeof value !== "object") return false;
  const keys: (keyof ThemeColors)[] = [
    "bg", "bgDark", "fg", "fgDim", "accent", "red", "green", "yellow", "blue", "magenta", "cyan", "muted",
  ];
  const record = value as Record<string, unknown>;
  return keys.every((key) => typeof record[key] === "string" && /^#[0-9a-fA-F]{6}$/.test(record[key] as string));
}

/** Pretty theme name from its slug: "tokyo-night" -> "Tokyo Night". */
export function themeTitle(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}
