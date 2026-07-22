// apps/im/thread.tsx — the conversation screen: a virtual-scrolled message
// list over a compose bar and the on-screen keyboard.
//
// The scroll view is built from the two-node contract Gallery documents
// (framework/src/components.ts): an UNTRANSFORMED overflow-hidden viewport (the scissor
// comes from the node's own world box) and an inner canvas whose translateY
// is a plain signal binding. Rows live at absolute y offsets computed by
// wrap.ts, and only the slice intersecting the viewport (± overscan) is
// mounted — a five-hundred-message history costs the core a dozen nodes.
//
// Scroll physics: d-pad / analog nub move a TARGET; each frame the position
// covers 30% of the remaining distance and snaps when close — smooth,
// frame-rate-fixed (PSP is 60 Hz), fully deterministic. Two invariants every
// IM app needs are kept explicitly:
//   - stick-to-bottom: appends while you sit at the bottom follow smoothly;
//     appends while you read history become a "NEW" pill instead;
//   - prepend rebase: when an older page arrives, scroll shifts by exactly
//     the added height in the same frame — backfill NEVER moves what you
//     are looking at.

import { createEffect, createMemo, createSignal, For, onMount, Show, untrack } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { analogY, onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { createOsk, Osk, OSK_H } from "@pocketjs/framework/osk";
import { SCREEN_H } from "../../contracts/spec/spec.ts";
import { fmtTime, type UiMsg } from "./data.ts";
import { buildRows, fitTail, FONT_MSG, LINE_H, type ThreadLayout, type ThreadRow } from "./wrap.ts";
import type { Convo, TalkStore } from "./store.ts";

const INK = "#e8f0f2";
const DIM = "#5f7480";
const LIME = "#b8f34a";
const TIME_DIM = "#7d95a3";

const HEADER_H = 26;
const COMPOSER_H = 26;
const SCROLL_STEP = 6; //  d-pad px per held frame
const NUB_STEP = 10; //    analog px per frame at full deflection
const OVERSCAN = 60; //    extra px mounted beyond each viewport edge
const TOP_FETCH = 36; //   distance from the top that triggers a history load
const DRAFT_MAX = 140;
const DRAFT_W = 380; //    compose field text budget (composer minus counter)
const BOTTOM_SLACK = 8; // px within which a position still counts as "at bottom"

const nearBottom = (pos: number, total: number, view: number): boolean =>
  pos >= total - view - BOTTOM_SLACK;

const ROW_IN = "absolute left-0 right-0 flex-row justify-start px-2";
const ROW_OUT = "absolute left-0 right-0 flex-row justify-end px-2";
const BUBBLE_IN = "flex-col px-2 py-1 rounded-lg bg-[#152230] border-[#1e2f40]";
const BUBBLE_OUT = "flex-col px-2 py-1 rounded-lg bg-[#1d3a24] border-[#2d5a35]";

const MEMBER_ACCENTS: Record<string, string> = {
  RIN: "#f472b6",
  KAI: "#60a5fa",
  JUNO: "#fbbf24",
};

export default function Thread(props: { convo: Convo; store: TalkStore; onBack: () => void }) {
  const contact = props.convo.contact;
  const [scroll, setScroll] = createSignal(0);
  const [target, setTarget] = createSignal(0);
  const [unseen, setUnseen] = createSignal(0);

  const doSend = () => {
    const text = props.convo.draft().trim();
    if (!text) return;
    props.store.send(props.convo, text);
    props.convo.setDraft("");
  };

  // The system keyboard edits the draft in place. Sending does NOT close it
  // (fire a message mid-conversation and keep typing), hence closeOnCommit.
  const osk = createOsk({
    value: props.convo.draft,
    setValue: props.convo.setDraft,
    maxLength: DRAFT_MAX,
    onCommit: doSend,
    closeOnCommit: false,
  });

  // Rows from the previous build are reused when unchanged (see buildRows),
  // so an append mounts one new row instead of remounting the window.
  const layout = createMemo((prev?: ThreadLayout) =>
    buildRows(
      props.convo.msgs(),
      { group: !!contact.members, begin: !props.convo.hasMore() },
      prev?.rows,
    ),
  );
  const viewH = () => SCREEN_H - HEADER_H - COMPOSER_H - (osk.isOpen() ? OSK_H : 0);
  const maxScroll = () => Math.max(0, layout().total - viewH());
  const visibleRows = createMemo((prev?: ThreadRow[]) => {
    const top = scroll() - OVERSCAN;
    const bottom = scroll() + viewH() + OVERSCAN;
    const next = layout().rows.filter((r) => r.y < bottom && r.y + r.h > top);
    // Row objects are reference-stable, so returning the previous array when
    // the slice is unchanged lets <For> skip its diff on idle scroll frames.
    if (prev && prev.length === next.length && next.every((r, i) => r === prev[i])) return prev;
    return next;
  });

  onMount(() => {
    const m = maxScroll();
    setScroll(m);
    setTarget(m);
  });

  // Append/prepend bookkeeping. Runs whenever the message list changes;
  // everything except the list itself is read untracked.
  let prevFirst: string | undefined;
  let prevLast: string | undefined;
  let prevLen = 0;
  let prevTotal = 0;
  createEffect(() => {
    const msgs = props.convo.msgs();
    const total = layout().total;
    const first = msgs[0]?.id;
    const last = msgs[msgs.length - 1]?.id;
    untrack(() => {
      if (prevFirst !== undefined && first !== prevFirst && last === prevLast) {
        // Older page prepended: shift by exactly the added height. The store
        // batches the prepend with its hasMore flip, so the beginning-of-
        // conversation chip (when this was the last page) is part of the
        // delta — backfill never moves what the user is looking at.
        const d = total - prevTotal;
        setScroll(scroll() + d);
        setTarget(target() + d);
      } else if (prevLast !== undefined && last !== prevLast) {
        // At-bottom is judged on the TARGET, not the eased position: when a
        // poll batch appends several messages in one frame, the position has
        // not caught up with the first append's snap yet, but the intent has.
        const wasAtBottom = nearBottom(target(), prevTotal, viewH());
        const incoming = !msgs[msgs.length - 1].out;
        if (!incoming || wasAtBottom) setTarget(maxScroll());
        else setUnseen(unseen() + (msgs.length - prevLen));
      }
      prevFirst = first;
      prevLast = last;
      prevLen = msgs.length;
      prevTotal = total;
    });
  });

  // Keyboard open/close changes the viewport height: keep the bottom pinned
  // if the user was there, otherwise just clamp.
  let prevViewH = viewH();
  createEffect(() => {
    const v = viewH();
    untrack(() => {
      if (v === prevViewH) return;
      const wasAtBottom = nearBottom(target(), layout().total, prevViewH);
      const m = maxScroll();
      setScroll(wasAtBottom ? m : Math.min(scroll(), m));
      setTarget(wasAtBottom ? m : Math.min(target(), m));
      prevViewH = v;
    });
  });

  // The scroll pump: input moves the target, position eases toward it.
  onFrame((buttons) => {
    const m = maxScroll();
    // Raw button reads are not muted by the OSK's modal block — gate them.
    if (!osk.isOpen()) {
      if (buttons & BTN.UP) setTarget((t) => Math.max(0, t - SCROLL_STEP));
      if (buttons & BTN.DOWN) setTarget((t) => Math.min(m, t + SCROLL_STEP));
    }
    const nub = analogY();
    if (nub !== 0) setTarget((t) => Math.min(m, Math.max(0, t + nub * NUB_STEP)));
    const s = scroll();
    const d = target() - s;
    if (d !== 0) setScroll(Math.abs(d) < 0.6 ? target() : s + d * 0.3);
    if (unseen() !== 0 && scroll() >= m - BOTTOM_SLACK) setUnseen(0);
    if (scroll() < TOP_FETCH && props.convo.hasMore() && !props.convo.loading()) {
      props.store.loadOlder(props.convo);
    }
  });

  // All chords are `latched`: this screen mounts from a Focusable press on
  // the list, so a held button must be seen up once before its edge counts.
  // None need an "is the keyboard open" gate — the system OSK blocks them
  // all while it is up and provides its own chords.
  onButtonPress(BTN.TRIANGLE, () => osk.open(), { latched: true });
  onButtonPress(BTN.CROSS, () => props.onBack(), { latched: true });
  onButtonPress(BTN.START, doSend, { latched: true });
  onButtonPress(
    BTN.SELECT,
    () => {
      setTarget(maxScroll());
      setUnseen(0);
    },
    { latched: true },
  );

  const accentFor = (from: string): string => MEMBER_ACCENTS[from] ?? contact.accent;
  const presence = () =>
    contact.members
      ? `${contact.members.length + 1} MEMBERS`
      : contact.online
        ? "● ONLINE"
        : "○ LAST SEEN YESTERDAY";
  // The caret marker comes from the OSK session (‹ › move it mid-draft).
  const draftShown = createMemo(() => fitTail(osk.display(), FONT_MSG, DRAFT_W));

  return (
    <View class="flex-col w-full h-full" style={{ bgColor: "#05080c" }}>
      {/* Header */}
      <View
        class="flex-row items-center justify-between px-2 bg-[#0a1118] border-[#1a2733]"
        style={{ height: HEADER_H }}
      >
        <View class="flex-row items-center gap-2">
          <Text class="text-sm font-bold tracking-wide" style={{ textColor: INK }}>
            {contact.name}
          </Text>
          <Show
            when={props.convo.typing()}
            fallback={
              <Text class="text-xs" style={{ textColor: contact.online ? "#4ade80" : DIM }}>
                {presence()}
              </Text>
            }
          >
            <Text class="text-xs animate-pulse" style={{ textColor: LIME }}>
              {`${props.convo.typing()} TYPING…`}
            </Text>
          </Show>
        </View>
        <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
          × BACK
        </Text>
      </View>

      {/* Message viewport — the untransformed clip node */}
      <View class="relative overflow-hidden" style={{ height: viewH() }}>
        {/* The canvas: full history height, translated by the scroll */}
        <View
          class="absolute left-0 right-0 top-0"
          style={{ height: layout().total, translateY: -scroll() }}
        >
          <For each={visibleRows()}>{(row) => <Row row={row} accentFor={accentFor} />}</For>
        </View>

        <Show when={props.convo.loading()}>
          <View class="absolute left-0 right-0 top-1 flex-row justify-center">
            <View class="px-2 rounded-md bg-[#13202b]">
              <Text class="text-xs animate-pulse" style={{ textColor: DIM, lineHeight: 14 }}>
                LOADING EARLIER…
              </Text>
            </View>
          </View>
        </Show>

        <Show when={props.convo.typing()}>
          <View class="absolute left-2 bottom-1 flex-row">
            <View class="px-2 rounded-md bg-[#13202b]">
              <Text class="text-xs animate-pulse" style={{ textColor: TIME_DIM, lineHeight: 14 }}>
                {`${props.convo.typing()} IS TYPING…`}
              </Text>
            </View>
          </View>
        </Show>

        <Show when={unseen() > 0}>
          <View class="absolute right-2 bottom-1 flex-row">
            <View class="px-2 rounded-md bg-[#b8f34a] shadow-md">
              <Text class="text-xs font-bold" style={{ textColor: "#0c1408", lineHeight: 14 }}>
                {`▼ ${unseen()} NEW · SELECT`}
              </Text>
            </View>
          </View>
        </Show>
      </View>

      {/* Composer */}
      <View
        class="flex-row items-center gap-2 px-2 bg-[#0a1118] border-[#1a2733]"
        style={{ height: COMPOSER_H }}
      >
        <Show
          when={osk.isOpen() || props.convo.draft().length > 0}
          fallback={
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              ↕ SCROLL · △ KEYBOARD · SELECT LATEST · × BACK
            </Text>
          }
        >
          <View class="flex-row items-center grow">
            <Text class="text-sm" style={{ textColor: INK, lineHeight: LINE_H }}>
              {draftShown()}
            </Text>
          </View>
          <Text class="text-xs" style={{ textColor: DIM }}>
            {`${props.convo.draft().length}/${DRAFT_MAX}`}
          </Text>
        </Show>
      </View>

      {/* System on-screen keyboard */}
      <Osk osk={osk} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function Row(props: { row: ThreadRow; accentFor: (from: string) => string }) {
  const r = props.row;
  if (r.kind === "chip") {
    return (
      <View
        class="absolute left-0 right-0 flex-row justify-center items-center"
        style={{ insetT: r.y, height: r.h }}
      >
        <View class="px-2 rounded-md bg-[#101a24]">
          <Text class="text-xs tracking-wide" style={{ textColor: DIM, lineHeight: 14 }}>
            {r.label}
          </Text>
        </View>
      </View>
    );
  }
  const m = r.msg;
  return (
    <View class={m.out ? ROW_OUT : ROW_IN} style={{ insetT: r.y, height: r.h }}>
      <View class="flex-col">
        <Show when={r.label}>
          <Text
            class="text-xs font-bold"
            style={{ textColor: props.accentFor(m.from), lineHeight: 12, marginB: 2 }}
          >
            {r.label}
          </Text>
        </Show>
        <View class={m.out ? BUBBLE_OUT : BUBBLE_IN} style={{ width: r.bubbleW }}>
          <Text class="text-sm" style={{ textColor: INK, lineHeight: LINE_H }}>
            {r.body}
          </Text>
          <View class="flex-row justify-end items-center gap-1">
            <Text class="text-xs" style={{ textColor: TIME_DIM, lineHeight: 12 }}>
              {fmtTime(m.minute)}
            </Text>
            <Show when={m.out}>
              <Ticks msg={m} />
            </Show>
          </View>
        </View>
      </View>
    </View>
  );
}

/** Delivery state ticks: … sending, ✓ sent, ✓✓ delivered, lime ✓✓ read. */
function Ticks(props: { msg: UiMsg }) {
  const glyph = () => {
    const s = props.msg.state();
    return s === "sending" ? "…" : s === "sent" ? "✓" : "✓✓";
  };
  return (
    <Text
      class="text-xs font-bold"
      style={{ textColor: props.msg.state() === "read" ? LIME : TIME_DIM, lineHeight: 12 }}
    >
      {glyph()}
    </Text>
  );
}
