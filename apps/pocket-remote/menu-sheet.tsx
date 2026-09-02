// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/menu-sheet.tsx — Omarchy's menu (SUPER + SPACE) as a
// sheet in the middle of the screen: the same rows in the same order with
// the same glyphs, one column, scrolling. A submenu opens in place with its
// title in the header and a back chevron; an action runs on the laptop and
// the sheet goes away. The `apps` provider is the exception the shell lists
// at open time, so the daemon sends the machine's applications and that row
// opens the list here; the other provider (Fonts) opens on the laptop.
//
// One column because a menu reads as a list: two columns of eleven-character
// labels made the eye jump, and Omarchy's own menu is a single column.

import { createEffect, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon, type Tone } from "./icons.tsx";
import {
  SHEET,
  SHEET_BACK,
  SHEET_CLOSE,
  SHEET_HEAD_H,
  SHEET_LIST,
  SHEET_RADIUS,
  sheetRowAt,
  sheetRowRect,
  within,
} from "./layout.ts";
import { MENU_DOT_EMOJI, menuTitle } from "./menu-tree.ts";
import { APPS_ROUTE, type RemoteStore, type SheetRow } from "./store.ts";
import { themed } from "./theme.ts";

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

function RowIcon(p: { row: SheetRow }) {
  const dot = () => MENU_DOT_EMOJI[p.row.icon];
  return (
    <Show
      when={!dot()}
      fallback={<View class={dotClass(dot()!)} ref={themed(dot() === "ok" ? "okFillDot" : dot() === "warn" ? "warnFill" : "dangerFill")} />}
    >
      <Icon
        glyph={() => p.row.icon || (p.row.kind === "app" ? GLYPH.apps : GLYPH.dot)}
        tone={() => (p.row.icon || p.row.kind === "app" ? "fg" : "dim")}
        size="lg"
      />
    </Show>
  );
}

function Row(p: { store: RemoteStore; row: SheetRow; i: number }) {
  const hot = () => p.store.sheet()?.hot === p.i;
  const trailing = (): { glyph: string; tone: Tone } | null => {
    if (p.row.checked) return { glyph: GLYPH.check, tone: "accent" };
    if (p.row.kind === "menu" || (p.row.kind === "provider" && p.row.id === APPS_ROUTE)) {
      return { glyph: GLYPH.chevronRight, tone: "dim" };
    }
    if (p.row.kind === "provider" || p.row.kind === "link") return { glyph: GLYPH.launch, tone: "dim" };
    return null;
  };
  return (
    <View class="absolute left-0 w-[328] h-[40]" style={{ insetT: sheetRowRect(p.i).y }}>
      <View class={hot() ? "absolute left-0 top-[2] w-[328] h-[36] rounded-[8] bg-[#7aa2f733]" : "hidden"} ref={themed("accentTint")} />
      <View class="absolute left-[8] top-[8] w-[24] h-[24] items-center justify-center">
        <RowIcon row={p.row} />
      </View>
      <View class="absolute left-[42] top-0 w-[252] h-[40] items-center overflow-hidden">
        <Text class="text-sm text-[#c0caf5]" ref={themed("text")}>
          {p.row.label}
        </Text>
      </View>
      <Show when={trailing()}>
        {(t) => (
          <View class="absolute left-[298] top-[8] w-[24] h-[24] items-center justify-center">
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
  const title = () => (sheet()?.at === APPS_ROUTE ? "Apps" : menuTitle(sheet()?.at ?? "root"));
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
        {/* Header. An overflow clip is a rectangular scissor, so a child
            cannot inherit the card's rounded corners: the bar is a rounded
            rect with its bottom half squared off by a plain one. */}
        <View class="absolute left-0 top-0 w-[344] h-[36] rounded-[14] bg-[#13141c]" ref={themed("surfaceDark")} />
        <View class="absolute left-0 w-[344] h-[22] bg-[#13141c]" style={{ insetT: SHEET_RADIUS }} ref={themed("surfaceDark")} />
        <View class="absolute left-[4] top-[2] w-[44] h-[32] items-center justify-center">
          <Icon glyph={() => (atRoot() ? GLYPH.menu : GLYPH.chevronLeft)} tone={() => (atRoot() ? "dim" : "fg")} size="xl" />
          <View class={p.store.pressed() === "sheet:back" ? "absolute left-0 top-0 w-[44] h-[32] rounded-[8] bg-[#ffffff22]" : "hidden"} />
        </View>
        <View class="absolute left-[48] top-0 w-[248] h-[36] items-center justify-center">
          <Text class="text-sm font-bold text-[#c0caf5]" ref={themed("text")}>
            {title()}
          </Text>
        </View>
        <View class="absolute left-[296] top-[2] w-[44] h-[32] items-center justify-center">
          <Icon glyph={GLYPH.close} tone="dim" size="xl" />
          <View class={p.store.pressed() === "sheet:close" ? "absolute left-0 top-0 w-[44] h-[32] rounded-[8] bg-[#ffffff22]" : "hidden"} />
        </View>
        {/* the list: a clip over a canvas the scroller moves */}
        <View
          class="absolute overflow-hidden"
          style={{ insetL: SHEET_LIST.x - SHEET.x, insetT: SHEET_HEAD_H, width: SHEET_LIST.w, height: SHEET_LIST.h }}
        >
          <View
            class="absolute left-0 top-0 w-[328] h-[2000]"
            ref={(node) => {
              list = node;
            }}
          >
            <Index each={rows()}>{(row, i) => <Row store={p.store} row={row()} i={i} />}</Index>
            <Show when={rows().length === 0}>
              <View class="absolute left-0 top-[80] w-[328] h-[20] items-center justify-center">
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

/** The sheet owns every contact while it is up: rows answer a release, the
 *  list pans and flings, the header goes back or closes, outside closes. */
export function sheetHandlers(store: RemoteStore): GestureHandlers {
  type Down = { kind: "row"; i: number } | { kind: "back" } | { kind: "close" } | { kind: "list" } | { kind: "outside" } | { kind: "card" };
  let down: Down = { kind: "card" };
  let panning = false;
  const rowUnder = (x: number, y: number): number | null => sheetRowAt(x, y, store.sheetRows().length, store.sheetScroller.offset());
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
        const i = rowUnder(c.x, c.y);
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
    onMove: (c) => {
      // A finger sliding between rows without panning moves the highlight,
      // so a hold-and-release lands where the eye is.
      if (!panning && down.kind === "row") {
        const i = rowUnder(c.x, c.y);
        if (i !== null) down = { kind: "row", i };
        store.sheetHover(i);
      }
    },
    onUp: (c) => {
      // onUp precedes onTap for one release, so the row runs here: reading
      // the highlight in onTap would see it already cleared.
      if (panning) {
        store.sheetScroller.endDrag(-c.vy);
        panning = false;
        store.pressRelease();
        return;
      }
      const t = down;
      store.pressRelease();
      store.sheetHover(null);
      down = { kind: "card" };
      if (t.kind === "row") store.sheetTap(t.i);
      else if (t.kind === "back") store.sheetBack();
      else if (t.kind === "close") store.closeSheet();
    },
    onPanStart: (c) => {
      store.pressRelease();
      store.sheetHover(null);
      if (down.kind === "row" || down.kind === "list") {
        panning = true;
        down = { kind: "list" };
        store.sheetScroller.beginDrag();
        store.sheetScroller.drag(-c.fdy);
      }
    },
    onPanMove: (c) => {
      if (panning) store.sheetScroller.drag(-c.fdy);
    },
    onCancel: () => {
      if (panning) store.sheetScroller.endDrag(0);
      panning = false;
      store.pressRelease();
      store.sheetHover(null);
      down = { kind: "card" };
    },
  };
}
