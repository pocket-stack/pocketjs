// apps/stats/app.tsx — "animated dashboard" showcase: three stat tiles whose
// numbers count up over the first ~1.2 s, horizontal bars that grow through
// native transform-only tweens, and LEFT/RIGHT switching two horizontally
// arranged tabs. The SYSTEMS tab uses a short staggered row reveal so rows
// never flash through the style-table default before becoming white.
//
// Frame driving stays component-scoped through PocketJS lifecycle callbacks: button presses
// switch tabs, while a capped frame hook advances deterministic counters.

import { createMemo, createSignal, onMount, Show } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

const COUNT_FRAMES = 75;
const COUNT_TEXT_STEP = 8;
const BAR_ANIM_FRAMES = 26;
const BAR_STAGGER_FRAMES = 4;
const SYSTEMS_REVEAL_FRAMES = 12;
const SYSTEMS_STAGGER_FRAMES = 5;
const SYSTEMS_MAX_FRAMES = SYSTEMS_REVEAL_FRAMES + SYSTEMS_STAGGER_FRAMES * 3;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Stat {
  label: string;
  target: number;
  delta: string;
  valueCls: string;
}

const STATS: Stat[] = [
  { label: "PLAYERS ONLINE", target: 12480, delta: "+318", valueCls: "text-2xl text-blue-600 font-bold" },
  { label: "SESSIONS TODAY", target: 3642, delta: "+9%", valueCls: "text-2xl text-emerald-600 font-bold" },
  { label: "DRAW CALLS", target: 268, delta: "-12", valueCls: "text-2xl text-amber-600 font-bold" },
];

interface Bar {
  label: string;
  pct: number; // 0..100
  fill: string;
}

const BAR_W = 280; // track px — fill is fixed-width and transform-scaled.
const BAR_ANIM_MS = Math.round((BAR_ANIM_FRAMES / 60) * 1000);
const BAR_STAGGER_MS = Math.round((BAR_STAGGER_FRAMES / 60) * 1000);

const BARS: Bar[] = [
  { label: "CPU", pct: 42, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-blue-500 to-blue-600" },
  { label: "GPU", pct: 71, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600" },
  { label: "RAM", pct: 63, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-amber-500 to-amber-600" },
  { label: "I/O", pct: 28, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-sky-500 to-sky-600" },
];

interface Sys {
  name: string;
  status: string;
  led: string;
  statusCls: string;
}

const SYSTEMS: Sys[] = [
  { name: "GE PIPELINE", status: "ONLINE", led: "w-2 h-2 rounded-full bg-emerald-500", statusCls: "text-xs text-emerald-600" },
  { name: "AUDIO MIXER", status: "ONLINE", led: "w-2 h-2 rounded-full bg-emerald-500", statusCls: "text-xs text-emerald-600" },
  { name: "MEMORY ARENA", status: "87% USED", led: "w-2 h-2 rounded-full bg-amber-500", statusCls: "text-xs text-amber-600" },
  { name: "WIFI LINK", status: "ONLINE", led: "w-2 h-2 rounded-full bg-emerald-500", statusCls: "text-xs text-emerald-600" },
];

function fmt(n: number): string {
  const s = String(n);
  return s.length > 3 ? s.slice(0, -3) + "," + s.slice(-3) : s;
}

function easeOutCubic(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function barScale(bar: Bar): number {
  return bar.pct / 100;
}

function barFillOffset(scale: number): number {
  return -(BAR_W * (1 - scale)) / 2;
}

/** OVERVIEW tab: bars use native transform-only tweens, matching switch/slider
 *  motion without triggering per-frame layout work. */
function Overview() {
  const fills: Array<NodeMirror | undefined> = [];

  onMount(() => {
    BARS.forEach((bar, i) => {
      const fill = fills[i];
      if (!fill) return;
      const scale = barScale(bar);
      const delay = i * BAR_STAGGER_MS;
      animate(fill, "scaleX", scale, { dur: BAR_ANIM_MS, delay, easing: "out" });
      animate(fill, "translateX", barFillOffset(scale), { dur: BAR_ANIM_MS, delay, easing: "out" });
    });
  });

  return (
    <View debugName="Overview" class="flex-col gap-1">
      {BARS.map((bar, i) => (
        <View class="flex-row items-center gap-2">
          <View class="w-9 flex-row justify-end">
            <Text class="text-xs text-slate-600">{bar.label}</Text>
          </View>
          <View class="w-[280] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
            <View
              ref={(node) => {
                fills[i] = node;
              }}
              class={bar.fill}
              style={{ scaleX: 0, translateX: barFillOffset(0) }}
            />
          </View>
          <Text class="text-xs text-slate-500">{bar.pct + "%"}</Text>
        </View>
      ))}
    </View>
  );
}

/** SYSTEMS tab: status board. Rows appear one after another with short delays;
 *  opacity starts at 0, so there is no visible flash from default gray. */
function Systems(props: { frame: () => number }) {
  const rowT = (i: number) => easeOutCubic((props.frame() - i * SYSTEMS_STAGGER_FRAMES) / SYSTEMS_REVEAL_FRAMES);
  return (
    <View debugName="Systems" class="flex-col gap-1">
      {SYSTEMS.map((sys, i) => (
        <View
          class="flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-white border-slate-200"
          style={{ opacity: rowT(i), translateY: (1 - rowT(i)) * 8 }}
        >
          <View class="flex-row items-center gap-2">
            <View class={sys.led} />
            <Text class="text-xs text-slate-700 tracking-wide">{sys.name}</Text>
          </View>
          <Text class={sys.statusCls}>{sys.status}</Text>
        </View>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Stats() {
  const [frameN, setFrameN] = createSignal(0);
  const [tab, setTab] = createSignal(0);
  const [systemsFrame, setSystemsFrame] = createSignal(0);

  onButtonPress(BTN.RIGHT, () => {
    setTab(1);
    setSystemsFrame(0);
  });
  onButtonPress(BTN.LEFT, () => setTab(0));
  onFrame(() => {
    if (frameN() < COUNT_FRAMES) setFrameN(frameN() + 1);
    if (tab() === 1 && systemsFrame() < SYSTEMS_MAX_FRAMES) {
      setSystemsFrame(systemsFrame() + 1);
    }
  });

  // Count-up: eased share of the capped frame counter — pure per-frame math,
  // but quantized so PSP text nodes do not relayout at 60 Hz.
  const t = createMemo(() => {
    const f = frameN();
    const visibleFrame = f >= COUNT_FRAMES ? COUNT_FRAMES : Math.floor(f / COUNT_TEXT_STEP) * COUNT_TEXT_STEP;
    const x = Math.min(1, visibleFrame / COUNT_FRAMES);
    return easeOutCubic(x);
  });

  return (
    <View debugName="StatsScreen" class="flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <View debugName="Header" class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-emerald-600 tracking-wide">LIVE TELEMETRY</Text>
          <Text class="text-2xl text-slate-950 font-bold">Mission Control</Text>
        </View>
        <View debugName="TabBar" class="flex-row gap-2">
          <View
            class={
              tab() === 0
                ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150"
                : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"
            }
          >
            <Text
              class={
                tab() === 0
                  ? "text-xs text-white font-bold tracking-wide"
                  : "text-xs text-slate-500 tracking-wide"
              }
            >
              OVERVIEW
            </Text>
          </View>
          <View
            class={
              tab() === 1
                ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150"
                : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"
            }
          >
            <Text
              class={
                tab() === 1
                  ? "text-xs text-white font-bold tracking-wide"
                  : "text-xs text-slate-500 tracking-wide"
              }
            >
              SYSTEMS
            </Text>
          </View>
        </View>
      </View>

      <View debugName="StatTiles" class="flex-row gap-3">
        {STATS.map((stat) => (
          <View class="flex-1 flex-col gap-1 p-2 rounded-xl shadow-md bg-white border-slate-200">
            <Text class="text-xs text-slate-500 tracking-wide">{stat.label}</Text>
            <View class="flex-row items-end gap-1">
              <Text class={stat.valueCls}>{fmt(Math.round(stat.target * t()))}</Text>
              <Text class="text-xs text-emerald-600">{stat.delta}</Text>
            </View>
          </View>
        ))}
      </View>

      <View class="grow flex-col">
        <Show when={tab() === 0}>
          <Overview />
        </Show>
        <Show when={tab() === 1}>
          <Systems frame={systemsFrame} />
        </Show>
      </View>

      <Text class="text-xs text-slate-500">LEFT / RIGHT switch tab</Text>
    </View>
  );
}
