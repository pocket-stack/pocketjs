// demos/youtube/app.tsx — "Pocket YouTube": watch YouTube on a PSP over USB.
//
// No WiFi anywhere in this design: a companion Mac service (host/serve.ts)
// owns the network and the pixels, and everything reaches the device
// through the PSPLINK usbhostfs share — search results as host-rendered
// 256x64 card images (CJK titles included; the PSP atlas never could), the
// video itself as a CLUT8+PCM ring stream on the native video plane.
//
// Input: △ opens the search keyboard, START searches, d-pad browses,
// ○ plays; the player screen documents its own chords.

import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework/host";
import { animate } from "@pocketjs/framework/animation";
import { virtualFrame } from "@pocketjs/framework/clock";
import type { NodeMirror } from "@pocketjs/framework/renderer";
import { loadCard, pumpDriver } from "./driver.ts";
import { Keyboard, OSK_H } from "./keyboard.tsx";
import Player from "./player.tsx";
import { createYoutubeStore, type YoutubeStore } from "./store.ts";
import type { ResultItem } from "./protocol.ts";

const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const RED = "#ff4757";
const BG = "#0b0f14";

/** Row pitch of the results column: 64px card + 4px gap. */
const ROW_STEP = 68;
// Focus styling swaps the WHOLE class (a stale conditional style object
// leaves its border behind — observed on hardware as a trail of red rings).
const CARD_IDLE = "w-[258] h-[64] rounded-md border-[#0b0f1400] transition-colors duration-100";
const CARD_ACTIVE = "w-[258] h-[64] rounded-md border-[#ff4757] transition-colors duration-100";

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
  const [kbOpen, setKbOpen] = createSignal(false);
  const [kbFrame, setKbFrame] = createSignal(0);
  const kbClosed = () => !kbOpen();

  onButtonPress(
    BTN.TRIANGLE,
    () => {
      setKbFrame(virtualFrame());
      setKbOpen(true);
    },
    { active: kbClosed },
  );
  onButtonPress(BTN.START, () => {
    setKbOpen(false);
    props.store.search();
  });
  onButtonPress(
    BTN.UP,
    () => props.store.setFocused(Math.max(0, props.store.focused() - 1)),
    { active: kbClosed },
  );
  onButtonPress(
    BTN.DOWN,
    () =>
      props.store.setFocused(
        Math.min(Math.max(0, props.store.results().length - 1), props.store.focused() + 1),
      ),
    { active: kbClosed },
  );
  onButtonPress(
    BTN.CIRCLE,
    () => {
      const item = props.store.results()[props.store.focused()];
      if (item) props.store.play(item);
    },
    { active: kbClosed },
  );

  // The whole result list lives under a clipping viewport and SCROLLS
  // (animated translateY, focused row pinned to the second slot). The
  // viewport's in-flow size is zero (the list is absolute), so opening the
  // OSK squeezes the viewport, never the OSK — a fixed-height card column
  // once pushed the keyboard clean off the 272px screen, which reads as a
  // freeze: every handler was gated on "keyboard open" and no keyboard was
  // visible to close.
  let listNode: NodeMirror | undefined;
  createEffect(() => {
    const n = props.store.results().length;
    const top = Math.max(0, Math.min(props.store.focused() - 1, Math.max(0, n - 3)));
    if (listNode) animate(listNode, "translateY", -top * ROW_STEP, { dur: 150, easing: "out" });
  });

  return (
    <View class="flex-col w-full h-full">
      {/* Masthead */}
      <View class="flex-row items-center justify-between px-3 py-2">
        <View class="flex-row items-center gap-2">
          <View class="w-[22] h-[15] rounded-md items-center justify-center" style={{ bgColor: RED }}>
            <Text class="text-xs font-bold" style={{ textColor: "#ffffff", lineHeight: 12 }}>
              ▶
            </Text>
          </View>
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
            <Text class="text-sm" style={{ textColor: props.store.query() ? INK : DIM, lineHeight: 15 }}>
              {props.store.query() ? props.store.query() + "_" : "△ TYPE A QUERY, START SEARCHES"}
            </Text>
          </View>
        </View>

        {/* Results: an animated, clipped scroll column of host-rendered
            cards (left-aligned, like every video list since 2005). */}
        <View class="flex-1 overflow-hidden mx-3 my-1">
          <Show
            when={props.store.results().length > 0}
            fallback={
              <View class="flex-1 items-center justify-center">
                <Text class="text-xs tracking-wide" style={{ textColor: props.store.status().startsWith("ERROR") ? RED : DIM }}>
                  {props.store.status() || (props.store.searching() ? "SEARCHING…" : "NO RESULTS YET — △ TO TYPE")}
                </Text>
              </View>
            }
          >
            <View
              nodeRef={(n) => (listNode = n)}
              class="absolute flex-col gap-1"
              style={{ insetT: 0, insetL: 0 }}
            >
              <For each={props.store.results()}>
                {(item, i) => <Card item={item} active={i() === props.store.focused()} />}
              </For>
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

        {/* OSK */}
        <Show when={kbOpen()}>
          <Keyboard
            openedFrame={kbFrame()}
            onKey={(ch) => props.store.setQuery(props.store.query() + ch)}
            onSpace={() => props.store.setQuery(props.store.query() + " ")}
            onBackspace={() => props.store.setQuery(props.store.query().slice(0, -1))}
            onClose={() => setKbOpen(false)}
          />
        </Show>
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

/** One host-rendered 256x64 result card. The texture loads through the
 *  driver's one-per-frame queue and is freed with the row. */
function Card(props: { item: ResultItem; active: boolean }) {
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
    <View class={props.active ? CARD_ACTIVE : CARD_IDLE}>
      <Show
        when={handle() >= 0}
        fallback={
          <View class="w-[256] h-[64] rounded-md bg-[#141c26] items-center justify-center">
            <Text class="text-xs" style={{ textColor: DIM }}>
              …
            </Text>
          </View>
        }
      >
        <Image nodeRef={(n) => (node = n)} style={{ width: 256, height: 64 }} />
      </Show>
    </View>
  );
}
