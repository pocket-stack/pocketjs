import { useLayoutEffect, useMemo, useRef, useState } from "octane";
import { Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { animate, jump } from "@pocketjs/framework/octane/animation";
import { useButtonPress, useFrame } from "@pocketjs/framework/octane/lifecycle";
import { BTN } from "@pocketjs/framework/octane/input";
import { setTextContent } from "@pocketjs/framework/octane";

const COUNT_FRAMES = 75;
const COUNT_TEXT_STEP = 8;
const BAR_ANIM_FRAMES = 26;
const BAR_STAGGER_FRAMES = 4;
const SYSTEMS_REVEAL_FRAMES = 12;
const SYSTEMS_STAGGER_FRAMES = 5;

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
  pct: number;
  fill: string;
}

const BAR_W = 280;
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

function barScale(bar: Bar): number {
  return bar.pct / 100;
}

function barFillOffset(scale: number): number {
  return -(BAR_W * (1 - scale)) / 2;
}

const Overview = () => {
  // scaleX/translateX are native tweens — they must stay OUT of the fills'
  // `style` prop (re-applied styles cancel running animations). Initial
  // values are jumped once in the pre-paint mount effect, then animated.
  const fills = useRef<Array<NodeMirror | null>>([]);

  useLayoutEffect(() => {
    BARS.forEach((bar, i) => {
      const fill = fills.current[i];
      if (!fill) return;
      const scale = barScale(bar);
      const delay = i * BAR_STAGGER_MS;
      jump(fill, "scaleX", 0);
      jump(fill, "translateX", barFillOffset(0));
      animate(fill, "scaleX", scale, { dur: BAR_ANIM_MS, delay, easing: "out" });
      animate(fill, "translateX", barFillOffset(scale), { dur: BAR_ANIM_MS, delay, easing: "out" });
    });
  }, []);

  return (
    <View class="flex-col gap-1">
      {BARS.map((bar, i) => (
        <View key={bar.label} class="flex-row items-center gap-2">
          <View class="w-9 flex-row justify-end">
            <Text class="text-xs text-slate-600">{bar.label}</Text>
          </View>
          <View class="w-[280] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
            <View
              nodeRef={(node: NodeMirror | null) => {
                fills.current[i] = node;
              }}
              class={bar.fill}
            />
          </View>
          <Text class="text-xs text-slate-500">{bar.pct + "%"}</Text>
        </View>
      ))}
    </View>
  );
};

// Per-frame counters live in leaf components so each tick re-renders a small
// subtree, not the whole screen (the same pattern as the music port): the
// count-up phase would otherwise re-render every node for 75 frames and the
// engine-arena churn exhausts the PSP's fixed arena mid-window.

const StatTiles = () => {
  // The count-up drives the three value texts imperatively through
  // setTextContent — the text-shaped sibling of animate()/jump(). Committing
  // the stepped value as state instead would re-prepare the whole root on
  // every step: ~10 multi-frame stalls per count-up on the PSP. Here a step
  // costs three replaceText host ops and the component never re-renders.
  const raw = useRef(0);
  const stepped = useRef(0);
  const values = useRef<(NodeMirror | null)[]>([]);
  useFrame(() => {
    if (raw.current >= COUNT_FRAMES) return;
    raw.current += 1;
    const next =
      raw.current >= COUNT_FRAMES
        ? COUNT_FRAMES
        : Math.floor(raw.current / COUNT_TEXT_STEP) * COUNT_TEXT_STEP;
    if (next === stepped.current) return;
    stepped.current = next;
    const t = easeOutCubic(Math.min(1, next / COUNT_FRAMES));
    for (let i = 0; i < STATS.length; i++) {
      const node = values.current[i];
      if (node) setTextContent(node, fmt(Math.round(STATS[i].target * t)));
    }
  });
  return (
    <View class="flex-row gap-3">
      {STATS.map((stat, i) => (
        <View key={stat.label} class="flex-1 flex-col gap-1 p-2 rounded-xl shadow-md bg-white border-slate-200">
          <Text class="text-xs text-slate-500 tracking-wide">{stat.label}</Text>
          <View class="flex-row items-end gap-1">
            <Text
              nodeRef={(node: NodeMirror | null) => {
                values.current[i] = node;
              }}
              class={stat.valueCls}
            >
              {fmt(0)}
            </Text>
            <Text class="text-xs text-emerald-600">{stat.delta}</Text>
          </View>
        </View>
      ))}
    </View>
  );
};

const Systems = () => {
  // Staggered entrance as native tweens: one animate() pair per row on
  // mount, zero re-renders. A per-frame state tick here replayed the whole
  // root for every frame of the reveal on the PSP.
  const rows = useRef<(NodeMirror | null)[]>([]);
  useLayoutEffect(() => {
    const dur = (SYSTEMS_REVEAL_FRAMES * 1000) / 60;
    for (let i = 0; i < rows.current.length; i++) {
      const node = rows.current[i];
      if (!node) continue;
      const delay = (i * SYSTEMS_STAGGER_FRAMES * 1000) / 60;
      animate(node, "opacity", 1, { dur, delay, easing: "out" });
      animate(node, "translateY", 0, { dur, delay, easing: "out" });
    }
  }, []);
  return (
    <View class="flex-col gap-1">
      {SYSTEMS.map((sys, i) => (
        <View
          key={sys.name}
          nodeRef={(node: NodeMirror | null) => {
            rows.current[i] = node;
          }}
          class="flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-white border-slate-200"
          style={{ opacity: 0, translateY: 8 }}
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
};

export default function Stats() {
  const [tab, setTab] = useState(0);
  // Bumped on every RIGHT press: <Systems> is keyed on it, so re-entering the
  // tab remounts the reveal from frame 0, matching the other variants.
  const [epoch, setEpoch] = useState(0);

  useButtonPress(BTN.RIGHT, () => {
    setTab(1);
    setEpoch((e) => e + 1);
  });
  useButtonPress(BTN.LEFT, () => {
    setTab(0);
  });

  return (
    <View class="flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-emerald-600 tracking-wide">LIVE TELEMETRY</Text>
          <Text class="text-2xl text-slate-950 font-bold">Mission Control</Text>
        </View>
        <View class="flex-row gap-2">
          <View class={tab === 0 ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150" : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"}>
            <Text class={tab === 0 ? "text-xs text-white font-bold tracking-wide" : "text-xs text-slate-500 tracking-wide"}>OVERVIEW</Text>
          </View>
          <View class={tab === 1 ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150" : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"}>
            <Text class={tab === 1 ? "text-xs text-white font-bold tracking-wide" : "text-xs text-slate-500 tracking-wide"}>SYSTEMS</Text>
          </View>
        </View>
      </View>

      <StatTiles />

      <View class="grow flex-col">
        {tab === 0 ? <Overview /> : null}
        {tab === 1 ? <Systems key={epoch} /> : null}
      </View>

      <Text class="text-xs text-slate-500">LEFT / RIGHT switch tab</Text>
    </View>
  );
}
