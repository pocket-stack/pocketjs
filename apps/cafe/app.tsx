// apps/cafe/app.tsx — "Pocket Café": the effect-shell showcase app.
//
// A realistic ordering flow with everything that usually makes UI tests
// flake: an async menu fetch on boot, an async order mutation with latency,
// a spinner phase, and a confirmation that auto-dismisses on a timer. Here
// none of it touches the wall clock — the fetch and the mutation go through
// the effect shell (apps/cafe/backend.ts), the auto-dismiss is a virtual
// `after()`, so the whole journey is a pure fold over the input tape and
// replays byte-exact at any simulationHz (tests/sim.test.ts proves it).
//
// Input: d-pad browses, CIRCLE adds the focused drink, START places the
// order. While the order is in flight the app keeps accepting nothing —
// phase guards, no input blocking needed for this demo's script.

import { createMemo, createSignal, For, Show, onMount } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN, pushFocusScope } from "@pocketjs/framework/input";
import { runEffect } from "@pocketjs/framework/effects";
import { after } from "@pocketjs/framework/clock";
import type { MenuItem, OrderReceipt } from "./backend.ts";

const INK = "#e8f0f2";
const DIM = "#8fa3ad";
const LIME = "#b8f34a";
const AMBER = "#fbbf24";

// One string literal per class list — the Tailwind subset bakes whole class
// strings, a concatenation would leave the runtime string unbaked.
const ROW_BASE =
  "flex-row items-center gap-2 px-2 py-1 rounded-sm border-[#0a121a00] bg-[#0a121a80] transition-all duration-100 focus:bg-[#33470f] focus:border-[#b8f34a] focus:translate-x-1";

const fmt = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

type Phase = "connecting" | "menu" | "placing" | "confirmed";

export default function Cafe() {
  const [phase, setPhase] = createSignal<Phase>("connecting");
  const [items, setItems] = createSignal<MenuItem[]>([]);
  const [qty, setQty] = createSignal<number[]>([]);
  const [orders, setOrders] = createSignal(0);
  const [receipt, setReceipt] = createSignal<OrderReceipt | null>(null);

  const total = createMemo(() => items().reduce((n, it, i) => n + it.cents * (qty()[i] ?? 0), 0));

  // Boot: fetch the menu through the effect shell. The result is applied at
  // a frame boundary — `connecting` lasts exactly the backend's latency in
  // virtual time, no matter how fast or slow the host runs.
  runEffect<{ items: MenuItem[] }>("menu", null, (res) => {
    setItems(res.items);
    setQty(res.items.map(() => 0));
    setPhase("menu");
  });

  const add = (i: number) => {
    if (phase() !== "menu") return;
    setQty((q) => q.map((n, j) => (j === i ? n + 1 : n)));
  };

  onButtonPress(BTN.START, () => {
    if (phase() !== "menu" || total() === 0) return;
    setPhase("placing");
    const order = items()
      .map((it, i) => ({ id: it.id, qty: qty()[i] }))
      .filter((it) => it.qty > 0);
    runEffect<OrderReceipt>("order", { items: order, seq: orders() }, (r) => {
      setReceipt(r);
      setPhase("confirmed");
      after(1.5, () => {
        setOrders((n) => n + 1);
        setQty((q) => q.map(() => 0));
        setReceipt(null);
        setPhase("menu");
      });
    });
  });

  return (
    <View class="w-full h-full flex-col" style={{ bgColor: "#05080c" }}>
      {/* Masthead */}
      <View class="flex-row items-center justify-between px-3 py-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-xl font-bold tracking-wide" style={{ textColor: INK }}>
            POCKET CAFÉ
          </Text>
          <View style={{ width: 24, height: 1, bgColor: LIME }} />
        </View>
        <Show when={orders() > 0}>
          <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
            {`ORDERS PLACED ${orders()}`}
          </Text>
        </Show>
      </View>

      {/* Body */}
      <View class="flex-1 px-3">
        <Show
          when={phase() !== "connecting"}
          fallback={
            <View class="flex-1 justify-center items-center">
              <Text class="text-sm tracking-wide animate-pulse" style={{ textColor: DIM }}>
                CONNECTING TO STORE…
              </Text>
            </View>
          }
        >
          <MenuList items={items()} qty={qty()} onAdd={add} />
        </Show>
      </View>

      {/* Status bar */}
      <View class="px-3 py-2 flex-row items-center justify-between border-[#1a2733] bg-[#0a121a]">
        <Show
          when={phase() === "confirmed"}
          fallback={
            <Show
              when={phase() === "placing"}
              fallback={
                <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
                  ↕ BROWSE · ○ ADD · START = PLACE ORDER
                </Text>
              }
            >
              <Text class="text-xs tracking-wide animate-pulse" style={{ textColor: AMBER }}>
                PLACING ORDER…
              </Text>
            </Show>
          }
        >
          <Text class="text-xs font-bold tracking-wide" style={{ textColor: LIME }}>
            {`ORDER #${receipt()?.orderNo} · READY IN ${receipt()?.etaMin} MIN`}
          </Text>
        </Show>
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: INK }}>
          {`TOTAL ${fmt(total())}`}
        </Text>
      </View>
    </View>
  );
}

function MenuList(props: {
  items: MenuItem[];
  qty: number[];
  onAdd: (i: number) => void;
}) {
  // Focus: light the first drink as soon as the menu lands.
  let list!: NodeMirror;
  onMount(() => {
    pushFocusScope(list, { autoFocus: true });
  });
  return (
    <View ref={(el: NodeMirror) => (list = el)} class="flex-col gap-1 mt-1">
      <For each={props.items}>
        {(item, i) => (
          <View focusable onPress={() => props.onAdd(i())} class={ROW_BASE}>
            <Text class="text-sm font-bold tracking-wide" style={{ textColor: INK, width: 110 }}>
              {item.name}
            </Text>
            <Text class="text-xs" style={{ textColor: DIM }}>
              {fmt(item.cents)}
            </Text>
            <View class="flex-1" />
            <Show when={(props.qty[i()] ?? 0) > 0}>
              <Text class="text-sm font-bold" style={{ textColor: AMBER }}>
                {`x${props.qty[i()]}`}
              </Text>
            </Show>
          </View>
        )}
      </For>
    </View>
  );
}
