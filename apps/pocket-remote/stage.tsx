// SPDX-License-Identifier: GPL-3.0-or-later
// apps/pocket-remote/stage.tsx — the live miniature of the focused monitor:
// tiles = windows, accent border = focus. Tap focuses. Hold a tile and a
// popup answers at the finger — float or tile it, take it full screen,
// close it — and the SAME finger picks a row: slide onto it and let go, one
// gesture, or lift and tap. Drag a tiled window onto another to swap them,
// onto a strip tab to move it there; drag a floating window and it moves, on
// the laptop, under the finger. Swipe empty stage to step workspaces; an
// empty workspace offers the launchers.

import { Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { type ActionId, actionById, LAUNCHERS } from "./actions.ts";
import { GLYPH } from "./glyphs.ts";
import type { GestureHandlers } from "./handlers.ts";
import { Icon } from "./icons.tsx";
import {
  LAUNCH_BAR,
  launchCellAt,
  launchCellRect,
  popupRowAt,
  STAGE,
  STRIP,
  SWIPE_PX,
  tabAt,
  within,
} from "./layout.ts";
import { ICON_BOX, SPACE } from "./design.ts";
import { PopupBox, type PopupRow } from "./popup.tsx";
import type { RemoteStore, TileSlot } from "./store.ts";
import { themed } from "./theme.ts";

const LAUNCH_GLYPH: Record<string, string> = {
  terminal: GLYPH.terminal,
  browser: GLYPH.browser,
  files: GLYPH.files,
};

function Tile(p: { store: RemoteStore; slot: TileSlot }) {
  const s = p.slot;
  const dragged = () => p.store.drag()?.a === s.a;
  const over = () => p.store.drag()?.over === s.a;
  const held = () => p.store.popup()?.a === s.a;
  return (
    <View
      class={
        s.floating()
          ? "absolute rounded-[4] bg-[#292e42] border border-[#565f89] overflow-hidden"
          : "absolute rounded-[4] bg-[#24283b] border border-[#414868] overflow-hidden"
      }
      ref={p.store.bindSlot(s)}
    >
      <View class="absolute left-0 top-0 w-full h-full" ref={themed("surfaceMutedDim")} />
      <View
        class={s.focused() ? "absolute left-0 top-0 w-full h-full rounded-[4] border-2 border-[#7aa2f7]" : "hidden"}
        ref={themed("borderAccent")}
      />
      <Text
        class={s.focused() ? "absolute left-[6] top-[4] text-xs font-bold text-[#c0caf5]" : "absolute left-[6] top-[4] text-xs font-bold text-[#a9b1d6]"}
        ref={themed("text")}
      >
        {s.label()}
      </Text>
      <Show when={s.twoLines()}>
        <Text class="absolute left-[6] top-[19] text-xs text-[#565f89]" ref={themed("textDim")}>
          {s.title()}
        </Text>
      </Show>
      <Show when={s.floating()}>
        <View class="absolute right-[4] top-[4] w-[14] h-[14] items-center justify-center">
          <Icon glyph={GLYPH.float} tone="dim" size="sm" />
        </View>
      </Show>
      {/* the resize corner: three steps, the way a window's own grip reads */}
      <Show when={s.grip()}>
        <View class="absolute right-[3] bottom-[3] w-[14] h-[14]">
          <View class="absolute right-0 bottom-0 w-[14] h-[2] bg-[#565f89]" ref={themed("fgDimFill")} />
          <View class="absolute right-0 bottom-0 w-[2] h-[14] bg-[#565f89]" ref={themed("fgDimFill")} />
          <View class="absolute right-[5] bottom-[5] w-[9] h-[2] bg-[#565f8999]" ref={themed("fgDimFill")} />
          <View class="absolute right-[5] bottom-[5] w-[2] h-[9] bg-[#565f8999]" ref={themed("fgDimFill")} />
        </View>
      </Show>
      <View
        class={
          dragged()
            ? "absolute left-0 top-0 w-full h-full bg-[#7aa2f766]"
            : over()
              ? "absolute left-0 top-0 w-full h-full bg-[#9ece6a55]"
              : held() || p.store.pressed() === `tile:${s.a}`
                ? "absolute left-0 top-0 w-full h-full bg-[#ffffff1a]"
                : "hidden"
        }
      />
    </View>
  );
}

/**
 * The launch bar: terminal, browser, files, fixed across the bottom of the
 * stage. Three equal cells, so the targets are wide even though the bar is
 * short, and no hunting for the three things a remote is reached for.
 */
export function LaunchBar(p: { store: RemoteStore }) {
  return (
    <View
      class="absolute left-0 w-[480] h-[32] bg-[#13141c]"
      style={{ insetT: LAUNCH_BAR.y }}
      ref={themed("surfaceDark")}
    >
      <Index each={LAUNCHERS}>
        {(id, i) => {
          const r = launchCellRect(i, LAUNCHERS.length);
          // The icon-plus-label group, centred: a 24 px glyph, a gap, and
          // room for the longest of the three labels.
          const groupW = ICON_BOX + SPACE.lg + 62;
          const group = { x: Math.round((r.w - groupW) / 2), w: groupW };
          return (
            <View class="absolute top-0 h-[32]" style={{ insetL: r.x, width: r.w }}>
              {/* the icon and label sit as one group, centred in the cell */}
              <View class="absolute top-0 h-[32]" style={{ insetL: group.x, width: group.w }}>
                <View class="absolute left-0 top-[4] w-[24] h-[24] items-center justify-center">
                  <Icon glyph={LAUNCH_GLYPH[id()] ?? GLYPH.launch} tone="fg" size="lg" />
                </View>
                <View class="absolute top-0 h-[32] items-center" style={{ insetL: ICON_BOX + SPACE.lg, width: group.w - ICON_BOX - SPACE.lg }}>
                  <Text class="text-sm text-[#c0caf5]" ref={themed("text")}>
                    {actionById(id())?.label ?? id()}
                  </Text>
                </View>
              </View>
              <View
                class={p.store.pressed() === `launch:${i}` ? "absolute top-[2] h-[28] rounded-[8] bg-[#ffffff22]" : "hidden"}
                style={{ insetL: SPACE.xs, width: r.w - 2 * SPACE.xs }}
              />
              <View class={i === 0 ? "hidden" : "absolute left-0 top-[6] w-[1] h-[20] bg-[#41486880]"} ref={themed("surfaceMutedDim")} />
            </View>
          );
        }}
      </Index>
    </View>
  );
}

/** The rows a held tile answers with: what a window's own title bar would
 *  offer if it had one. TILE_POPUP_ROWS sizes the box. */
const popupRows = (floating: boolean): PopupRow[] => [
  { glyph: floating ? GLYPH.tile : GLYPH.float, label: floating ? "Tile" : "Float" },
  { glyph: GLYPH.fullscreen, label: "Full screen" },
  { glyph: GLYPH.apps, label: "Open another" },
  { glyph: GLYPH.close, label: "Close", tone: "danger" },
];

export function Stage(p: { store: RemoteStore }) {
  const empty = () => {
    const s = p.store.state();
    return !!s && !s.win.some((w) => w.ws === s.active);
  };
  return (
    <View class="absolute left-0 top-[28] w-[480] h-[260] bg-[#1a1b26] overflow-hidden" ref={themed("surface")}>
      <Show when={empty()}>
        <View class="absolute left-0 top-[104] w-[480] h-[20] items-center justify-center">
          <Text class="text-sm text-[#565f89]" ref={themed("textDim")}>
            empty workspace
          </Text>
        </View>
        <View class="absolute left-0 top-[128] w-[480] h-[16] items-center justify-center">
          <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
            swipe for the next · the bar below launches
          </Text>
        </View>
      </Show>
      {/* tiles are positioned in screen space; the stage origin is offset */}
      <View class="absolute w-[480] h-[320]" style={{ insetL: -STAGE.x, insetT: -STAGE.y }}>
        <Index each={p.store.slots}>
          {(slot) => (
            <Show when={slot().live()}>
              <Tile store={p.store} slot={slot()} />
            </Show>
          )}
        </Index>
      </View>
    </View>
  );
}

/** The held tile's popup, drawn over everything on the stage. Its inputs are
 *  accessors: Show keeps one instance while the popup's own record changes
 *  (a moving highlight is a new record), so geometry read once would freeze. */
export function TilePopup(p: { store: RemoteStore }) {
  return (
    <Show when={p.store.popup()}>
      <PopupBox
        place={() => p.store.popup()!.place}
        rows={() => popupRows(p.store.popup()!.floating)}
        hot={() => p.store.popup()?.hot ?? null}
        progress={p.store.popupT}
      />
    </Show>
  );
}

// ---------------------------------------------------------------------------
// gestures
// ---------------------------------------------------------------------------

type Target =
  | { kind: "tile"; a: string }
  | { kind: "grip"; a: string }
  | { kind: "launch"; i: number }
  | { kind: "stage" }
  | { kind: "none" };

function stageTarget(store: RemoteStore, x: number, y: number): Target {
  const cell = launchCellAt(x, y, LAUNCHERS.length);
  if (cell !== null) return { kind: "launch", i: cell };
  if (!within(x, y, STAGE)) return { kind: "none" };
  // The corner first: it overlaps the tile it belongs to, and on the stage
  // it may also overlap the neighbour below and to the right.
  const grip = store.gripAt(x, y);
  if (grip) return { kind: "grip", a: grip };
  const a = store.windowAt(x, y);
  if (a) return { kind: "tile", a };
  return { kind: "stage" };
}

export function stageHandlers(store: RemoteStore): GestureHandlers {
  let down: Target = { kind: "none" };
  let swiping = false;
  let placing = false;
  /**
   * The contact that opened a tile's popup is still down: it now picks a
   * row. One gesture — hold, slide, release — and lifting WITHOUT sliding
   * leaves the popup up for a tap instead of running whatever the resting
   * finger happens to cover, which on a 260 px stage is often a row (and
   * the last row closes the window).
   */
  let picking = false;
  let pickFrom = { x: 0, y: 0 };
  const PICK_SLOP = 12;
  const slid = (c: { x: number; y: number }): boolean =>
    Math.abs(c.x - pickFrom.x) > PICK_SLOP || Math.abs(c.y - pickFrom.y) > PICK_SLOP;
  /** A corner drag: the window is being resized. */
  let sizing = false;
  const reset = () => {
    store.pressRelease();
    store.setDrag(null);
    swiping = false;
    placing = false;
    picking = false;
    sizing = false;
  };
  return {
    onDown: (c) => {
      down = stageTarget(store, c.x, c.y);
      picking = false;
      sizing = false;
      store.pressDown(
        down.kind === "tile" || down.kind === "grip" ? `tile:${down.a}` : down.kind === "launch" ? `launch:${down.i}` : null,
      );
    },
    onMove: (c) => {
      if (!picking) return;
      const popup = store.popup();
      if (popup) store.popupHover(slid(c) ? popupRowAt(popup.place, c.x, c.y) : null);
    },
    onTap: () => {
      const t = down;
      store.pressRelease();
      if (t.kind === "tile" || t.kind === "grip") store.focusWindow(t.a);
      else if (t.kind === "launch") store.act(LAUNCHERS[t.i] as ActionId);
      down = { kind: "none" };
    },
    onLongPress: (c) => {
      if (down.kind === "grip") return; // the corner is a drag, not a menu
      if (down.kind === "tile") {
        store.pressDown(null);
        store.openPopup(down.a, c.x, c.y);
        picking = true;
        pickFrom = { x: c.x, y: c.y };
        down = { kind: "none" };
      }
    },
    onPanStart: (c) => {
      if (picking) return; // the slide belongs to the popup, not the stage
      const t = down;
      store.pressDown(null);
      if (t.kind === "grip") {
        sizing = true;
        store.resizeBegin(t.a);
        store.resizeBy(c.fdx, c.fdy);
      } else if (t.kind === "tile" && store.isFloating(t.a)) {
        placing = true;
        store.placeBegin(t.a, c.startX, c.startY);
        store.placeTo(c.x, c.y);
      } else if (t.kind === "tile") {
        store.setDrag({ a: t.a, x: c.x, y: c.y, over: null, overWs: null });
      } else {
        swiping = true;
      }
    },
    onPanMove: (c) => {
      if (picking) {
        const popup = store.popup();
        if (popup) store.popupHover(slid(c) ? popupRowAt(popup.place, c.x, c.y) : null);
        return;
      }
      if (sizing) {
        store.resizeBy(c.fdx, c.fdy);
        return;
      }
      if (placing) {
        store.placeTo(c.x, c.y);
        return;
      }
      const drag = store.drag();
      if (drag) {
        const overA = within(c.x, c.y, STAGE) ? store.windowAt(c.x, c.y) : null;
        const tab = c.y < STRIP.h ? tabAt(c.x, store.tabs()) : null;
        store.setDrag({
          a: drag.a,
          x: c.x,
          y: c.y,
          over: overA !== null && overA !== drag.a ? overA : null,
          overWs: tab ? tab.id : null,
        });
      }
    },
    onUp: (c) => {
      if (picking) {
        // Slid onto a row: run it. Lifted where it started: the popup stays
        // up, so the same choice can be made with a tap.
        const popup = store.popup();
        const row = popup && slid(c) ? popupRowAt(popup.place, c.x, c.y) : null;
        if (row !== null) store.popupRun(row);
        else store.popupHover(null);
        reset();
        return;
      }
      if (sizing) {
        store.resizeBy(0, 0, true);
        reset();
        return;
      }
      if (placing) {
        store.placeTo(c.x, c.y, true);
        reset();
        return;
      }
      const drag = store.drag();
      if (drag) {
        if (drag.overWs !== null && drag.overWs !== store.state()?.active) store.moveWindow(drag.a, drag.overWs);
        else if (drag.over !== null) store.swapWindows(drag.a, drag.over);
        reset();
        return;
      }
      if (swiping && Math.abs(c.dx) >= SWIPE_PX && Math.abs(c.dx) > Math.abs(c.dy)) {
        store.workspaceStep(c.dx < 0 ? 1 : -1);
      }
      reset();
    },
    onCancel: () => {
      if (placing) store.placeCancel();
      if (sizing) store.resizeCancel();
      if (picking) store.popupHover(null);
      reset();
    },
  };
}

/** While a tile's popup is up and no finger is mid-gesture on it: a row
 *  answers a release, a touch anywhere else puts the popup away. */
export function popupHandlers(store: RemoteStore): GestureHandlers {
  let outside = false;
  return {
    onDown: (c) => {
      const popup = store.popup();
      if (!popup) return;
      const row = popupRowAt(popup.place, c.x, c.y);
      outside = row === null;
      if (outside) {
        store.closePopup();
        return;
      }
      store.popupHover(row);
      store.pressDown(`popup:${row}`);
    },
    onMove: (c) => {
      const popup = store.popup();
      if (!popup || outside) return;
      store.popupHover(popupRowAt(popup.place, c.x, c.y));
    },
    onUp: (c) => {
      // The action runs here, not in onTap: onUp comes first for one
      // release and clearing the highlight there left onTap with nothing.
      const popup = store.popup();
      store.pressRelease();
      if (!popup || outside) return;
      const row = popupRowAt(popup.place, c.x, c.y);
      if (row !== null) store.popupRun(row);
      else store.popupHover(null);
    },
    onCancel: () => {
      store.pressRelease();
      store.popupHover(null);
    },
  };
}
