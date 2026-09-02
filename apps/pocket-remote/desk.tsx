// apps/pocket-remote/desk.tsx — the main screen: the workspace strip, the
// live stage, the dock, the levels card and the Menu key's cascade, plus the
// desk's touch handlers (app.tsx routes contacts here). Every painted target
// answers a press with a tint overlay (a capacitive panel has no hover), the
// levels follow the finger relatively (touching a slider never jumps the
// level to the finger), and the only destructive act — closing a window —
// is a hold with a visible fill, never a tap.
//
// Hold-and-slide is the desk's second verb: hold Menu and a column of routes
// rises; slide onto one and its leaves fan out beside it; release on a leaf
// to run it, on a route to open it on the desktop, elsewhere to cancel. Hold
// Levels and the card opens under the finger; slide across a slider to set
// it; release and the card lingers, then puts itself away.

import { createEffect, Index, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type { GestureContact } from "@pocketjs/framework/gesture";
import { jump } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { type ActionId, actionById, DOCK as DOCK_ACTIONS, MENU_ROUTES } from "./actions.ts";
import { Icon, type IconName } from "./icons.tsx";
import {
  BADGE_W,
  BADGE_X,
  CARD,
  CARD_ICON_W,
  CARD_ICON_X,
  CARD_ROW_H,
  CARD_ROW_Y,
  CARD_TRACK_H,
  CARD_TRACK_W,
  CARD_TRACK_X,
  cardHit,
  cardRowAt,
  clamp01,
  DOCK,
  dockSlotAt,
  dockSlotX,
  FLY_GAP,
  FLY_ITEM_H,
  FLY_W,
  FLY_X,
  FLY2_W,
  FLY2_X,
  flyItemAt,
  flyItemY,
  MEDIA_W,
  MEDIA_X,
  STAGE,
  stagger,
  STRIP,
  SWIPE_PX,
  tabAt,
  trackDelta,
  trackFill,
  within,
} from "./layout.ts";
import type { RemoteStore, TileSlot } from "./store.ts";
import { themed } from "./theme.ts";

/** The subset of gesture callbacks a sheet or the desk implements. */
export type GestureHandlers = {
  [K in "onDown" | "onMove" | "onTap" | "onLongPress" | "onPanStart" | "onPanMove" | "onUp" | "onCancel"]?: (c: GestureContact) => void;
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

/** Dock captions: a 43 px slot fits about five characters at 12 px, so the
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

/** Slots 0..7 are actions; 8 the levels card, 9 the keyboard, 10 the pad. */
const DOCK_LEVELS = 8;
const DOCK_KEYBOARD = 9;
const DOCK_MORE = 10;
const DOCK_ITEMS: readonly { id: string; label: string; icon: IconName }[] = [
  ...DOCK_ACTIONS.map((id) => ({ id, label: DOCK_LABELS[id] ?? actionById(id)!.label, icon: DOCK_ICONS[id]! })),
  { id: "levels", label: "Levels", icon: "levels" },
  { id: "keyboard", label: "Type", icon: "keyboard" },
  { id: "more", label: "more", icon: "more" },
];

// ---------------------------------------------------------------------------
// strip
// ---------------------------------------------------------------------------

function Strip(p: { store: RemoteStore }) {
  const tabs = () => p.store.tabs();
  const active = () => p.store.state()?.active ?? -1;
  const layoutLabel = () => (p.store.layout() === "scrolling" ? "scrolling" : "dwindle");
  return (
    <View class="absolute left-0 top-0 w-[480] h-[28] bg-[#13141c]" ref={themed("surfaceDark")}>
      <Index each={tabs()}>
        {(tab) => (
          <View class="absolute top-[2] w-[28] h-[24] items-center justify-center" style={{ insetL: tab().x - STRIP.x }}>
            <View
              class={
                tab().id === active()
                  ? "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#7aa2f7]"
                  : tab().n > 0
                    ? "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#414868]"
                    : "absolute left-[2] top-0 w-[24] h-[24] rounded-[6] bg-[#1a1b26]"
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
        class="absolute top-[4] w-[60] h-[20] rounded-[6] bg-[#1a1b26] items-center justify-center"
        style={{ insetL: BADGE_X - STRIP.x }}
        ref={themed("surface")}
      >
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {layoutLabel()}
        </Text>
        <View class={p.store.pressed() === "badge" ? "absolute left-0 top-0 w-[60] h-[20] rounded-[6] bg-[#ffffff22]" : "hidden"} />
      </View>
      {/* media transport */}
      <Index each={["prev", "play", "next"] as const}>
        {(op, i) => (
          <View class="absolute top-[2] w-[30] h-[24]" style={{ insetL: MEDIA_X - STRIP.x + i * MEDIA_W }}>
            <View class="absolute left-[3] top-0 w-[24] h-[24]">
              <Icon name={op()} tone="fg" />
            </View>
            <View
              class={
                p.store.pressed() === `media:${op()}` ? "absolute left-0 top-0 w-[30] h-[24] rounded-[6] bg-[#ffffff22]" : "hidden"
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
    <View class="absolute left-0 top-[28] w-[480] h-[240] bg-[#1a1b26] overflow-hidden" ref={themed("surface")}>
      <Show when={empty()}>
        <View class="absolute left-0 top-[106] w-[480] h-[28] items-center justify-center">
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
  const lit = (id: string) =>
    (id === "levels" && p.store.card() !== null) ||
    (id === "more" && p.store.pad() !== null) ||
    (id === "menu" && p.store.flyout()?.kind === "menu");
  return (
    <View class="absolute left-0 top-[268] w-[480] h-[52] bg-[#13141c]" ref={themed("surfaceDark")}>
      <Index each={DOCK_ITEMS}>
        {(item, i) => (
          <View class="absolute top-[2] w-[43] h-[48] items-center" style={{ insetL: dockSlotX(i) - DOCK.x }}>
            <View class="absolute left-[10] top-[3] w-[24] h-[24]">
              <Icon name={item().icon} tone="fg" />
            </View>
            <Text class="absolute top-[30] text-xs text-[#565f89]" ref={themed("textDim")}>
              {item().label}
            </Text>
            <View
              class={
                p.store.pressed() === `dock:${i}`
                  ? "absolute left-[1] top-0 w-[41] h-[48] rounded-[8] bg-[#ffffff22]"
                  : lit(item().id)
                    ? "absolute left-[1] top-0 w-[41] h-[48] rounded-[8] bg-[#7aa2f733]"
                    : "hidden"
              }
            />
          </View>
        )}
      </Index>
    </View>
  );
}

/** The last action's name, briefly, over the top of the stage. */
function Toast(p: { store: RemoteStore }) {
  return (
    <Show when={p.store.toast() !== ""}>
      <View class="absolute left-[140] top-[36] w-[200] h-[24] rounded-[12] bg-[#7aa2f7] items-center justify-center" ref={themed("accentFill")}>
        <Text class="text-xs font-bold text-[#13141c]" ref={themed("textOnAccent")}>
          {p.store.toast()}
        </Text>
      </View>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// levels card
// ---------------------------------------------------------------------------

function LevelRow(p: { store: RemoteStore; row: 0 | 1 }) {
  const level = () => (p.row === 0 ? p.store.bri() : p.store.vol());
  const hot = () => p.store.card()?.row === p.row;
  let fill: NodeMirror | null = null;
  createEffect(() => {
    if (fill) jump(fill, "width", trackFill(level()));
  });
  return (
    <View class="absolute left-0 w-[280] h-[44]" style={{ insetT: CARD_ROW_Y[p.row] }}>
      {/* toggle: nightlight / mute */}
      <View
        class={
          hot()
            ? "absolute top-[4] w-[36] h-[36] rounded-[10] bg-[#7aa2f733]"
            : "absolute top-[4] w-[36] h-[36] rounded-[10] bg-[#1a1b26]"
        }
        style={{ insetL: CARD_ICON_X }}
        ref={themed(() => (hot() ? "accentTint" : "surface"))}
      >
        <View class="absolute left-[6] top-[6] w-[24] h-[24]">
          <Show when={p.row === 0}>
            <Icon name="sun" tone="fg" />
          </Show>
          <Show when={p.row === 1}>
            <Show when={!p.store.mute()} fallback={<Icon name="mute" tone="dim" />}>
              <Icon name="speaker" tone="fg" />
            </Show>
          </Show>
        </View>
        <View class={p.store.pressed() === `cardicon:${p.row}` ? "absolute left-0 top-0 w-[36] h-[36] rounded-[10] bg-[#ffffff22]" : "hidden"} />
      </View>
      {/* track */}
      <View
        class="absolute top-[16] w-[172] h-[12] rounded-[6] bg-[#414868] overflow-hidden"
        style={{ insetL: CARD_TRACK_X }}
        ref={themed("surfaceMuted")}
      >
        <View
          class="absolute left-0 top-0 w-0 h-[12] rounded-[6] bg-[#7aa2f7]"
          ref={(node) => {
            fill = node;
            themed("accentFill")(node);
            jump(node, "width", trackFill(level()));
          }}
        />
      </View>
      <View class="absolute top-[14] w-[36] h-[16] items-center justify-center" style={{ insetL: CARD_TRACK_X + CARD_TRACK_W + 4 }}>
        <Text class={hot() ? "text-xs font-bold text-[#7aa2f7]" : "text-xs text-[#565f89]"} ref={themed(() => (hot() ? "textAccent" : "textDim"))}>
          {`${Math.round(level() * 100)}`}
        </Text>
      </View>
    </View>
  );
}

function LevelsCard(p: { store: RemoteStore }) {
  let root: NodeMirror | null = null;
  // Entrance: rise 12 px and fade in, driven by the store's progress.
  createEffect(() => {
    if (!root) return;
    const t = p.store.cardT();
    jump(root, "translateY", Math.round((1 - t) * 12));
    jump(root, "opacity", t);
  });
  return (
    <View
      class="absolute rounded-[14] bg-[#13141c] border border-[#414868] overflow-hidden"
      style={{ insetL: CARD.x, insetT: CARD.y, width: CARD.w, height: CARD.h }}
      ref={(node) => {
        root = node;
        themed("surfaceDark")(node);
      }}
    >
      <LevelRow store={p.store} row={0} />
      <LevelRow store={p.store} row={1} />
      <View class="absolute left-[12] top-[118] w-[256] h-[10] items-center justify-center">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {p.store.card()?.mode === "hold" ? "slide · release to close" : "tap outside to close"}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// menu cascade
// ---------------------------------------------------------------------------

function FlyItem(p: {
  store: RemoteStore;
  x: number;
  w: number;
  i: number;
  count: number;
  label: string;
  hot: boolean;
  progress: () => number;
}) {
  let root: NodeMirror | null = null;
  createEffect(() => {
    if (!root) return;
    const t = stagger(p.progress(), p.i, p.count);
    jump(root, "translateY", Math.round((1 - t) * 18));
    jump(root, "opacity", t);
  });
  return (
    <View
      class={
        p.hot
          ? "absolute rounded-[9] bg-[#7aa2f7] items-center justify-center"
          : "absolute rounded-[9] bg-[#414868] items-center justify-center"
      }
      style={{ insetL: p.x, insetT: flyItemY(p.i), width: p.w, height: FLY_ITEM_H }}
      ref={(node) => {
        root = node;
        themed(() => (p.hot ? "accentFill" : "surfaceMuted"))(node);
      }}
    >
      <Text
        class={p.hot ? "text-sm font-bold text-[#13141c]" : "text-sm text-[#a9b1d6]"}
        ref={themed(() => (p.hot ? "textOnAccent" : "text"))}
      >
        {p.label}
      </Text>
    </View>
  );
}

function MenuCascade(p: { store: RemoteStore }) {
  const fly = () => {
    const f = p.store.flyout();
    return f && f.kind === "menu" ? f : null;
  };
  const leaves = () => {
    const f = fly();
    if (!f || f.open === null) return [];
    return MENU_ROUTES[f.open]?.leaves.slice(0, 6) ?? [];
  };
  let veil: NodeMirror | null = null;
  createEffect(() => {
    if (veil) jump(veil, "opacity", p.store.flyT() * 0.85);
  });
  return (
    <>
      {/* a veil over the stage: the cascade is the only thing to look at */}
      <View
        class="absolute left-0 top-[28] w-[480] h-[240] bg-[#13141c]"
        ref={(node) => {
          veil = node;
          themed("surfaceDark")(node);
        }}
      />
      <View class="absolute left-0 top-[34] w-[480] h-[18] items-center justify-center">
        <Text class="text-xs text-[#565f89]" ref={themed("textDim")}>
          {fly()?.hot !== null ? "release: open on the desktop · slide right for shortcuts" : "slide to a route"}
        </Text>
      </View>
      <Index each={MENU_ROUTES}>
        {(route, i) => (
          <FlyItem
            store={p.store}
            x={FLY_X}
            w={FLY_W}
            i={i}
            count={MENU_ROUTES.length}
            label={route().label}
            hot={fly()?.hot === i || (fly()?.hot === null && fly()?.open === i)}
            progress={p.store.flyT}
          />
        )}
      </Index>
      <Index each={leaves()}>
        {(id, i) => (
          <FlyItem
            store={p.store}
            x={FLY2_X}
            w={FLY2_W}
            i={i}
            count={leaves().length}
            label={actionById(id())?.label ?? id()}
            hot={fly()?.leaf === i}
            progress={p.store.flyT2}
          />
        )}
      </Index>
    </>
  );
}

// ---------------------------------------------------------------------------
// gesture routing
// ---------------------------------------------------------------------------

type Target =
  | { kind: "tab"; id: number }
  | { kind: "badge" }
  | { kind: "media"; op: "prev" | "play" | "next" }
  | { kind: "tile"; a: string }
  | { kind: "stage" }
  | { kind: "dock"; slot: number }
  | { kind: "cardIcon"; row: 0 | 1 }
  | { kind: "cardTrack"; row: 0 | 1 }
  | { kind: "card" }
  | { kind: "none" };

function targetAt(store: RemoteStore, x: number, y: number): Target {
  if (store.card()) {
    const hit = cardHit(x, y);
    if (hit) {
      if (hit.kind === "icon") return { kind: "cardIcon", row: hit.row };
      if (hit.kind === "track") return { kind: "cardTrack", row: hit.row };
      return { kind: "card" };
    }
  }
  if (within(x, y, STRIP)) {
    if (x >= MEDIA_X) {
      const i = Math.min(2, Math.floor((x - MEDIA_X) / MEDIA_W));
      return { kind: "media", op: (["prev", "play", "next"] as const)[i]! };
    }
    if (x >= BADGE_X && x < BADGE_X + BADGE_W) return { kind: "badge" };
    const tab = tabAt(x, store.tabs());
    return tab ? { kind: "tab", id: tab.id } : { kind: "none" };
  }
  if (within(x, y, DOCK)) {
    const slot = dockSlotAt(x);
    return slot === null ? { kind: "none" } : { kind: "dock", slot };
  }
  if (within(x, y, STAGE)) {
    const a = store.windowAt(x, y);
    return a ? { kind: "tile", a } : { kind: "stage" };
  }
  return { kind: "none" };
}

function pressId(t: Target): string | null {
  switch (t.kind) {
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
    case "cardIcon":
      return `cardicon:${t.row}`;
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
  /** The contact is inside a hold-and-slide (menu cascade or levels card). */
  let sliding: "menu" | "card" | null = null;

  // onUp arrives before onTap for one release, and onTap reads `down`, so a
  // reset leaves the down target alone; the next onDown overwrites it.
  const reset = () => {
    store.pressRelease();
    store.setDrag(null);
    store.setClosing(null);
    swiping = false;
    sliding = null;
  };

  const menuFollow = (x: number, y: number) => {
    const f = store.flyout();
    if (!f || f.kind !== "menu") return;
    const hot = flyItemAt(x, y, FLY_X, FLY_W, MENU_ROUTES.length);
    const open = hot ?? f.open;
    const leafCount = open === null ? 0 : Math.min(6, MENU_ROUTES[open]?.leaves.length ?? 0);
    const leaf = hot === null && open !== null ? flyItemAt(x, y, FLY2_X, FLY2_W, leafCount) : null;
    store.menuHover(hot, leaf);
  };

  /** A finger sliding across the card: the row under it is adjusted
   *  relatively from where the finger entered the row. */
  const cardFollow = (x: number, y: number) => {
    const c = store.card();
    if (!c) return;
    const row = cardRowAt(y);
    if (c.row !== row) {
      store.setCard({ ...c, row, refX: x, refLevel: row === 0 ? store.bri() : store.vol() });
      return;
    }
    const level = clamp01(c.refLevel + trackDelta(x - c.refX));
    store.setLevel(row === 0 ? "bri" : "vol", level);
  };

  const tapDock = (slot: number) => {
    if (slot === DOCK_MORE) {
      store.closeCard();
      store.setPad(store.pad() === null ? 0 : null);
      return;
    }
    if (slot === DOCK_KEYBOARD) {
      store.closeCard();
      store.setKb(true);
      return;
    }
    if (slot === DOCK_LEVELS) {
      if (store.card()) store.closeCard();
      else store.openCard("sticky");
      return;
    }
    const id = DOCK_ACTIONS[slot];
    if (id) store.act(id as ActionId);
  };

  return {
    onDown: (c) => {
      if (!active()) return;
      down = targetAt(store, c.x, c.y);
      sliding = null;
      store.pressDown(pressId(down));
      // A sticky card closes on any touch outside it.
      const card = store.card();
      if (card && card.mode === "sticky" && down.kind !== "cardIcon" && down.kind !== "cardTrack" && down.kind !== "card") {
        if (!(down.kind === "dock" && down.slot === DOCK_LEVELS)) store.closeCard();
      }
      if (down.kind === "cardTrack") {
        store.setCard({ ...store.card()!, row: down.row, refX: c.x, refLevel: down.row === 0 ? store.bri() : store.vol() });
      }
    },
    onMove: (c) => {
      if (!active()) return;
      if (sliding === "menu") menuFollow(c.x, c.y);
      else if (sliding === "card") cardFollow(c.x, c.y);
    },
    onTap: (c) => {
      if (!active()) return;
      const t = down;
      store.pressRelease();
      switch (t.kind) {
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
        case "cardIcon":
          if (t.row === 1) store.toggleMute();
          else store.act("nightlight");
          break;
        case "cardTrack": {
          // A tap on the track nudges by the keyboard's own step.
          const card = store.card();
          const level = t.row === 0 ? store.bri() : store.vol();
          const trackX = CARD.x + CARD_TRACK_X + trackFill(level);
          store.setLevel(t.row === 0 ? "bri" : "vol", level + (c.x > trackX ? 0.05 : -0.05), true);
          if (card) store.setCard({ ...card, row: null });
          break;
        }
        default:
          break;
      }
      down = { kind: "none" };
    },
    onLongPress: (c) => {
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
      } else if (t.kind === "dock" && DOCK_ACTIONS[t.slot] === "menu") {
        store.pressDown(null);
        store.closeCard();
        store.openFlyout({ kind: "menu", hot: null, leaf: null, open: null });
        sliding = "menu";
      } else if (t.kind === "dock" && t.slot === DOCK_LEVELS) {
        store.pressDown(null);
        store.openCard("hold", cardRowAt(c.y), c.x);
        sliding = "card";
      }
    },
    onPanStart: (c) => {
      if (!active()) return;
      const t = down;
      if (sliding) return;
      if (t.kind === "cardTrack") return; // the drag follows in onPanMove
      store.pressDown(null);
      if (t.kind === "tile" && !store.closing()) {
        store.setDrag({ a: t.a, x: c.x, y: c.y, over: null, overWs: null });
      } else if (t.kind === "stage" || t.kind === "tile") {
        swiping = true;
      }
    },
    onPanMove: (c) => {
      if (!active()) return;
      if (sliding) return; // onMove owns the slide
      if (down.kind === "cardTrack") {
        const card = store.card();
        if (card && card.row !== null) {
          store.setLevel(card.row === 0 ? "bri" : "vol", clamp01(card.refLevel + trackDelta(c.x - card.refX)));
        }
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
      if (sliding === "menu") {
        menuFollow(c.x, c.y);
        store.menuRelease();
        reset();
        return;
      }
      if (sliding === "card") {
        const card = store.card();
        if (card && card.row !== null) store.setLevel(card.row === 0 ? "bri" : "vol", card.row === 0 ? store.bri() : store.vol(), true);
        store.cardReleased();
        reset();
        return;
      }
      if (down.kind === "cardTrack") {
        const card = store.card();
        if (card && card.row !== null) {
          store.setLevel(card.row === 0 ? "bri" : "vol", card.row === 0 ? store.bri() : store.vol(), true);
          store.setCard({ ...card, row: null });
        }
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
      if (sliding === "menu") store.closeFlyout();
      if (sliding === "card") store.cardReleased();
      reset();
    },
  };
}

// ---------------------------------------------------------------------------
// desk
// ---------------------------------------------------------------------------

export function Desk(p: { store: RemoteStore }) {
  return (
    <>
      <Strip store={p.store} />
      <Stage store={p.store} />
      <Dock store={p.store} />
      <Show when={p.store.card()}>
        <LevelsCard store={p.store} />
      </Show>
      <Show when={p.store.flyout()?.kind === "menu"}>
        <MenuCascade store={p.store} />
      </Show>
      <Toast store={p.store} />
    </>
  );
}

export { CARD_ICON_W, CARD_ROW_H, CARD_TRACK_H, FLY_GAP };
