// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/popup.tsx — the classic popup: one container of rows
// with hairlines between them, growing out of the point it answers. No
// caret: at this size a triangle cannot meet a rounded, bordered body
// without a visible seam, and the popup already reads as belonging to the
// finger that opened it.

import { createEffect, Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { Icon, type Tone } from "./icons.tsx";
import { type Popup, POPUP_PAD, POPUP_ROW_H } from "./layout.ts";
import { themed } from "./theme.ts";

export interface PopupRow {
  glyph: string;
  label: string;
  tone?: Tone;
}

export function PopupBox(p: { place: () => Popup; rows: () => readonly PopupRow[]; hot: () => number | null; progress: () => number }) {
  let root: NodeMirror | null = null;
  let body: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const t = p.progress();
    const place = p.place();
    jump(root, "opacity", t);
    jump(root, "scale", 0.92 + 0.08 * t);
    // Grows towards the finger: from the edge the anchor is on.
    jump(root, "translateY", Math.round((1 - t) * (place.below ? -6 : 6)));
  });
  createEffect(() => {
    if (!body) return;
    const place = p.place();
    jump(body, "insetL", place.x);
    jump(body, "insetT", place.y);
    jump(body, "width", place.w);
    jump(body, "height", place.h);
  });
  return (
    <View
      class="absolute left-0 top-0 w-[480] h-[320]"
      ref={(node) => {
        root = node;
      }}
    >
      <View
        class="absolute rounded-[10] bg-[#13141c] border border-[#414868] overflow-hidden"
        ref={(node) => {
          body = node;
          themed("surfaceDark")(node);
          themed("borderMuted")(node);
        }}
      >
        <Index each={p.rows()}>
          {(row, i) => (
            <View class="absolute left-0 w-full h-[36]" style={{ insetT: POPUP_PAD + i * POPUP_ROW_H }}>
              <View
                class={i === 0 ? "hidden" : "absolute left-[12] top-0 w-[152] h-[1] bg-[#41486880]"}
                ref={themed("surfaceMutedDim")}
              />
              <View class={p.hot() === i ? "absolute left-[4] top-[1] w-[168] h-[34] rounded-[7] bg-[#7aa2f733]" : "hidden"} ref={themed("accentTint")} />
              <View class="absolute left-[10] top-[6] w-[24] h-[24] items-center justify-center">
                <Icon glyph={row().glyph} tone={row().tone ?? "fg"} size="lg" />
              </View>
              <View class="absolute left-[42] top-0 w-[124] h-[36] items-center">
                <Text
                  class={row().tone === "danger" ? "text-sm text-[#f7768e]" : "text-sm text-[#c0caf5]"}
                  ref={themed(row().tone === "danger" ? "textDanger" : "text")}
                >
                  {row().label}
                </Text>
              </View>
            </View>
          )}
        </Index>
      </View>
    </View>
  );
}
