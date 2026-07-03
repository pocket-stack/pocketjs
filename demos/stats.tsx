// demos/stats.tsx — "animated dashboard" showcase: three stat tiles whose
// numbers count up over the first ~1.2 s, horizontal bars that grow to their
// value from the capped frame signal, and LEFT/RIGHT switching two horizontally
// arranged tabs. The SYSTEMS tab uses a short staggered row reveal so rows never
// flash through the style-table default before becoming white.
//
// Frame driving: statsFrame(buttons) is called once per frame by the
// stats-main entry (it wraps globalThis.frame). It edge-detects LEFT/RIGHT for
// the tab switch and steps capped frame-counter signals; after the current
// choreography settles, steady-state JS work is zero. Content stays a pure
// function of the frame index (byte-exact goldens).

import { createMemo, createSignal, Show } from "solid-js";
import { BTN } from "../spec/spec.ts";

// ---------------------------------------------------------------------------
// Frame driver (wired by stats-main.tsx)
// ---------------------------------------------------------------------------

const COUNT_FRAMES = 75;
const BAR_ANIM_FRAMES = 26;
const BAR_STAGGER_FRAMES = 4;
const SYSTEMS_REVEAL_FRAMES = 12;
const SYSTEMS_STAGGER_FRAMES = 5;
const SYSTEMS_MAX_FRAMES = SYSTEMS_REVEAL_FRAMES + SYSTEMS_STAGGER_FRAMES * 3;
const [frameN, setFrameN] = createSignal(0);
const [tab, setTab] = createSignal(0);
const [systemsFrame, setSystemsFrame] = createSignal(0);
let prevButtons = 0;

/** Once per frame, BEFORE the engine's own handler (stats-main wraps frame). */
export function statsFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (pressed & BTN.RIGHT) {
    setTab(1);
    setSystemsFrame(0);
  }
  if (pressed & BTN.LEFT) setTab(0);
  if (frameN() < COUNT_FRAMES) setFrameN(frameN() + 1); // settles, then silence
  if (tab() === 1 && systemsFrame() < SYSTEMS_MAX_FRAMES) {
    setSystemsFrame(systemsFrame() + 1);
  }
}

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

const BAR_W = 280; // track px — fill animates to pct/100 * BAR_W

const BARS: Bar[] = [
  { label: "CPU", pct: 42, fill: "h-2 w-0 rounded-full bg-gradient-to-r from-blue-500 to-blue-600" },
  { label: "GPU", pct: 71, fill: "h-2 w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600" },
  { label: "RAM", pct: 63, fill: "h-2 w-0 rounded-full bg-gradient-to-r from-amber-500 to-amber-600" },
  { label: "I/O", pct: 28, fill: "h-2 w-0 rounded-full bg-gradient-to-r from-sky-500 to-sky-600" },
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

/** OVERVIEW tab: bars grow from the capped frame signal, not a stack of native
 *  width tweens, so there is no transition from default dark style values. */
function Overview() {
  const fillW = (bar: Bar, i: number) => {
    const local = (frameN() - i * BAR_STAGGER_FRAMES) / BAR_ANIM_FRAMES;
    return easeOutCubic(local) * (bar.pct / 100) * BAR_W;
  };
  return (
    <view class="flex-col gap-1">
      {BARS.map((bar, i) => (
        <view class="flex-row items-center gap-2">
          <view class="w-9 flex-row justify-end">
            <text class="text-xs text-slate-600">{bar.label}</text>
          </view>
          <view class="w-[280] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
            <view class={bar.fill} style={{ width: fillW(bar, i) }} />
          </view>
          <text class="text-xs text-slate-500">{bar.pct + "%"}</text>
        </view>
      ))}
    </view>
  );
}

/** SYSTEMS tab: status board. Rows appear one after another with short delays;
 *  opacity starts at 0, so there is no visible flash from default gray. */
function Systems() {
  const rowT = (i: number) => easeOutCubic((systemsFrame() - i * SYSTEMS_STAGGER_FRAMES) / SYSTEMS_REVEAL_FRAMES);
  return (
    <view class="flex-col gap-1">
      {SYSTEMS.map((sys, i) => (
        <view
          class="flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-white border-slate-200"
          style={{ opacity: rowT(i), translateY: (1 - rowT(i)) * 8 }}
        >
          <view class="flex-row items-center gap-2">
            <view class={sys.led} />
            <text class="text-xs text-slate-700 tracking-wide">{sys.name}</text>
          </view>
          <text class={sys.statusCls}>{sys.status}</text>
        </view>
      ))}
    </view>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Stats() {
  // Count-up: eased share of the capped frame counter — pure per-frame math,
  // silent once frameN stops at COUNT_FRAMES.
  const t = createMemo(() => {
    const x = Math.min(1, frameN() / COUNT_FRAMES);
    return easeOutCubic(x);
  });

  return (
    <view class="flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <view class="flex-row items-end justify-between">
        <view class="flex-col">
          <text class="text-xs text-emerald-600 tracking-wide">LIVE TELEMETRY</text>
          <text class="text-2xl text-slate-950 font-bold">Mission Control</text>
        </view>
        <view class="flex-row gap-2">
          <view
            class={
              tab() === 0
                ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150"
                : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"
            }
          >
            <text
              class={
                tab() === 0
                  ? "text-xs text-white font-bold tracking-wide"
                  : "text-xs text-slate-500 tracking-wide"
              }
            >
              OVERVIEW
            </text>
          </view>
          <view
            class={
              tab() === 1
                ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150"
                : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"
            }
          >
            <text
              class={
                tab() === 1
                  ? "text-xs text-white font-bold tracking-wide"
                  : "text-xs text-slate-500 tracking-wide"
              }
            >
              SYSTEMS
            </text>
          </view>
        </view>
      </view>

      <view class="flex-row gap-3">
        {STATS.map((stat) => (
          <view class="flex-1 flex-col gap-1 p-2 rounded-xl shadow-md bg-white border-slate-200">
            <text class="text-xs text-slate-500 tracking-wide">{stat.label}</text>
            <view class="flex-row items-end gap-1">
              <text class={stat.valueCls}>{fmt(Math.round(stat.target * t()))}</text>
              <text class="text-xs text-emerald-600">{stat.delta}</text>
            </view>
          </view>
        ))}
      </view>

      <view class="grow flex-col">
        <Show when={tab() === 0}>
          <Overview />
        </Show>
        <Show when={tab() === 1}>
          <Systems />
        </Show>
      </view>

      <text class="text-xs text-slate-500">LEFT / RIGHT switch tab</text>
    </view>
  );
}
