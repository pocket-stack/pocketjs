// apps/pocket-remote/pad.tsx — the long tail. The dock holds the nine things
// a remote is reached for; everything else Omarchy binds lives here, grouped
// the way its own menu groups them (Window, Desk, Toggle, Capture, Theme,
// System), as labelled keys on one sheet that slides over the stage. The
// rails stay live underneath: volume is never more than one thumb away.
//
// Destructive keys (close, suspend, close all) take a hold, and say so when
// tapped.

import { createEffect, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import { type ActionId, actionById, PAD_PAGES } from "./actions.ts";
import type { GestureHandlers } from "./desk.tsx";
import { Icon } from "./icons.tsx";
import { SCREEN_W, within } from "./layout.ts";
import type { RemoteStore } from "./store.ts";
import { themed, themeTitle } from "./theme.ts";

export const PAD_X = 0;
export const PAD_W = SCREEN_W;
const HEADER_H = 32;
const TAB_W = 72;
const CLOSE_W = PAD_W - PAD_PAGES.length * TAB_W;
const GRID_TOP = HEADER_H + 8;
const COLS = 4;
const ROWS = 3;
const CELL_W = 116;
const CELL_H = 88;
const CELL_GAP = 4;
const GRID_X0 = PAD_X + Math.floor((PAD_W - COLS * CELL_W) / 2);
/** Theme page: cells 0..9 are themes, the last two the style actions. */
const THEME_CELLS = COLS * ROWS - 2;

interface Cell {
  kind: "action" | "theme" | "empty";
  id: string;
  label: string;
  hold: boolean;
  active: boolean;
}

function cells(store: RemoteStore, page: number): Cell[] {
  const def = PAD_PAGES[page];
  if (!def) return [];
  const out: Cell[] = [];
  if (def.id === "theme") {
    const themes = store.themeList();
    for (let i = 0; i < THEME_CELLS; i += 1) {
      const name = themes[i];
      out.push(
        name
          ? { kind: "theme", id: name, label: themeTitle(name), hold: false, active: name === store.themeName() }
          : { kind: "empty", id: `empty:${i}`, label: "", hold: false, active: false },
      );
    }
  }
  for (const id of def.actions) {
    const action = actionById(id);
    if (!action) continue;
    out.push({ kind: "action", id, label: action.label, hold: action.hold === true, active: false });
  }
  while (out.length < COLS * ROWS) out.push({ kind: "empty", id: `empty:${out.length}`, label: "", hold: false, active: false });
  return out.slice(0, COLS * ROWS);
}

function cellRect(i: number) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  return { x: GRID_X0 + col * CELL_W, y: GRID_TOP + row * CELL_H, w: CELL_W - CELL_GAP, h: CELL_H - CELL_GAP };
}

function cellAt(x: number, y: number): number | null {
  if (y < GRID_TOP || x < GRID_X0) return null;
  const col = Math.floor((x - GRID_X0) / CELL_W);
  const row = Math.floor((y - GRID_TOP) / CELL_H);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return row * COLS + col;
}

/** The pad's touch handlers; app.tsx routes every contact here while it is open. */
export function padHandlers(store: RemoteStore): GestureHandlers {
  let downCell: number | null = null;
  let downTab: number | null = null;
  let closeDown = false;
  const active = () => store.pad() !== null;
  return {
    onDown: (c) => {
      if (!active()) return;
      downCell = null;
      downTab = null;
      closeDown = false;
      if (!within(c.x, c.y, { x: PAD_X, y: 0, w: PAD_W, h: 320 })) return;
      if (c.y < HEADER_H) {
        const i = Math.floor((c.x - PAD_X) / TAB_W);
        if (i < PAD_PAGES.length) {
          downTab = i;
          store.pressDown(`padtab:${i}`);
        } else {
          closeDown = true;
          store.pressDown("padclose");
        }
        return;
      }
      downCell = cellAt(c.x, c.y);
      if (downCell !== null) store.pressDown(`cell:${downCell}`);
    },
    onTap: () => {
      if (!active()) return;
      store.pressRelease();
      if (closeDown) {
        store.setPad(null);
      } else if (downTab !== null) {
        store.setPad(store.pad() === downTab ? null : downTab);
      } else if (downCell !== null) {
        const cell = cells(store, store.pad()!)[downCell];
        if (!cell) return;
        if (cell.kind === "theme") store.chooseTheme(cell.id);
        else if (cell.kind === "action") {
          if (cell.hold) store.say(`hold to ${cell.label.toLowerCase()}`);
          else store.act(cell.id as ActionId);
        }
      }
      downCell = null;
      downTab = null;
      closeDown = false;
    },
    onLongPress: () => {
      if (!active() || downCell === null) return;
      const cell = cells(store, store.pad()!)[downCell];
      store.pressDown(null);
      if (cell && cell.kind === "action" && cell.hold) store.act(cell.id as ActionId);
      downCell = null;
    },
    onPanStart: () => {
      if (!active()) return;
      store.pressDown(null);
      downCell = null;
      downTab = null;
      closeDown = false;
    },
    onUp: () => {
      if (!active()) return;
      store.pressRelease();
    },
    onCancel: () => store.pressRelease(),
  };
}

export function Pad(p: { store: RemoteStore }) {
  const page = () => p.store.pad() ?? 0;
  const items = () => cells(p.store, page());
  return (
    <View class="absolute left-0 top-0 w-[480] h-[320] bg-[#1a1b26]" ref={themed("surface")}>
      {/* header: page tabs + close */}
      <View class="absolute left-0 top-0 w-[480] h-[32] bg-[#13141c]" ref={themed("surfaceDark")}>
        <Index each={PAD_PAGES}>
          {(def, i) => (
            <View class="absolute top-0 w-[72] h-[32] items-center justify-center" style={{ insetL: i * TAB_W }}>
              <View
                class={page() === i ? "absolute left-[6] top-[26] w-[60] h-[3] rounded-[2] bg-[#7aa2f7]" : "hidden"}
                ref={themed("accentFill")}
              />
              <Text
                class={page() === i ? "text-sm font-bold text-[#a9b1d6]" : "text-sm text-[#565f89]"}
                ref={themed(() => page() === i ? "text" : "textDim")}
              >
                {def().label}
              </Text>
              <View
                class={
                  p.store.pressed() === `padtab:${i}` ? "absolute left-0 top-0 w-[72] h-[32] bg-[#ffffff22]" : "hidden"
                }
              />
            </View>
          )}
        </Index>
        <View class="absolute top-0 h-[32] items-center justify-center" style={{ insetL: PAD_PAGES.length * TAB_W, width: CLOSE_W }}>
          <View class="absolute left-[8] top-[4] w-[24] h-[24]">
            <Icon name="close" tone="dim" />
          </View>
          <View
            class={p.store.pressed() === "padclose" ? "absolute left-0 top-0 w-[40] h-[32] bg-[#ffffff22]" : "hidden"}
          />
        </View>
      </View>
      {/* grid */}
      <Index each={items()}>
        {(cell, i) => {
          const r = cellRect(i);
          return (
            <Show when={cell().kind !== "empty"}>
              <View
                class={
                  cell().active
                    ? "absolute rounded-[10] bg-[#7aa2f7] items-center justify-center overflow-hidden"
                    : cell().hold
                      ? "absolute rounded-[10] bg-[#24283b] border border-[#f7768e] items-center justify-center overflow-hidden"
                      : "absolute rounded-[10] bg-[#24283b] items-center justify-center overflow-hidden"
                }
                style={{ insetL: r.x - PAD_X, insetT: r.y, width: r.w, height: r.h }}
                ref={(node) => {
                  themed(() => cell().active ? "accentFill" : "surfaceMutedDim")(node);
                  if (cell().hold) themed("borderDanger")(node);
                }}
              >
                <Show when={cell().kind === "theme"}>
                  <View class="absolute left-[8] top-[8] w-[10] h-[10] rounded-full bg-[#7aa2f7]" ref={themed("accentFill")} />
                </Show>
                <Text
                  class={
                    cell().active
                      ? "text-sm font-bold text-[#13141c]"
                      : cell().hold
                        ? "text-sm text-[#f7768e]"
                        : "text-sm text-[#a9b1d6]"
                  }
                  ref={themed(() => cell().active ? "textOnAccent" : cell().hold ? "textDanger" : "text")}
                >
                  {cell().label}
                </Text>
                <Show when={cell().hold}>
                  <Text class="absolute top-[62] text-xs text-[#565f89]" ref={themed("textDim")}>
                    hold
                  </Text>
                </Show>
                <View
                  class={
                    p.store.pressed() === `cell:${i}`
                      ? "absolute left-0 top-0 w-full h-full bg-[#ffffff22]"
                      : "hidden"
                  }
                />
              </View>
            </Show>
          );
        }}
      </Index>
      <HoldHint store={p.store} />
    </View>
  );
}

/** A hold key's progress: the row under the cells fills while it is held. */
function HoldHint(p: { store: RemoteStore }) {
  let bar: import("@pocketjs/framework/components").NodeMirror | null = null;
  createEffect(() => {
    if (!bar) return;
    const pressed = p.store.pressed();
    jump(bar, "opacity", pressed && pressed.startsWith("cell:") ? 1 : 0);
  });
  return (
    <View
      class="absolute left-[16] top-[308] w-[368] h-[3] rounded-[2] bg-[#414868]"
      ref={(node) => {
        bar = node;
        themed("surfaceMuted")(node);
      }}
    />
  );
}
