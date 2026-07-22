// apps/im/app.tsx — "Pocket Talk": the IM showcase app.
//
// Everything a messaging client needs except a socket, on a PSP: a
// conversation list with presence, previews, unread badges and recency
// sorting; a virtual-scrolled thread with word-wrapped bubbles, day
// separators, delivery/read receipts, typing indicators and history
// pagination (thread.tsx); an on-screen keyboard with a live draft + caret
// (keyboard.tsx); and a long-poll sync loop against a virtual-time mock
// server (store.ts + backend.ts). The network is the only fake part — every
// state transition above it is the real thing.
//
// Input: d-pad browses, CIRCLE opens a chat; inside a thread, × backs out
// (the thread's footer teaches the rest).

import { createMemo, For, Show } from "solid-js";
import { FocusScope, Text, View } from "@pocketjs/framework/components";
import { dayLabel, fmtTime, type UiMsg } from "./data.ts";
import { createTalkStore, type Convo } from "./store.ts";
import Thread from "./thread.tsx";
import { fitEnd, FONT_META } from "./wrap.ts";

const INK = "#e8f0f2";
const DIM = "#5f7480";
const LIME = "#b8f34a";

const LIST_ROW =
  "flex-row items-center gap-2 px-2 py-1 rounded-lg border-[#0a111800] bg-[#0a111800] transition-colors duration-100 focus:bg-[#11202c] focus:border-[#b8f34a]";

const PREVIEW_W = 296;

export default function Talk() {
  const store = createTalkStore();
  const activeConvo = createMemo(() =>
    store.convos().find((c) => c.contact.id === store.active()),
  );

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: "#05080c" }}>
      <Show
        when={store.phase() === "ready"}
        fallback={
          <View class="flex-1 justify-center items-center">
            <Text class="text-sm tracking-wide animate-pulse" style={{ textColor: DIM }}>
              CONNECTING…
            </Text>
          </View>
        }
      >
        <Show when={activeConvo()} keyed fallback={<ListScreen store={store} />}>
          {(c) => <Thread convo={c} store={store} onBack={() => store.setActive(null)} />}
        </Show>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function lastMsg(c: Convo): UiMsg | undefined {
  const m = c.msgs();
  return m[m.length - 1];
}

/** Newest-activity-first sort key (day counts age, so it negates). */
function recency(c: Convo): number {
  const m = lastMsg(c);
  return m ? -m.day * 1440 + m.minute : -1e9;
}

function preview(c: Convo): string {
  const m = lastMsg(c);
  if (!m) return "";
  const head = m.out ? "YOU: " : c.contact.members ? m.from + ": " : "";
  const firstLine = m.text.split("\n")[0];
  return fitEnd(head + firstLine, FONT_META, PREVIEW_W);
}

function stampLabel(m: UiMsg | undefined): string {
  if (!m) return "";
  return m.day === 0 ? fmtTime(m.minute) : dayLabel(m.day);
}

function ListScreen(props: { store: ReturnType<typeof createTalkStore> }) {
  const sorted = createMemo(() => [...props.store.convos()].sort((a, b) => recency(b) - recency(a)));
  const totalUnread = createMemo(() =>
    props.store.convos().reduce((n, c) => n + c.unread(), 0),
  );

  return (
    <View class="flex-col w-full h-full">
      {/* Masthead */}
      <View class="flex-row items-center justify-between px-3 py-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-xl font-bold tracking-wide" style={{ textColor: INK }}>
            POCKET TALK
          </Text>
          <View style={{ width: 24, height: 1, bgColor: LIME }} />
        </View>
        <Text class="text-xs tracking-wide" style={{ textColor: totalUnread() > 0 ? LIME : DIM }}>
          {totalUnread() > 0 ? `${totalUnread()} UNREAD` : "ALL CAUGHT UP"}
        </Text>
      </View>

      {/* Conversations */}
      <FocusScope class="flex-1 flex-col gap-1 px-2">
        <For each={sorted()}>
          {(c) => (
            <View focusable onPress={() => props.store.setActive(c.contact.id)} class={LIST_ROW}>
              <View class={c.contact.avatarCls}>
                <Text class="text-sm font-bold" style={{ textColor: "#ffffff" }}>
                  {c.contact.initial}
                </Text>
              </View>
              <View class="flex-col grow">
                <View class="flex-row items-center gap-1">
                  <Show when={c.contact.online}>
                    <Text class="text-xs" style={{ textColor: "#4ade80", lineHeight: 12 }}>
                      ●
                    </Text>
                  </Show>
                  <Text class="text-sm font-bold tracking-wide" style={{ textColor: INK }}>
                    {c.contact.name}
                  </Text>
                  <Show when={c.contact.members}>
                    <Text class="text-xs" style={{ textColor: DIM }}>
                      {`· ${(c.contact.members?.length ?? 0) + 1}`}
                    </Text>
                  </Show>
                </View>
                <Text class="text-xs" style={{ textColor: DIM, lineHeight: 13 }}>
                  {preview(c)}
                </Text>
              </View>
              <View class="flex-col items-end gap-1">
                <Text class="text-xs" style={{ textColor: DIM, lineHeight: 12 }}>
                  {stampLabel(lastMsg(c))}
                </Text>
                <Show when={c.unread() > 0}>
                  <View class="px-1 rounded-md bg-[#b8f34a]">
                    <Text class="text-xs font-bold" style={{ textColor: "#0c1408", lineHeight: 13 }}>
                      {`${c.unread()}`}
                    </Text>
                  </View>
                </Show>
              </View>
            </View>
          )}
        </For>
      </FocusScope>

      {/* Hint bar */}
      <View class="px-3 py-2 flex-row items-center justify-between border-[#1a2733] bg-[#0a1118]">
        <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
          ↕ BROWSE · ○ OPEN
        </Text>
        <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
          MOCK NETWORK · VIRTUAL CLOCK
        </Text>
      </View>
    </View>
  );
}
