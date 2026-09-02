// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/menu-sheet.tsx — Omarchy's menu (SUPER + SPACE) as a
// sheet in the middle of the screen: the same rows in the same order with
// the same glyphs, two columns wide, scrolling. A submenu opens in place
// with its title in the header and a back chevron; an action runs on the
// laptop and the sheet goes away; a provider submenu (Apps, Fonts) is listed
// by the shell at open time, so it opens on the laptop instead.

import { createEffect, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon, type Tone } from "./icons.tsx";
import { SHEET, SHEET_BACK, SHEET_CLOSE, SHEET_COL_W, SHEET_LIST, SHEET_ROW_H, sheetRowAt, sheetRowRect, within } from "./layout.ts";
import { MENU_DOT_EMOJI, menuTitle } from "./menu-tree.ts";
import type { MenuItem } from "./menu.ts";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

function RowIcon(p: { item: MenuItem }) {
  const dot = () => MENU_DOT_EMOJI[p.item.icon];
  return (
    <Show when={!dot()} fallback={<View class={dotClass(dot()!)} ref={themed(dot() === "ok" ? "okFillDot" : dot() === "warn" ? "warnFill" : "dangerFill")} />}>
      <Icon glyph={p.item.icon || GLYPH.dot} tone={p.item.icon ? "fg" : "dim"} size="lg" />
    </Show>
  );
}

function dotClass(tone: "ok" | "warn" | "danger"): string {
  switch (tone) {
    case "ok":
      return "w-[10] h-[10] rounded-full bg-[#9ece6a]";
    case "warn":
      return "w-[10] h-[10] rounded-full bg-[#e0af68]";
    default:
      return "w-[10] h-[10] rounded-full bg-[#f7768e]";
  }
}

function Row(p: { store: RemoteStore; item: MenuItem; i: number }) {
  const r = sheetRowRect(p.i);
  const hot = () => p.store.sheet()?.hot === p.i;
  const checked = () => p.store.menuChecked().has(p.item.id);
  const trailing = (): { glyph: string; tone: Tone } | null => {
    if (checked()) return { glyph: GLYPH.check, tone: "accent" };
    if (p.item.kind === "menu") return { glyph: GLYPH.chevronRight, tone: "dim" };
    if (p.item.kind === "provider" || p.item.kind === "link") return { glyph: GLYPH.launch, tone: "dim" };
    return null;
  };
  return (
    <View class="absolute" style={{ insetL: r.x, insetT: r.y, width: r.w, height: r.h }}>
      <View class={hot() ? "absolute left-0 top-[1] w-[198] h-[36] rounded-[8] bg-[#7aa2f733]" : "hidden"} ref={themed("accentTint")} />
      <View class="absolute left-[8] top-[7] w-[24] h-[24] items-center justify-center">
        <RowIcon item={p.item} />
      </View>
      <View class="absolute left-[40] top-0 w-[134] h-[38] items-start justify-center overflow-hidden">
        <Text class="text-sm text-[#c0caf5]" ref={themed("text")}>
          {p.item.label}
        </Text>
      </View>
      <Show when={trailing()}>
        {(t) => (
          <View class="absolute left-[172] top-[7] w-[24] h-[24] items-center justify-center">
            <Icon glyph={() => t().glyph} tone={() => t().tone} size="base" />
          </View>
        )}
      </Show>
    </View>
  );
}

export function MenuSheet(p: { store: RemoteStore }) {
  let veil: NodeMirror | null = null;
  let card: NodeMirror | null = null;
  let list: NodeMirror | null = null;
  createEffect(() => {
    const t = p.store.sheetT();
    if (veil) jump(veil, "opacity", t);
    if (card) {
      jump(card, "opacity", t);
      jump(card, "scale", 0.94 + 0.06 * t);
    }
  });
  createEffect(() => {
    if (!list) return;
    const t = p.store.sheetListT();
    jump(list, "opacity", t);
    jump(list, "translateX", Math.round((1 - t) * 20));
    jump(list, "translateY", -Math.round(p.store.sheetScroller.offset()));
  });
  const sheet = () => p.store.sheet();
  const title = () => menuTitle(sheet()?.at ?? "root");
  const atRoot = () => (sheet()?.trail.length ?? 0) === 0;
  const rows = () => p.store.sheetRows();
  return (
    <>
      <View
        class="absolute left-0 top-0 w-[480] h-[320] bg-[#13141cb3]"
        ref={(node) => {
          veil = node;
          themed("surfaceVeil")(node);
        }}
      />
      <View
        class="absolute rounded-[14] bg-[#1a1b26] border border-[#414868] overflow-hidden"
        style={{ insetL: SHEET.x, insetT: SHEET.y, width: SHEET.w, height: SHEET.h }}
        ref={(node) => {
          card = node;
          themed("surface")(node);
          themed("borderMuted")(node);
        }}
      >
        {/* header */}
        <View class="absolute left-0 top-0 w-[420] h-[36] bg-[#13141c]" ref={themed("surfaceDark")}>
          <View class="absolute left-[4] top-[2] w-[44] h-[32] items-center justify-center">
            <Icon glyph={() => (atRoot() ? GLYPH.menu : GLYPH.chevronLeft)} tone={() => (atRoot() ? "dim" : "fg")} size="xl" />
            <View class={p.store.pressed() === "sheet:back" ? "absolute left-0 top-0 w-[44] h-[32] rounded-[8] bg-[#ffffff22]" : "hidden"} />
          </View>
          <View class="absolute left-[48] top-0 w-[324] h-[36] items-center justify-center">
            <Text class="text-sm font-bold text-[#c0caf5]" ref={themed("text")}>
              {title()}
            </Text>
          </View>
          <View class="absolute left-[372] top-[2] w-[44] h-[32] items-center justify-center">
            <Icon glyph={GLYPH.close} tone="dim" size="xl" />
            <View class={p.store.pressed() === "sheet:close" ? "absolute left-0 top-0 w-[44] h-[32] rounded-[8] bg-[#ffffff22]" : "hidden"} />
          </View>
        </View>
        {/* the list: a clip over a canvas the scroller moves */}
        <View
          class="absolute overflow-hidden"
          style={{ insetL: SHEET_LIST.x - SHEET.x, insetT: SHEET_LIST.y - SHEET.y, width: SHEET_LIST.w, height: SHEET_LIST.h }}
        >
          <View
            class="absolute left-0 top-0 w-[404] h-[320]"
            ref={(node) => {
              list = node;
            }}
          >
            <Index each={rows()}>{(item, i) => <Row store={p.store} item={item()} i={i} />}</Index>
            <Show when={rows().length === 0}>
              <View class="absolute left-0 top-[80] w-[404] h-[20] items-center justify-center">
                <Text class="text-sm text-[#565f89]" ref={themed("textDim")}>
                  nothing here on this machine
                </Text>
              </View>
            </Show>
          </View>
        </View>
      </View>
    </>
  );
}

export { SHEET_COL_W, SHEET_ROW_H };

/** The sheet owns every contact while it is up: rows answer taps, the list
 *  pans and flings, the header goes back or closes, outside closes. */
export function sheetHandlers(store: RemoteStore): GestureHandlers {
  type Down = { kind: "row"; i: number } | { kind: "back" } | { kind: "close" } | { kind: "list" } | { kind: "outside" } | { kind: "card" };
  let down: Down = { kind: "card" };
  let panning = false;
  return {
    onDown: (c) => {
      panning = false;
      if (within(c.x, c.y, SHEET_BACK)) {
        down = { kind: "back" };
        store.pressDown("sheet:back");
        return;
      }
      if (within(c.x, c.y, SHEET_CLOSE)) {
        down = { kind: "close" };
        store.pressDown("sheet:close");
        return;
      }
      if (within(c.x, c.y, SHEET_LIST)) {
        const i = sheetRowAt(c.x, c.y, store.sheetRows().length, store.sheetScroller.offset());
        down = i === null ? { kind: "list" } : { kind: "row", i };
        store.sheetHover(i);
        store.sheetScroller.stop();
        return;
      }
      if (!within(c.x, c.y, SHEET)) {
        down = { kind: "outside" };
        store.closeSheet();
        return;
      }
      down = { kind: "card" };
    },
    onTap: () => {
      const t = down;
      store.pressRelease();
      store.sheetHover(null);
      if (t.kind === "row") store.sheetTap(t.i);
      else if (t.kind === "back") store.sheetBack();
      else if (t.kind === "close") store.closeSheet();
    },
    onPanStart: (c) => {
      store.pressRelease();
      store.sheetHover(null);
      if (down.kind === "row" || down.kind === "list") {
        panning = true;
        store.sheetScroller.beginDrag();
        store.sheetScroller.drag(-c.fdy);
      }
    },
    onPanMove: (c) => {
      if (panning) store.sheetScroller.drag(-c.fdy);
    },
    onUp: (c) => {
      if (panning) store.sheetScroller.endDrag(-c.vy);
      panning = false;
      store.pressRelease();
      store.sheetHover(null);
    },
    onCancel: () => {
      if (panning) store.sheetScroller.endDrag(0);
      panning = false;
      store.pressRelease();
      store.sheetHover(null);
    },
  };
}
