// demos/youtube/app.tsx — "Pocket YouTube": watch YouTube on a PSP over USB.
//
// No WiFi anywhere in this design: a companion Mac service (host/serve.ts)
// owns the network and the pixels, and everything reaches the device
// through the PSPLINK usbhostfs share — search results as host-rendered
// full-width row images (CJK titles included; the PSP atlas never could),
// the video itself as a CLUT8+PCM ring stream on the native video plane.
//
// Text entry rides the SYSTEM keyboard (@pocketjs/framework/osk): △ opens
// it, and while it is up every handler below is muted by the framework's
// modal block — no per-handler gating, no way to freeze the app behind an
// invisible keyboard. START/✓ commits the search.

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { createSpriteAnimation, onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import { animate } from "@pocketjs/framework/animation";
import { createOsk, Osk } from "@pocketjs/framework/osk";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { loadCard, pumpDriver } from "./driver.ts";
import Player from "./player.tsx";
import { createYoutubeStore, type YoutubeStore } from "./store.ts";
import type { ResultItem } from "./protocol.ts";

const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const RED = "#ff4757";
const BG = "#0b0f14";

/** Row pitch of the results column: 64px row + 4px gap. */
const ROW_STEP = 68;
/** Results viewport height (272 minus masthead/search/counter chrome) —
 *  the scroll clamp keeps the focused row fully inside it. */
const VIEW_H = 184;
/** Host-rendered row textures are 512 wide (pow2); this much is content. */
const CARD_VISIBLE_W = 456;

const SPINNER_FRAMES = [
  "spin-00.svg",
  "spin-01.svg",
  "spin-02.svg",
  "spin-03.svg",
  "spin-04.svg",
  "spin-05.svg",
  "spin-06.svg",
  "spin-07.svg",
];

/** The accent-red busy spinner (baked SVG frames, ~7.5 rev/s at step 3). */
function Spinner(props: { size?: number }) {
  const src = createSpriteAnimation(SPINNER_FRAMES, { frameStep: 3 });
  return <Image src={src()} style={{ width: props.size ?? 22, height: props.size ?? 22 }} />;
}

export default function App() {
  const store = createYoutubeStore();

  // The one per-frame pump: driver IO (svc poll + card loader) plus the
  // connect-phase retry. Registered at the root so it outlives screens.
  onFrame(() => {
    pumpDriver();
    store.connectTick();
  });

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: BG }}>
      <Show when={store.phase() === "player"} fallback={<Browse store={store} />}>
        <Player store={store} />
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Connect + browse
// ---------------------------------------------------------------------------

function Browse(props: { store: YoutubeStore }) {
  const osk = createOsk({
    value: props.store.query,
    setValue: props.store.setQuery,
    onCommit: () => props.store.search(),
  });

  // Rows the d-pad can reach: real results plus the LOAD MORE sentinel.
  const rowCount = () => props.store.results().length + (props.store.hasMore() ? 1 : 0);

  // While the OSK is open these are all muted by its modal block — the
  // keyboard owns every button until it closes.
  onButtonPress(BTN.TRIANGLE, () => osk.open());
  onButtonPress(BTN.START, () => props.store.search());
  onButtonPress(BTN.UP, () => props.store.setFocused(Math.max(0, props.store.focused() - 1)));
  onButtonPress(BTN.DOWN, () =>
    props.store.setFocused(Math.min(Math.max(0, rowCount() - 1), props.store.focused() + 1)),
  );
  onButtonPress(BTN.CIRCLE, () => {
    const item = props.store.results()[props.store.focused()];
    if (item) props.store.play(item);
    else if (props.store.hasMore()) props.store.loadMore(); // the sentinel row
  });

  // The whole result list lives under a clipping viewport and SCROLLS
  // (animated translateY: focused row rides the second slot, clamped at the
  // list end so the last row is never cut by the bottom bar). The viewport's
  // in-flow size is zero (the list is absolute), so opening the OSK squeezes
  // the viewport, never the OSK.
  let listNode: NodeMirror | undefined;
  createEffect(() => {
    const listH = rowCount() * ROW_STEP - (ROW_STEP - 64);
    const maxScroll = Math.max(0, listH - VIEW_H);
    const top = Math.min(Math.max(0, props.store.focused() - 1) * ROW_STEP, maxScroll);
    if (listNode) animate(listNode, "translateY", -top, { dur: 150, easing: "out" });
  });

  return (
    <View class="flex-col w-full h-full">
      {/* Masthead */}
      <View class="flex-row items-center justify-between px-3 py-2">
        <View class="flex-row items-center gap-2">
          {/* Baked SVG mark (64x64 pow2 canvas, transparent bands) — glyph
              centering in a View never quite landed. */}
          <Image src="yt-mark.svg" style={{ width: 22, height: 22 }} />
          <Text class="text-lg font-bold tracking-wide" style={{ textColor: INK }}>
            POCKET YOUTUBE
          </Text>
        </View>
        <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
          {props.store.phase() === "connect"
            ? "WAITING FOR HOST"
            : props.store.transport() === "usb"
              ? "USB · PSPLINK"
              : "HTTP · DEV"}
        </Text>
      </View>

      <Show when={props.store.phase() === "browse"} fallback={<ConnectScreen />}>
        {/* Search line */}
        <View class="flex-row items-center gap-2 px-3 py-1">
          <Text class="text-xs font-bold tracking-wide" style={{ textColor: RED }}>
            SEARCH
          </Text>
          <View class="grow px-2 py-1 rounded-md bg-[#141c26] border-[#232e3c]">
            <Text class="text-sm" style={{ textColor: props.store.query() || osk.isOpen() ? INK : DIM, lineHeight: 15 }}>
              {osk.isOpen() || props.store.query()
                ? osk.display()
                : "△ TYPE A QUERY, START SEARCHES"}
            </Text>
          </View>
        </View>

        {/* Results: an animated, clipped scroll column of host-rendered
            full-width rows (thumb left, text right, chevron far right). */}
        <View class="flex-1 overflow-hidden mx-3 my-1">
          <Show
            when={props.store.results().length > 0}
            fallback={
              <View class="flex-1 items-center justify-center flex-col gap-2">
                <Show when={props.store.searching()}>
                  <Spinner size={26} />
                </Show>
                <Text class="text-xs tracking-wide" style={{ textColor: props.store.status().startsWith("ERROR") ? RED : DIM }}>
                  {props.store.status() || (props.store.searching() ? "SEARCHING…" : "NO RESULTS YET — △ TO TYPE")}
                </Text>
              </View>
            }
          >
            <View
              nodeRef={(n) => (listNode = n)}
              class="absolute flex-col gap-1"
              style={{ insetT: 0, insetL: 0, width: CARD_VISIBLE_W }}
            >
              <For each={props.store.results()}>
                {(item, i) => <ResultRow item={item} active={i() === props.store.focused()} />}
              </For>
              <Show when={props.store.hasMore()}>
                <LoadMoreRow
                  active={props.store.focused() >= props.store.results().length}
                  busy={props.store.searching()}
                />
              </Show>
            </View>
          </Show>
        </View>
        <View class="flex-row justify-between px-4 pb-1">
          <Text class="text-xs" style={{ textColor: DIM, lineHeight: 12 }}>
            {props.store.results().length > 0
              ? `${props.store.focused() + 1}/${props.store.results().length}`
              : ""}
          </Text>
          <Text class="text-xs tracking-wide" style={{ textColor: props.store.status() ? RED : DIM, lineHeight: 12 }}>
            {props.store.status() || "↕ BROWSE · ○ PLAY · △ TYPE"}
          </Text>
        </View>

        {/* System keyboard, docked at the column bottom while open */}
        <Osk osk={osk} />
      </Show>
    </View>
  );
}

function ConnectScreen() {
  return (
    <View class="flex-1 items-center justify-center flex-col gap-2">
      <Text class="text-sm font-bold tracking-wide animate-pulse" style={{ textColor: INK }}>
        CONNECT USB · START THE MAC HOST
      </Text>
      <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
        {"bun demos/youtube/host/serve.ts --dir <usbhostfs root>"}
      </Text>
    </View>
  );
}

/** The selection ring, drawn ON TOP of the row content — an absolute
 *  overlay can never lose the z-fight against the card image (a border on
 *  the image's own wrapper did, on hardware). */
function FocusRing(props: { active: boolean }) {
  return (
    <Show when={props.active}>
      <View class="absolute inset-0 rounded-md border-2 border-[#ff4757]" />
    </Show>
  );
}

/** The infinite-list sentinel: focusable like a row, ○ fetches the next
 *  page of the current search. */
function LoadMoreRow(props: { active: boolean; busy: boolean }) {
  return (
    <View class="relative w-full h-[64] rounded-md bg-[#141c26] items-center justify-center flex-row gap-2">
      <Show when={props.busy}>
        <Spinner />
      </Show>
      <Text class="text-xs font-bold tracking-wide" style={{ textColor: props.active ? INK : DIM }}>
        {props.busy ? "LOADING MORE…" : "▼ LOAD MORE — ○"}
      </Text>
      <FocusRing active={props.active} />
    </View>
  );
}

/** One host-rendered full-width result row (512x64 texture, 456 visible —
 *  the pow2 tail is clipped by the wrapper). The texture loads through the
 *  driver's one-per-frame queue and is freed with the row. */
function ResultRow(props: { item: ResultItem; active: boolean }) {
  const [handle, setHandle] = createSignal(-1);
  let node: NodeMirror | undefined;
  let alive = true;

  loadCard(props.item.card, (h) => {
    if (!alive) {
      if (h >= 0) getOps().freeTexture?.(h);
      return;
    }
    setHandle(h);
  });
  onCleanup(() => {
    alive = false;
    const h = handle();
    if (h >= 0) getOps().freeTexture?.(h);
  });
  createEffect(() => {
    const h = handle();
    if (h >= 0 && node) getOps().setImage(node.id, h);
  });

  return (
    <View class="relative w-full h-[64] rounded-md overflow-hidden">
      <Show
        when={handle() >= 0}
        fallback={
          <View class="w-full h-[64] rounded-md bg-[#141c26] items-center justify-center">
            <Text class="text-xs" style={{ textColor: DIM }}>
              …
            </Text>
          </View>
        }
      >
        {/* Absolute: an IN-FLOW 512-wide image gets flex-shrunk to the 456
            wrapper (observed on hardware as an 11% squeeze — the baked
            corner arcs drifted ~50px into the row). Out of flow it renders
            1:1 and the wrapper's scissor clips the pow2 tail. */}
        <Image
          nodeRef={(n) => (node = n)}
          class="absolute"
          style={{ insetT: 0, insetL: 0, width: 512, height: 64 }}
        />
      </Show>
      <FocusRing active={props.active} />
    </View>
  );
}
