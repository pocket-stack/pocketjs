// apps/pocket-shell/stage.tsx — the top screen: wallpaper, tiled windows,
// the bar, and the key sheet. Window geometry comes from the store's
// animated rects; the applet inside sizes from the settled placement so text
// does not reflow every frame of a transition.

import { For, Index, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { keySheet, LAYER_TITLE } from "./chords.ts";
import { formatClock } from "./shell.ts";
import { Applet, type SheetLine } from "./applets.tsx";
import type { ShellStore } from "./store.ts";
import { BAR_H, BORDER } from "./wm.ts";

const HEADER_H = 14;

/** The three cooked wallpapers. Only the current one is mounted. */
function Wallpaper(props: { store: ShellStore }) {
  return (
    <>
      <Show when={props.store.wallpaper() === "road"}>
        <Image debugName="WallRoad" class="absolute left-0 top-0 w-[512] h-[256]" src="wall/road.png" />
      </Show>
      <Show when={props.store.wallpaper() === "lake"}>
        <Image debugName="WallLake" class="absolute left-0 top-0 w-[512] h-[256]" src="wall/lake.png" />
      </Show>
      <Show when={props.store.wallpaper() === "swirl"}>
        <Image debugName="WallSwirl" class="absolute left-0 top-0 w-[512] h-[256]" src="wall/swirl.png" />
      </Show>
    </>
  );
}

function Win(props: { id: number; store: ShellStore }) {
  const store = props.store;
  const win = () => store.windowOf(props.id);
  const focused = () => store.focusedId() === props.id;
  const geometry = () => {
    const a = store.animOf(props.id);
    return { insetL: a.cur.x, insetT: a.cur.y, width: a.cur.w, height: a.cur.h, opacity: a.alpha };
  };
  const contentW = () => Math.max(0, (store.placementOf(props.id)?.rect.w ?? 0) - 2 * BORDER);
  const contentH = () => Math.max(0, (store.placementOf(props.id)?.rect.h ?? 0) - 2 * BORDER - HEADER_H);
  return (
    <View debugName="Win" class="absolute overflow-hidden" style={geometry()}>
      <View
        class={
          focused()
            ? "absolute inset-0 bg-gradient-to-r from-[#33ccff] to-[#00ff99]"
            : "absolute inset-0 bg-[#595959aa]"
        }
      />
      <View class="absolute inset-[2] bg-[#1a1b26] overflow-hidden">
        <View class={focused() ? "absolute left-0 right-0 top-0 h-[14] bg-[#24283b]" : "absolute left-0 right-0 top-0 h-[14] bg-[#16161e]"}>
          <Text class={focused() ? "absolute left-[6] top-0 text-xs text-[#c0caf5]" : "absolute left-[6] top-0 text-xs text-[#565f89]"}>
            {win()?.title ?? ""}
          </Text>
          <Text class="absolute right-[6] top-0 text-xs text-[#414868]">{`#${props.id}`}</Text>
        </View>
        <View class="absolute left-0 right-0 top-[14] bottom-0 overflow-hidden">
          <Show when={win()}>
            {(w) => <Applet id={props.id} app={w().app} store={store} w={contentW} h={contentH} />}
          </Show>
        </View>
      </View>
    </View>
  );
}

function Bar(props: { store: ShellStore }) {
  const store = props.store;
  const title = () => {
    const id = store.focusedId();
    return id === null ? "" : store.windowOf(id)?.title ?? "";
  };
  return (
    <View debugName="Bar" class="absolute left-0 right-0 top-0 h-[14] bg-[#1a1b26e6]">
      <Index each={store.counts()}>
        {(count, i) => (
          <Text
            class={
              store.active() === i + 1
                ? "absolute top-0 text-xs text-[#7aa2f7] font-bold"
                : count() > 0
                  ? "absolute top-0 text-xs text-[#a9b1d6]"
                  : "absolute top-0 text-xs text-[#414868]"
            }
            style={{ insetL: 6 + i * 12 }}
          >
            {String(i + 1)}
          </Text>
        )}
      </Index>
      <Text class="absolute left-[72] top-0 text-xs text-[#a9b1d6]">{title()}</Text>
      <Text class="absolute left-0 right-0 top-0 text-center text-xs text-[#c0caf5] font-bold">
        {formatClock(store.now())}
      </Text>
      <Show when={store.layer() !== "plain"}>
        <Text class="absolute right-[64] top-0 text-xs text-[#7dcfff] font-bold">{LAYER_TITLE[store.layer()]}</Text>
      </Show>
      <Text class="absolute right-[6] top-0 text-xs text-[#565f89]">{store.layoutKind()}</Text>
    </View>
  );
}

/** SUPER+K: the whole chord table over the stage. Four groups in two
 *  columns — L and "always" on the left, R and L+R on the right — with every
 *  cell clipped to its column so a long label cannot run into its neighbour
 *  or off the panel. */
const SHEET_COL_W = 184;
const SHEET_KEYS_W = 80;
const SHEET_ROW_H = 12;

function SheetColumn(props: { store: ShellStore; x: number; groups: number[] }) {
  const lines = () => {
    const all = keySheet(props.store.layoutKind());
    const out: SheetLine[] = [];
    for (const index of props.groups) {
      const group = all[index];
      out.push({ kind: "title", keys: group.title, what: "" });
      for (const row of group.rows) out.push({ kind: "row", keys: row.keys, what: row.what });
      out.push({ kind: "gap", keys: "", what: "" });
    }
    return out;
  };
  return (
    <Index each={lines()}>
      {(line, i) => (
        <View
          class="absolute h-[12] overflow-hidden"
          style={{ insetL: props.x, insetT: 26 + i * SHEET_ROW_H, width: SHEET_COL_W }}
        >
          <Show when={line().kind === "title"}>
            <Text class="absolute left-0 top-0 text-xs text-[#7aa2f7] font-bold">{line().keys}</Text>
          </Show>
          <Show when={line().kind === "row"}>
            <View class="absolute left-0 top-0 h-[12] overflow-hidden" style={{ width: SHEET_KEYS_W }}>
              <Text class="absolute left-0 top-0 text-xs text-[#c0caf5] font-bold">{line().keys}</Text>
            </View>
            <View
              class="absolute top-0 h-[12] overflow-hidden"
              style={{ insetL: SHEET_KEYS_W, width: SHEET_COL_W - SHEET_KEYS_W }}
            >
              <Text class="absolute left-0 top-0 text-xs text-[#a9b1d6]">{line().what}</Text>
            </View>
          </Show>
        </View>
      )}
    </Index>
  );
}

function KeySheet(props: { store: ShellStore }) {
  return (
    <View debugName="KeySheet" class="absolute inset-[8] bg-[#16161ef2] border border-[#414868]">
      <Text class="absolute left-[10] top-[5] text-sm text-[#c0caf5] font-bold">keys</Text>
      <Text class="absolute left-[52] top-[7] text-xs text-[#565f89]">every chord · B closes</Text>
      {/* keySheet() returns L, R, L+R, always — pair the long groups with the short. */}
      <SheetColumn store={props.store} x={10} groups={[0, 3]} />
      <SheetColumn store={props.store} x={196} groups={[1, 2]} />
    </View>
  );
}

export function Stage(props: { store: ShellStore }) {
  const store = props.store;
  return (
    <View debugName="Stage" class="relative w-full h-full bg-[#1a1b26] overflow-hidden">
      <Wallpaper store={store} />
      <View debugName="Windows" class="absolute inset-0">
        <For each={store.order()}>{(id) => <Win id={id} store={store} />}</For>
        <For each={store.ghostList()}>
          {(ghost) => (
            <View
              class="absolute border border-[#595959]"
              style={{
                insetL: ghost.rect.x,
                insetT: ghost.rect.y,
                width: ghost.rect.w,
                height: ghost.rect.h,
                opacity: ghost.alpha,
              }}
            />
          )}
        </For>
      </View>
      <Show when={store.order().length === 0}>
        <View debugName="EmptyHint" class="absolute left-0 right-0 top-[104] items-center">
          <View class="px-[10] py-[3] rounded-[4] bg-[#1a1b26b3]">
            <Text class="text-xs text-[#a9b1d6]">{`workspace ${store.active()} is empty · hold L and press A, or tap the dock`}</Text>
          </View>
        </View>
      </Show>
      <Show when={store.barVisible()}>
        <Bar store={store} />
      </Show>
      <Show when={store.keysOpen()}>
        <KeySheet store={store} />
      </Show>
    </View>
  );
}

export { BAR_H };
