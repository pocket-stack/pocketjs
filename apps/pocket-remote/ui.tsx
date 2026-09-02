// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/ui.tsx — the drawn half of the design system: the card,
// the row, the hairline and the press tint every surface is assembled from.
// Geometry comes from design.ts; the class literals that have to spell a
// radius or a colour out live here, next to the primitive that owns them,
// because a baked class string cannot take a token as a value.
//
// Every list on the remote — a held tile's popup, the menu sheet, the
// control centre — uses Row, so their paddings are identical by
// construction rather than by hand.

import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { JSX } from "solid-js";
import { type Box, rowMetrics } from "./design.ts";
import { Icon, type Tone } from "./icons.tsx";
import { themed } from "./theme.ts";

/** A raised surface. `popup` is the small radius, `card` the large one. */
export function Card(p: { at: Box; variant?: "card" | "popup"; children?: JSX.Element; ref?: (node: import("@pocketjs/framework/components").NodeMirror) => void }) {
  const bind = (node: import("@pocketjs/framework/components").NodeMirror) => {
    themed("surfaceDark")(node);
    themed("borderMuted")(node);
    p.ref?.(node);
  };
  return (
    <View
      class={
        p.variant === "card"
          ? "absolute rounded-[14] bg-[#13141c] border border-[#414868] overflow-hidden"
          : "absolute rounded-[10] bg-[#13141c] border border-[#414868] overflow-hidden"
      }
      style={{ insetL: p.at.x, insetT: p.at.y, width: p.at.w, height: p.at.h }}
      ref={bind}
    >
      {p.children}
    </View>
  );
}

/** The tint a target wears while a finger is on it. */
export function PressTint(p: { at: Box; on: boolean; radius?: "row" | "popup" | "card" }) {
  return (
    <Show when={p.on}>
      <View
        class={
          p.radius === "card"
            ? "absolute rounded-[14] bg-[#ffffff22]"
            : p.radius === "popup"
              ? "absolute rounded-[10] bg-[#ffffff22]"
              : "absolute rounded-[8] bg-[#ffffff22]"
        }
        style={{ insetL: p.at.x, insetT: p.at.y, width: p.at.w, height: p.at.h }}
      />
    </Show>
  );
}

export interface RowProps {
  /** The row's own top, in its container. */
  y: number;
  width: number;
  height: number;
  /** Leading glyph; "" leaves the box empty. */
  glyph: string | (() => string);
  glyphTone?: Tone | (() => Tone);
  label: string | (() => string);
  labelTone?: "text" | "danger" | "dim";
  /** Trailing glyph (a chevron, a tick). */
  trailing?: () => { glyph: string; tone: Tone } | null;
  /** Highlighted: a finger is on it, or it is the hot item of a slide. */
  hot?: () => boolean;
  /** Draw the hairline above this row (every row but the first). */
  hairline?: boolean;
}

/**
 * One list row: leading glyph, label on the middle line, optional trailing
 * glyph, a highlight and a hairline — all placed by rowMetrics, so a popup
 * row and a sheet row line up with each other.
 */
export function Row(p: RowProps) {
  const m = () => rowMetrics(p.width, p.height, p.trailing !== undefined);
  const label = () => (typeof p.label === "function" ? p.label() : p.label);
  return (
    <View class="absolute left-0" style={{ insetT: p.y, width: p.width, height: p.height }}>
      <Show when={p.hairline}>
        <View
          class="absolute h-[1] bg-[#41486880]"
          style={{ insetL: m().hairline.x, insetT: 0, width: m().hairline.w }}
          ref={themed("surfaceMutedDim")}
        />
      </Show>
      <Show when={p.hot?.()}>
        <View
          class="absolute rounded-[8] bg-[#7aa2f733]"
          style={{ insetL: m().highlight.x, insetT: m().highlight.y, width: m().highlight.w, height: m().highlight.h }}
          ref={themed("accentTint")}
        />
      </Show>
      <View
        class="absolute items-center justify-center"
        style={{ insetL: m().icon.x, insetT: m().icon.y, width: m().icon.w, height: m().icon.h }}
      >
        <Icon glyph={p.glyph} tone={p.glyphTone ?? "fg"} size="lg" />
      </View>
      <View
        class="absolute items-center overflow-hidden"
        style={{ insetL: m().label.x, insetT: 0, width: m().label.w, height: p.height }}
      >
        <Text
          class={
            p.labelTone === "danger"
              ? "text-sm text-[#f7768e]"
              : p.labelTone === "dim"
                ? "text-sm text-[#565f89]"
                : "text-sm text-[#c0caf5]"
          }
          ref={themed(p.labelTone === "danger" ? "textDanger" : p.labelTone === "dim" ? "textDim" : "text")}
        >
          {label()}
        </Text>
      </View>
      <Show when={p.trailing?.()}>
        {(t) => (
          <View
            class="absolute items-center justify-center"
            style={{ insetL: m().trailing!.x, insetT: m().trailing!.y, width: m().trailing!.w, height: m().trailing!.h }}
          >
            <Icon glyph={() => t().glyph} tone={() => t().tone} size="base" />
          </View>
        )}
      </Show>
    </View>
  );
}
