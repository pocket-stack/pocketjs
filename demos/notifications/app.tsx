// demos/notifications/app.tsx — "notification center" showcase: a real <For>
// list (the other three demos only ever .map() a fixed-length array — this
// is the one demo whose array actually shrinks, so it's the one that
// exercises <For>'s per-item mount/unmount identity instead of just reorder).
// Each item staggers in with a delayed opacity+translateX tween on mount.
// CIRCLE dismisses the focused card with an imperative fade+slide, then the
// retained rows below it get a short FLIP-style translateY rise so layout
// collapse reads as motion instead of an instant snap.
//
// Design notes: p-1 rows / p-3 root — 4 cards is already a tight fit in
// 480x272 (DESIGN.md punts kinetic scroll, so the list can't overflow the
// screen); every class a FULL literal.

import { createSignal, For, onMount, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";

interface Notice {
  id: string;
  title: string;
  message: string;
  time: string;
  /** dot: FULL literal (fixed size + accent color, rounded-full is safe —
   *  build-time known w/h). */
  dotCls: string;
}

const INITIAL: Notice[] = [
  {
    id: "update",
    title: "UPDATE AVAILABLE",
    message: "Firmware 6.61 is ready to install.",
    time: "2m ago",
    dotCls: "w-2 h-2 rounded-full bg-sky-500",
  },
  {
    id: "friend",
    title: "FRIEND REQUEST",
    message: "RIDGE_FOX wants to join your session.",
    time: "14m ago",
    dotCls: "w-2 h-2 rounded-full bg-emerald-500",
  },
  {
    id: "battery",
    title: "LOW BATTERY",
    message: "12% remaining — plug in soon.",
    time: "35m ago",
    dotCls: "w-2 h-2 rounded-full bg-amber-500",
  },
  {
    id: "trophy",
    title: "TROPHY UNLOCKED",
    message: '"First Contact" — Iron Vanguard.',
    time: "1h ago",
    dotCls: "w-2 h-2 rounded-full bg-blue-500",
  },
];

const DISMISS_FRAMES = 16; // >= the 200ms fade tween (~12 frames), plus margin
const ROW_RISE_PX = 42; // row height + list gap; used as the collapse offset
const ROW_RISE_FRAMES = 16; // >= the 180ms rise tween, plus margin

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Notifications() {
  const [items, setItems] = createSignal<Notice[]>(INITIAL);
  const [dismissingId, setDismissingId] = createSignal<string | null>(null);
  const [dismissFrame, setDismissFrame] = createSignal(0);
  const [riseOffsets, setRiseOffsets] = createSignal<Record<string, number>>({});
  const [riseQueued, setRiseQueued] = createSignal<string[]>([]);
  const [riseFrame, setRiseFrame] = createSignal(0);
  const rowRefs = new Map<string, NodeMirror>();

  const hasRise = () => Object.keys(riseOffsets()).length > 0 || riseQueued().length > 0;

  onFrame(() => {
    const queued = riseQueued();
    if (queued.length > 0) {
      for (const id of queued) {
        const row = rowRefs.get(id);
        if (row) animate(row, "translateY", 0, { dur: 180, easing: "out" });
      }
      setRiseQueued([]);
      setRiseFrame(0);
    } else if (Object.keys(riseOffsets()).length > 0) {
      const n = riseFrame() + 1;
      setRiseFrame(n);
      if (n >= ROW_RISE_FRAMES) {
        setRiseOffsets({});
        setRiseFrame(0);
      }
    }

    const id = dismissingId();
    if (id === null) return;
    const n = dismissFrame() + 1;
    setDismissFrame(n);
    if (n >= DISMISS_FRAMES) {
      const before = items();
      const removedIndex = before.findIndex((it) => it.id === id);
      const rising = removedIndex < 0 ? [] : before.slice(removedIndex + 1).map((it) => it.id);
      if (rising.length > 0) {
        setRiseOffsets(Object.fromEntries(rising.map((rid) => [rid, ROW_RISE_PX])));
        setRiseQueued(rising);
      }
      rowRefs.delete(id);
      setItems(before.filter((it) => it.id !== id));
      setDismissingId(null);
      setDismissFrame(0);
    }
  });

  const dismiss = (id: string, el: NodeMirror | undefined) => {
    if (dismissingId() !== null || hasRise() || !el) return;
    setDismissingId(id);
    setDismissFrame(0);
    animate(el, "opacity", 0, { dur: 200, easing: "out" });
    animate(el, "translateX", 24, { dur: 200, easing: "out" });
  };

  return (
    <View debugName="NotificationsScreen" class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <View debugName="Header" class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Notifications</Text>
        </View>
        <Text class="text-xs text-slate-500">{items().length} UNREAD</Text>
      </View>

      <View debugName="NoticeList" class="flex-col gap-1">
        <For each={items()}>
          {(item, i) => {
            let el: NodeMirror | undefined;
            onMount(() => {
              if (el) {
                animate(el, "opacity", 1, { dur: 250, delay: i() * 70, easing: "out" });
                animate(el, "translateX", 0, { dur: 250, delay: i() * 70, easing: "out" });
              }
            });
            return (
              <View
                ref={(row) => {
                  rowRefs.set(item.id, row);
                }}
                debugName="NoticeRow"
                class="flex-col"
                style={{ translateY: riseOffsets()[item.id] ?? 0 }}
              >
                <View
                  ref={el}
                  style={{ opacity: 0, translateX: 16 }}
                  class="flex-row items-center gap-3 p-1 rounded-lg shadow bg-white border-slate-200 focus:bg-blue-50 focus:border-blue-500 transition-colors duration-150"
                  focusable
                  onPress={() => dismiss(item.id, el)}
                >
                  <View class={item.dotCls} />
                  <View class="flex-col grow">
                    <Text class="text-xs text-slate-950 font-bold">{item.title}</Text>
                    <Text class="text-xs text-slate-600">{item.message}</Text>
                  </View>
                  <Text class="text-xs text-slate-500">{item.time}</Text>
                </View>
              </View>
            );
          }}
        </For>
      </View>

      <Show when={items().length === 0}>
        <View debugName="EmptyState" class="grow flex-col items-center justify-center rounded-xl shadow bg-white border-slate-200">
          <Text class="text-sm text-slate-500">ALL CLEAR</Text>
        </View>
      </Show>

      <Text class="text-xs text-slate-500">UP / DOWN move focus · CIRCLE dismiss</Text>
    </View>
  );
}
