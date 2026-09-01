// apps/pocket-remote/desk.tsx — the main screen: two rails, the workspace
// strip, the live stage and the dock, plus the one gesture recogniser that
// routes every finger by where it landed. Every painted target answers a
// press with a tint overlay (a capacitive panel has no hover), continuous
// controls follow the finger relatively (touching a rail never jumps the
// level to the finger), and the only destructive act — closing a window —
// is a hold with a visible fill, never a tap.

import { createEffect, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { GestureContact } from "@pocketjs/framework/gesture";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { type ActionId, actionById, DOCK as DOCK_ACTIONS } from "./actions.ts";
import { Icon, type IconName } from "./icons.tsx";
import {
  BADGE_W,
  BADGE_X,
  DOCK,
  dockSlotAt,
  dockSlotX,
  MEDIA_W,
  MEDIA_X,
  RAIL_CAP_H,
  RAIL_LEFT,
  RAIL_RIGHT,
  RAIL_TRACK_BOTTOM,
  RAIL_TRACK_H,
  RAIL_TRACK_TOP,
  railDelta,
  railFill,
  STAGE,
  STRIP,
  SWIPE_PX,
  tabAt,
  within,
} from "./layout.ts";
import type { RemoteStore, TileSlot } from "./store.ts";
import { themed } from "./theme.ts";

/** The subset of gesture callbacks a sheet or the desk implements. */
export type GestureHandlers = {
  [K in "onDown" | "onTap" | "onLongPress" | "onPanStart" | "onPanMove" | "onUp" | "onCancel"]?: (c: GestureContact) => void;
};

const DOCK_ICONS: Record<string, IconName> = {
  menu: "menu",
  terminal: "terminal",
  browser: "browser",
  files: "files",
  editor: "editor",
  fullscreen: "fullscreen",
  float: "float",
  screenshot: "screenshot",
};

/** Dock captions: a 44 px slot fits about five characters at 12 px, so the
 *  dock speaks in short words; the pad and the toast use the full labels. */
const DOCK_LABELS: Record<string, string> = {
  menu: "Menu",
  terminal: "Term",
  browser: "Web",
  files: "Files",
  editor: "Edit",
  fullscreen: "Full",
  float: "Float",
  screenshot: "Shot",
};

/** Dock slot 8 opens the keyboard, slot 9 the pad; 0..7 are actions. */
const DOCK_KEYBOARD = 8;
const DOCK_MORE = 9;
const DOCK_ITEMS: readonly { id: string; label: string; icon: IconName }[] = [
  ...DOCK_ACTIONS.map((id) => ({ id, label: DOCK_LABELS[id] ?? actionById(id)!.label, icon: DOCK_ICONS[id]! })),
  { id: "keyboard", label: "Type", icon: "keyboard" },
];

// ---------------------------------------------------------------------------
// rails
// ---------------------------------------------------------------------------

function Rail(p: { store: RemoteStore; side: "left" | "right" }) {
  const rect = p.side === "left" ? RAIL_LEFT : RAIL_RIGHT;
  const level = () => (p.side === "left" ? p.store.bri() : p.store.vol());
  const pressedId = p.side === "left" ? "rail:bri" : "rail:vol";
  const capId = p.side === "left" ? "cap:bri" : "cap:vol";
  let fill: NodeMirror | null = null;
  const paintFill = () => {
    if (!fill) return;
    const h = railFill(level());
    jump(fill, "height", h);
    jump(fill, "insetT", RAIL_TRACK_H - h);
  };
  // The fill is geometry, so it moves through jump() as the level changes.
  createEffect(() => paintFill());
  const dragging = () => p.store.railDrag()?.rail === (p.side === "left" ? "bri" : "vol");
  const percent = () => `${Math.round(level() * 100)}`;
  return (
    <View
      class="absolute top-0 w-[40] h-[320] bg-[#13141c]"
      style={{ insetL: rect.x }}
      ref={themed("surfaceDark")}
    >
      {/* cap: brightness -> nightlight toggle, volume -> mute toggle */}
      <View class="absolute left-[8] top-[6] w-[24] h-[24]">
        <Show when={p.side === "left"}>
          <Icon name="sun" tone="fg" />
        </Show>
        <Show when={p.side === "right"}>
          <Show when={!p.store.mute()} fallback={<Icon name="mute" tone="dim" />}>
            <Icon name="speaker" tone="fg" />
          </Show>
        </Show>
      </View>
      <View
        class={
          p.store.pressed() === capId
            ? "absolute left-[4] top-[2] w-[32] h-[32] rounded-[8] bg-[#ffffff22]"
            : "hidden"
        }
      />
      {/* track */}
      <View
        class="absolute left-[14] w-[12] rounded-[6] bg-[#414868] overflow-hidden"
        style={{ insetT: RAIL_TRACK_TOP, height: RAIL_TRACK_H }}
        ref={themed("surfaceMutedDim")}
      >
        <View
          class="absolute left-0 w-[12] rounded-[6] bg-[#7aa2f7]"
          style={{ insetT: RAIL_TRACK_H, height: 0 }}
          ref={(node) => {
            fill = node;
            themed("accentFill")(node);
            paintFill();
          }}
        />
      </View>
      {/* value readout while the finger is down */}
      <Show when={dragging()}>
        <View class="absolute left-0 top-[302] w-[40] h-[16] items-center justify-center">
          <Text class="text-xs font-bold text-[#7aa2f7]" ref={themed("textAccent")}>
            {percent()}
          </Text>
        </View>
      </Show>
      <View
        class={
          p.store.pressed() === pressedId ? "absolute left-0 top-0 w-[40] h-[320] bg-[#ffffff0c]" : "hidden"
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// strip
// ---------------------------------------------------------------------------

function Strip(p: { store: RemoteStore }) {
  const tabs = () => p.store.tabs();
  const active = () => p.store.state()?.active ?? -1;
  const layoutLabel = () => (p.store.layout() === "scrolling" ? "scroll" : "dwindle");
  return (
    <View
      class="absolute left-[40] top-0 w-[400] h-[32] bg-[#13141c]"
      ref={themed("surfaceDark")}
    >
      <Index each={tabs()}>
        {(tab) => (
          <View
            class="absolute top-[4] w-[28] h-[24] items-center justify-center"
            style={{ insetL: tab().x - STRIP.x }}
          >
            <View
              class={
                tab().id === active()
                  ? "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#7aa2f7]"
                  : tab().n > 0
                    ? "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#414868]"
                    : "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#1a1b26]"
              }
              ref={themed(() => tab().id === active() ? "accentFill" : tab().n > 0 ? "surfaceMuted" : "surface")}
            />
            <Text
              class={
                tab().id === active()
                  ? "text-sm font-bold text-[#13141c]"
                  : tab().n > 0
                    ? "text-sm font-bold text-[#a9b1d6]"
                    : "text-sm text-[#565f89]"
              }
              ref={themed(() => tab().id === active() ? "textOnAccent" : tab().n > 0 ? "text" : "textDim")}
            >
              {tab().id === 10 ? "0" : `${tab().id}`}
            </Text>
            <View
              class={
                p.store.pressed() === `tab:${tab().id}`
                  ? "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#ffffff33]"
                  : p.store.drag()?.overWs === tab().id
                    ? "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#9ece6a66]"
                    : "hidden"
              }
            />
          </View>
        )}
      </Index>
      {/* layout badge */}
      <View
        class="absolute top-[6] w-[56] h-[20] rounded-[6] bg-[#1a1b26] items-center justify-center"
        style={{ insetL: BADGE_X - STRIP.x }}
        ref={themed("surface")}
      >
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {layoutLabel()}
        </Text>
        <View
          class={
            p.store.pressed() === "badge" ? "absolute left-0 top-0 w-[56] h-[20] rounded-[6] bg-[#ffffff22]" : "hidden"
          }
        />
      </View>
      {/* media transport */}
      <Index each={["prev", "play", "next"] as const}>
        {(op, i) => (
          <View
            class="absolute top-[4] w-[30] h-[24]"
            style={{ insetL: MEDIA_X - STRIP.x + i * MEDIA_W }}
          >
            <View class="absolute left-[3] top-0 w-[24] h-[24]">
              <Icon name={op()} tone="fg" />
            </View>
            <View
              class={
                p.store.pressed() === `media:${op()}`
                  ? "absolute left-0 top-0 w-[30] h-[24] rounded-[6] bg-[#ffffff22]"
                  : "hidden"
              }
            />
          </View>
        )}
      </Index>
    </View>
  );
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

function Tile(p: { store: RemoteStore; slot: TileSlot }) {
  const s = p.slot;
  const closing = () => {
    const c = p.store.closing();
    return c && c.a === s.a ? c : null;
  };
  const dragged = () => p.store.drag()?.a === s.a;
  const over = () => p.store.drag()?.over === s.a;
  return (
    <View
      class={
        s.focused()
          ? "absolute rounded-[4] bg-[#24283b] border-2 border-[#7aa2f7] overflow-hidden"
          : s.floating()
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
        class={s.focused() ? "absolute left-[5] top-[3] text-xs font-bold text-[#c0caf5]" : "absolute left-[5] top-[3] text-xs font-bold text-[#a9b1d6]"}
        ref={themed("text")}
      >
        {s.label()}
      </Text>
      <Show when={s.twoLines()}>
        <Text class="absolute left-[5] top-[18] text-xs text-[#565f89]" ref={themed("textDim")}>
          {s.title()}
        </Text>
      </Show>
      <View
        class={
          dragged()
            ? "absolute left-0 top-0 w-full h-full bg-[#7aa2f766]"
            : over()
              ? "absolute left-0 top-0 w-full h-full bg-[#9ece6a55]"
              : p.store.pressed() === `tile:${s.a}`
                ? "absolute left-0 top-0 w-full h-full bg-[#ffffff1a]"
                : closing()
                  ? "absolute left-0 top-0 w-full h-full bg-[#f7768e33]"
                  : "hidden"
        }
      />
      <Show when={closing()}>
        <View
          class="absolute left-0 top-0 h-[3] bg-[#f7768e]"
          ref={(node) => {
            themed("dangerFill")(node);
            // The fill follows the hold: 0..1 of the tile width.
            createEffect(() => {
              const c = closing();
              jump(node, "width", Math.round((c ? c.progress : 0) * s.cur.w));
            });
          }}
        />
      </Show>
    </View>
  );
}

function Stage(p: { store: RemoteStore }) {
  const empty = () => {
    const s = p.store.state();
    return !!s && !s.win.some((w) => w.ws === s.active);
  };
  return (
    <View
      class="absolute left-[40] top-[32] w-[400] h-[228] bg-[#1a1b26] overflow-hidden"
      ref={themed("surface")}
    >
      <Show when={empty()}>
        <View class="absolute left-0 top-[100] w-[400] h-[28] items-center justify-center">
          <Text class="text-sm text-[#565f89]" ref={themed("textDim")}>
            empty workspace · swipe for the next
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

// ---------------------------------------------------------------------------
// dock
// ---------------------------------------------------------------------------

function Dock(p: { store: RemoteStore }) {
  const focusLabel = () => {
    const c = p.store.focusClass();
    return c ? c : "";
  };
  return (
    <View class="absolute left-[40] top-[260] w-[400] h-[60] bg-[#13141c]" ref={themed("surfaceDark")}>
      <Index each={DOCK_ITEMS}>
        {(item, i) => (
          <View
            class="absolute top-[6] w-[44] h-[50] items-center"
            style={{ insetL: dockSlotX(i) - DOCK.x }}
          >
            <View class="absolute left-[10] top-[4] w-[24] h-[24]">
              <Icon name={item().icon} tone="fg" />
            </View>
            <Text class="absolute top-[32] text-xs text-[#565f89]" ref={themed("textDim")}>
              {item().label}
            </Text>
            <View
              class={
                p.store.pressed() === `dock:${i}`
                  ? "absolute left-[2] top-0 w-[40] h-[50] rounded-[8] bg-[#ffffff22]"
                  : item().id === "keyboard" && p.store.kb()
                    ? "absolute left-[2] top-0 w-[40] h-[50] rounded-[8] bg-[#7aa2f733]"
                    : "hidden"
              }
            />
          </View>
        )}
      </Index>
      {/* more */}
      <View class="absolute top-[6] w-[44] h-[50] items-center" style={{ insetL: dockSlotX(DOCK_MORE) - DOCK.x }}>
        <View class="absolute left-[10] top-[4] w-[24] h-[24]">
          <Icon name="more" tone="fg" />
        </View>
        <Text class="absolute top-[32] text-xs text-[#565f89]" ref={themed("textDim")}>
          more
        </Text>
        <View
          class={
            p.store.pressed() === `dock:${DOCK_MORE}` || p.store.pad() !== null
              ? "absolute left-[2] top-0 w-[40] h-[50] rounded-[8] bg-[#ffffff22]"
              : "hidden"
          }
        />
      </View>
      <Show when={p.store.toast() !== ""}>
        <View class="absolute left-[100] top-[-14] w-[200] h-[22] rounded-[11] bg-[#7aa2f7] items-center justify-center" ref={themed("accentFill")}>
          <Text class="text-xs font-bold text-[#13141c]" ref={themed("textOnAccent")}>
            {p.store.toast()}
          </Text>
        </View>
      </Show>
      <Show when={p.store.toast() === "" && focusLabel() !== ""}>
        <View class="absolute left-[100] top-[-14] w-[200] h-[22] items-center justify-center">
          <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
            {focusLabel()}
          </Text>
        </View>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// gesture routing
// ---------------------------------------------------------------------------

type Target =
  | { kind: "rail"; rail: "vol" | "bri" }
  | { kind: "cap"; rail: "vol" | "bri" }
  | { kind: "tab"; id: number }
  | { kind: "badge" }
  | { kind: "media"; op: "prev" | "play" | "next" }
  | { kind: "tile"; a: string }
  | { kind: "stage" }
  | { kind: "dock"; slot: number }
  | { kind: "none" };

function targetAt(store: RemoteStore, x: number, y: number): Target {
  if (within(x, y, RAIL_LEFT)) return y < RAIL_CAP_H ? { kind: "cap", rail: "bri" } : { kind: "rail", rail: "bri" };
  if (within(x, y, RAIL_RIGHT)) return y < RAIL_CAP_H ? { kind: "cap", rail: "vol" } : { kind: "rail", rail: "vol" };
  if (within(x, y, STRIP)) {
    if (x >= MEDIA_X) {
      const i = Math.min(2, Math.floor((x - MEDIA_X) / MEDIA_W));
      return { kind: "media", op: (["prev", "play", "next"] as const)[i]! };
    }
    if (x >= BADGE_X && x < BADGE_X + BADGE_W) return { kind: "badge" };
    const tab = tabAt(x, store.tabs());
    return tab ? { kind: "tab", id: tab.id } : { kind: "none" };
  }
  if (within(x, y, STAGE)) {
    const a = store.windowAt(x, y);
    return a ? { kind: "tile", a } : { kind: "stage" };
  }
  if (within(x, y, DOCK)) {
    const slot = dockSlotAt(x);
    return slot === null ? { kind: "none" } : { kind: "dock", slot };
  }
  return { kind: "none" };
}

function pressId(t: Target): string | null {
  switch (t.kind) {
    case "rail":
      return `rail:${t.rail}`;
    case "cap":
      return `cap:${t.rail}`;
    case "tab":
      return `tab:${t.id}`;
    case "badge":
      return "badge";
    case "media":
      return `media:${t.op}`;
    case "tile":
      return `tile:${t.a}`;
    case "dock":
      return `dock:${t.slot}`;
    default:
      return null;
  }
}

/** The desk's touch handlers; app.tsx routes contacts here when no sheet is
 *  open. `active` gates every callback so a contact that began before a
 *  sheet opened cannot act after it. */
export function deskHandlers(store: RemoteStore, active: () => boolean): GestureHandlers {
  let down: Target = { kind: "none" };
  let swiping = false;

  // onUp arrives before onTap for one release, and onTap reads `down`, so a
  // reset leaves the down target alone; the next onDown overwrites it.
  const reset = () => {
    store.pressRelease();
    store.setDrag(null);
    store.setClosing(null);
    store.setRailDrag(null);
    swiping = false;
  };

  const tapDock = (slot: number) => {
    if (slot === DOCK_MORE) {
      store.setPad(store.pad() === null ? 0 : null);
      return;
    }
    if (slot === DOCK_KEYBOARD) {
      store.setKb(!store.kb());
      return;
    }
    const id = DOCK_ACTIONS[slot];
    if (id) store.act(id as ActionId);
  };

  return {
    onDown: (c) => {
      if (!active()) return;
      down = targetAt(store, c.x, c.y);
      store.pressDown(pressId(down));
      if (down.kind === "rail") {
        store.setRailDrag({ rail: down.rail, start: down.rail === "vol" ? store.vol() : store.bri() });
      }
    },
    onTap: (c) => {
      if (!active()) return;
      const t = down;
      store.pressRelease();
      store.setRailDrag(null);
      switch (t.kind) {
        case "cap":
          if (t.rail === "vol") store.toggleMute();
          else store.act("nightlight");
          break;
        case "tab":
          store.workspace(t.id);
          break;
        case "badge":
          store.act("layout");
          break;
        case "media":
          store.media(t.op);
          store.say(t.op === "play" ? "play / pause" : t.op === "next" ? "next track" : "previous track");
          break;
        case "tile":
          store.focusWindow(t.a);
          break;
        case "dock":
          tapDock(t.slot);
          break;
        case "rail": {
          // A tap on the track nudges by a step, the keyboard's own increment.
          const step = c.y < (RAIL_TRACK_TOP + RAIL_TRACK_BOTTOM) / 2 ? 0.05 : -0.05;
          store.setLevel(t.rail, (t.rail === "vol" ? store.vol() : store.bri()) + step, true);
          break;
        }
        default:
          break;
      }
      down = { kind: "none" };
    },
    onLongPress: () => {
      if (!active()) return;
      const t = down;
      if (t.kind === "tile") {
        store.pressDown(null);
        store.setClosing({ a: t.a, progress: 0 });
      } else if (t.kind === "tab") {
        // Hold a tab: bring the focused window here and follow it.
        const focus = store.state()?.focus;
        store.pressDown(null);
        if (focus) {
          store.moveWindow(focus, t.id);
          store.workspace(t.id);
        }
        down = { kind: "none" };
      }
    },
    onPanStart: (c) => {
      if (!active()) return;
      const t = down;
      if (t.kind === "rail") return; // stays pressed; the rail follows below
      store.pressDown(null);
      if (t.kind === "tile" && !store.closing()) {
        store.setDrag({ a: t.a, x: c.x, y: c.y, over: null, overWs: null });
      } else if (t.kind === "stage" || t.kind === "tile") {
        swiping = true;
      }
    },
    onPanMove: (c) => {
      if (!active()) return;
      const rail = store.railDrag();
      if (rail) {
        store.setLevel(rail.rail, rail.start + railDelta(c.dy));
        return;
      }
      const drag = store.drag();
      if (drag) {
        const overA = within(c.x, c.y, STAGE) ? store.windowAt(c.x, c.y) : null;
        const tab = within(c.x, c.y, STRIP) ? tabAt(c.x, store.tabs()) : null;
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
      if (!active()) {
        reset();
        return;
      }
      const rail = store.railDrag();
      if (rail) {
        store.setLevel(rail.rail, rail.start + railDelta(c.dy), true);
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
    onCancel: () => reset(),
  };
}

// ---------------------------------------------------------------------------
// desk
// ---------------------------------------------------------------------------

export function Desk(p: { store: RemoteStore }) {
  return (
    <>
      <Rail store={p.store} side="left" />
      <Rail store={p.store} side="right" />
      <Strip store={p.store} />
      <Stage store={p.store} />
      <Dock store={p.store} />
    </>
  );
}
