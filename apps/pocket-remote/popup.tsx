// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/popup.tsx — the classic popup: one container of rows
// with hairlines between them and a caret at the point it answers, scaled
// and faded in from that point. The stage's tile menu is one; anything else
// that needs a small list at a finger can be another.
//
// The caret joins the body without a seam by drawing three things in order:
// a border-coloured diamond, the bordered body, then a body-coloured diamond
// on top that covers the border where the two meet.

import { createEffect, Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { Icon, type Tone } from "./icons.tsx";
import { type Popup, POPUP_CARET, POPUP_PAD, POPUP_ROW_H } from "./layout.ts";
import { themed } from "./theme.ts";

export interface PopupRow {
  glyph: string;
  label: string;
  tone?: Tone;
}

export function PopupBox(p: { place: Popup; rows: readonly PopupRow[]; hot: number | null; progress: () => number }) {
  let root: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const t = p.progress();
    jump(root, "opacity", t);
    jump(root, "scale", 0.92 + 0.08 * t);
    // Grows out of its anchor: from the caret's edge.
    jump(root, "translateY", Math.round((1 - t) * (p.place.below ? -6 : 6)));
  });
  const caretY = p.place.below ? p.place.y - POPUP_CARET : p.place.y + p.place.h - POPUP_CARET;
  const innerY = p.place.below ? p.place.y - POPUP_CARET + 2 : p.place.y + p.place.h - POPUP_CARET - 2;
  return (
    <View
      class="absolute left-0 top-0 w-[480] h-[320]"
      ref={(node) => {
        root = node;
      }}
    >
      {/* caret, border colour */}
      <View
        class="absolute w-[16] h-[16] rotate-45 bg-[#414868]"
        style={{ insetL: p.place.caretX - 8, insetT: caretY }}
        ref={themed("surfaceMuted")}
      />
      {/* body */}
      <View
        class="absolute rounded-[10] bg-[#13141c] border border-[#414868] overflow-hidden"
        style={{ insetL: p.place.x, insetT: p.place.y, width: p.place.w, height: p.place.h }}
        ref={(node) => {
          themed("surfaceDark")(node);
          themed("borderMuted")(node);
        }}
      >
        <Index each={p.rows}>
          {(row, i) => (
            <View class="absolute left-0 w-full h-[38]" style={{ insetT: POPUP_PAD + i * POPUP_ROW_H }}>
              <View class={i === 0 ? "hidden" : "absolute left-[12] top-0 h-[1] bg-[#41486880]"} style={{ width: p.place.w - 24 }} ref={themed("surfaceMutedDim")} />
              <View class="absolute left-[10] top-[7] w-[24] h-[24] items-center justify-center">
                <Icon glyph={row().glyph} tone={row().tone ?? "fg"} size="lg" />
              </View>
              <View class="absolute left-[42] top-0 h-[38] justify-center">
                <Text
                  class={row().tone === "danger" ? "text-sm text-[#f7768e]" : "text-sm text-[#c0caf5]"}
                  ref={themed(row().tone === "danger" ? "textDanger" : "text")}
                >
                  {row().label}
                </Text>
              </View>
              <View class={p.hot === i ? "absolute left-[4] top-[1] h-[36] rounded-[7] bg-[#7aa2f733]" : "hidden"} style={{ width: p.place.w - 8 }} ref={themed("accentTint")} />
            </View>
          )}
        </Index>
      </View>
      {/* caret, body colour, over the border */}
      <View
        class="absolute w-[14] h-[14] rotate-45 bg-[#13141c]"
        style={{ insetL: p.place.caretX - 7, insetT: innerY }}
        ref={themed("surfaceDark")}
      />
    </View>
  );
}
