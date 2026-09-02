// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/popup.tsx — the classic popup: one card of rows,
// growing out of the point it answers. Rows come from ui.tsx, so a popup's
// paddings are the sheet's paddings; no caret, because a triangle this small
// cannot meet a rounded, bordered card without a visible seam.

import { createEffect, Index } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import type { Tone } from "./icons.tsx";
import { type Popup, POPUP_PAD, POPUP_ROW_H } from "./layout.ts";
import { Card, Row } from "./ui.tsx";

export interface PopupRow {
  glyph: string;
  label: string;
  tone?: Tone;
}

export function PopupBox(p: {
  place: () => Popup;
  rows: () => readonly PopupRow[];
  hot: () => number | null;
  progress: () => number;
}) {
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
      <Card
        at={p.place()}
        ref={(node) => {
          body = node;
        }}
      >
        <Index each={p.rows()}>
          {(row, i) => (
            <Row
              y={POPUP_PAD + i * POPUP_ROW_H}
              width={p.place().w}
              height={POPUP_ROW_H}
              glyph={() => row().glyph}
              glyphTone={() => row().tone ?? "fg"}
              label={() => row().label}
              labelTone={row().tone === "danger" ? "danger" : "text"}
              hot={() => p.hot() === i}
              hairline={i > 0}
            />
          )}
        </Index>
      </Card>
    </View>
  );
}
