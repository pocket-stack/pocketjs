import { computed, defineVaporComponent, ref } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { animate } from "@pocketjs/framework/vue-vapor/animation";
import { onButtonPress, onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN } from "@pocketjs/framework/vue-vapor/input";

const COUNT_FRAMES = 75;
const COUNT_TEXT_STEP = 8;
const BAR_ANIM_FRAMES = 26;
const BAR_STAGGER_FRAMES = 4;
const SYSTEMS_REVEAL_FRAMES = 12;
const SYSTEMS_STAGGER_FRAMES = 5;
const SYSTEMS_MAX_FRAMES = SYSTEMS_REVEAL_FRAMES + SYSTEMS_STAGGER_FRAMES * 3;

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

const Overview = defineVaporComponent(() => {
  const fills: Array<NodeMirror | undefined> = [];
  return (
    <View class="flex-col gap-1">
      {BARS.map((bar, i) => (
        <View class="flex-row items-center gap-2">
          <View class="w-9 flex-row justify-end">
            <Text class="text-xs text-slate-600">{bar.label}</Text>
          </View>
          <View class="w-[280] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
            <View
              nodeRef={(node: NodeMirror | null) => {
                fills[i] = node ?? undefined;
                const fill = fills[i];
                if (!fill) return;
                const scale = barScale(bar);
                const delay = i * BAR_STAGGER_MS;
                animate(fill, "scaleX", scale, { dur: BAR_ANIM_MS, delay, easing: "out" });
                animate(fill, "translateX", barFillOffset(scale), { dur: BAR_ANIM_MS, delay, easing: "out" });
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
});

const Systems = defineVaporComponent((props: { frame: number }) => {
  const rowT = (i: number) => easeOutCubic((props.frame - i * SYSTEMS_STAGGER_FRAMES) / SYSTEMS_REVEAL_FRAMES);
  return (
    <View class="flex-col gap-1">
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
});

export default function Stats() {
  const frameN = ref(0);
  const tab = ref(0);
  const systemsFrame = ref(0);

  onButtonPress(BTN.RIGHT, () => {
    tab.value = 1;
    systemsFrame.value = 0;
  });
  onButtonPress(BTN.LEFT, () => {
    tab.value = 0;
  });
  onFrame(() => {
    if (frameN.value < COUNT_FRAMES) frameN.value++;
    if (tab.value === 1 && systemsFrame.value < SYSTEMS_MAX_FRAMES) systemsFrame.value++;
  });

  const t = computed(() => {
    const f = frameN.value;
    const visibleFrame = f >= COUNT_FRAMES ? COUNT_FRAMES : Math.floor(f / COUNT_TEXT_STEP) * COUNT_TEXT_STEP;
    return easeOutCubic(Math.min(1, visibleFrame / COUNT_FRAMES));
  });

  return (
    <View class="flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-emerald-600 tracking-wide">LIVE TELEMETRY</Text>
          <Text class="text-2xl text-slate-950 font-bold">Mission Control</Text>
        </View>
        <View class="flex-row gap-2">
          <View class={tab.value === 0 ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150" : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"}>
            <Text class={tab.value === 0 ? "text-xs text-white font-bold tracking-wide" : "text-xs text-slate-500 tracking-wide"}>OVERVIEW</Text>
          </View>
          <View class={tab.value === 1 ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150" : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"}>
            <Text class={tab.value === 1 ? "text-xs text-white font-bold tracking-wide" : "text-xs text-slate-500 tracking-wide"}>SYSTEMS</Text>
          </View>
        </View>
      </View>

      <View class="flex-row gap-3">
        {STATS.map((stat) => (
          <View class="flex-1 flex-col gap-1 p-2 rounded-xl shadow-md bg-white border-slate-200">
            <Text class="text-xs text-slate-500 tracking-wide">{stat.label}</Text>
            <View class="flex-row items-end gap-1">
              <Text class={stat.valueCls}>{fmt(Math.round(stat.target * t.value))}</Text>
              <Text class="text-xs text-emerald-600">{stat.delta}</Text>
            </View>
          </View>
        ))}
      </View>

      <View class="grow flex-col">
        {tab.value === 0 ? <Overview /> : null}
        {tab.value === 1 ? <Systems frame={systemsFrame.value} /> : null}
      </View>

      <Text class="text-xs text-slate-500">LEFT / RIGHT switch tab</Text>
    </View>
  );
}
