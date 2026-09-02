// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/strip.tsx — the top strip: the workspace tabs (a FIXED
// 1..N, because Omarchy binds those numbers whether or not Hyprland is
// keeping a workspace alive), the mode switch centred on the bar, the active
// layout's name, and the control centre's button at the end.
//
// Tap a tab to go there, hold one to bring the focused window along. Tap the
// control centre to open it sticky; hold it and slide down onto a slider to
// adjust and let go.

import { Index } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon } from "./icons.tsx";
import { BADGE, CC_BUTTON, MODE, MODE_HALF_W, STRIP, tabAt, within } from "./layout.ts";
import type { RemoteStore } from "./store.ts";
import { themed } from "./theme.ts";

export function Strip(p: { store: RemoteStore }) {
  const tabs = () => p.store.tabs();
  const active = () => p.store.state()?.active ?? -1;
  const layoutLabel = () => (p.store.layout() === "scrolling" ? "scrolling" : "dwindle");
  const stage = () => p.store.mode() === "stage";
  return (
    <View class="absolute left-0 top-0 w-[480] h-[28] bg-[#13141c]" ref={themed("surfaceDark")}>
      <Index each={tabs()}>
        {(tab) => (
          <View class="absolute top-[2] w-[24] h-[24] items-center justify-center" style={{ insetL: tab().x - STRIP.x }}>
            <View
              class={
                tab().id === active()
                  ? "absolute left-[1] top-0 w-[22] h-[24] rounded-[6] bg-[#7aa2f7]"
                  : tab().n > 0
                    ? "absolute left-[1] top-0 w-[22] h-[24] rounded-[6] bg-[#414868]"
                    : "absolute left-[1] top-0 w-[22] h-[24] rounded-[6] bg-[#1a1b26]"
              }
              ref={themed(() => (tab().id === active() ? "accentFill" : tab().n > 0 ? "surfaceMuted" : "surface"))}
            />
            <Text
              class={
                tab().id === active()
                  ? "text-sm font-bold text-[#13141c]"
                  : tab().n > 0
                    ? "text-sm font-bold text-[#a9b1d6]"
                    : "text-sm text-[#565f89]"
              }
              ref={themed(() => (tab().id === active() ? "textOnAccent" : tab().n > 0 ? "text" : "textDim"))}
            >
              {tab().id === 10 ? "0" : `${tab().id}`}
            </Text>
            <View
              class={
                p.store.pressed() === `tab:${tab().id}`
                  ? "absolute left-[1] top-0 w-[22] h-[24] rounded-[6] bg-[#ffffff33]"
                  : p.store.drag()?.overWs === tab().id
                    ? "absolute left-[1] top-0 w-[22] h-[24] rounded-[6] bg-[#9ece6a66]"
                    : "hidden"
              }
            />
          </View>
        )}
      </Index>
      {/* layout badge */}
      <View
        class="absolute rounded-[6] bg-[#1a1b26] items-center justify-center"
        style={{ insetL: BADGE.x, insetT: BADGE.y, width: BADGE.w, height: BADGE.h }}
        ref={themed("surface")}
      >
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {layoutLabel()}
        </Text>
        <View class={p.store.pressed() === "badge" ? "absolute left-0 top-0 w-[62] h-[20] rounded-[6] bg-[#ffffff22]" : "hidden"} />
      </View>
      {/* mode switch */}
      <View
        class="absolute rounded-[7] bg-[#1a1b26]"
        style={{ insetL: MODE.x, insetT: MODE.y, width: MODE.w, height: MODE.h }}
        ref={themed("surface")}
      >
        <View
          class="absolute top-[2] w-[30] h-[18] rounded-[5] bg-[#414868]"
          style={{ insetL: stage() ? 2 : MODE_HALF_W + 2 }}
          ref={themed("surfaceMuted")}
        />
        <View class="absolute left-0 top-0 w-[34] h-[22] items-center justify-center">
          <Icon glyph={GLYPH.stage} tone={() => (stage() ? "fg" : "dim")} size="base" />
        </View>
        <View class="absolute left-[34] top-0 w-[34] h-[22] items-center justify-center">
          <Icon glyph={GLYPH.deck} tone={() => (stage() ? "dim" : "fg")} size="base" />
        </View>
        <View
          class={
            p.store.pressed() === "mode:stage"
              ? "absolute left-0 top-0 w-[34] h-[22] rounded-[7] bg-[#ffffff22]"
              : p.store.pressed() === "mode:deck"
                ? "absolute left-[34] top-0 w-[34] h-[22] rounded-[7] bg-[#ffffff22]"
                : "hidden"
          }
        />
      </View>
      {/* control centre */}
      <View
        class="absolute items-center justify-center"
        style={{ insetL: CC_BUTTON.x, insetT: CC_BUTTON.y, width: CC_BUTTON.w, height: CC_BUTTON.h }}
      >
        <View
          class={p.store.cc() ? "absolute left-[3] top-0 w-[28] h-[24] rounded-[6] bg-[#7aa2f733]" : "hidden"}
          ref={themed("accentTint")}
        />
        <Icon glyph={GLYPH.tune} tone={() => (p.store.cc() ? "accent" : "fg")} size="lg" />
        <View class={p.store.pressed() === "cc" ? "absolute left-[3] top-0 w-[28] h-[24] rounded-[6] bg-[#ffffff22]" : "hidden"} />
      </View>
    </View>
  );
}

type Target =
  | { kind: "tab"; id: number }
  | { kind: "badge" }
  | { kind: "mode"; to: "stage" | "deck" }
  | { kind: "cc" }
  | { kind: "none" };

function stripTarget(store: RemoteStore, x: number, y: number): Target {
  if (within(x, y, CC_BUTTON)) return { kind: "cc" };
  if (within(x, y, MODE)) return { kind: "mode", to: x < MODE.x + MODE_HALF_W ? "stage" : "deck" };
  if (within(x, y, BADGE)) return { kind: "badge" };
  const tab = tabAt(x, store.tabs());
  return tab ? { kind: "tab", id: tab.id } : { kind: "none" };
}

function pressId(t: Target): string | null {
  switch (t.kind) {
    case "tab":
      return `tab:${t.id}`;
    case "badge":
      return "badge";
    case "mode":
      return `mode:${t.to}`;
    case "cc":
      return "cc";
    default:
      return null;
  }
}

/** The strip's touch handlers. A hold on the control centre's button turns
 *  the rest of that contact into a slide over the card. */
export function stripHandlers(store: RemoteStore): GestureHandlers {
  let down: Target = { kind: "none" };
  let sliding = false;
  const reset = () => {
    store.pressRelease();
    sliding = false;
  };
  return {
    onDown: (c) => {
      down = stripTarget(store, c.x, c.y);
      sliding = false;
      store.pressDown(pressId(down));
    },
    onMove: (c) => {
      if (sliding) store.ccFollow(c.x, c.y);
    },
    onTap: () => {
      const t = down;
      store.pressRelease();
      switch (t.kind) {
        case "tab":
          store.workspace(t.id);
          break;
        case "badge":
          store.act("layout");
          break;
        case "mode":
          store.setMode(t.to);
          break;
        case "cc":
          if (store.cc()) store.closeCc();
          else store.openCc("sticky");
          break;
        default:
          break;
      }
      down = { kind: "none" };
    },
    onLongPress: (c) => {
      const t = down;
      if (t.kind === "tab") {
        // Hold a tab: bring the focused window here and follow it.
        const focus = store.state()?.focus;
        store.pressDown(null);
        if (focus) {
          store.moveWindow(focus, t.id);
          store.workspace(t.id);
        }
        down = { kind: "none" };
      } else if (t.kind === "cc") {
        store.pressDown(null);
        store.openCc("hold", null, c.x);
        sliding = true;
      }
    },
    onPanStart: () => {
      if (!sliding) store.pressDown(null);
    },
    onUp: (c) => {
      if (sliding) {
        store.ccFollow(c.x, c.y);
        store.ccReleased();
      }
      reset();
    },
    onCancel: () => {
      if (sliding) store.ccReleased();
      reset();
    },
  };
}
