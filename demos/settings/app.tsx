// demos/settings/app.tsx — "settings menu" showcase: a grouped list of system
// toggles (spring-sliding pill knobs — first demo use of `rounded-full`,
// build-time-fixed w/h per DESIGN.md so the compiler can bake the exact
// corner radius), a brightness control CIRCLE cycles through 5 steps (a
// direct style width/translate update, and a row of theme swatches whose
// SELECTED state (a persistent signal) drives one small design-token table:
// page wash, header text, focus colors, switches, slider, and theme panel.
//
// No custom frame wiring: every interaction is UP/DOWN navigation + CIRCLE
// press, entirely covered by the engine's default input pass (src/input.ts)
// — unlike continuous demos, this entry needs no frame hook.

import { Show, Text, View, type NodeMirror } from "psp-ui/components";
import { animate } from "psp-ui/animation";
import { createEffect, createSignal } from "psp-ui/reactivity";

type ThemeName = "indigo" | "emerald" | "amber" | "rose";

interface ThemeOption {
  name: ThemeName;
  pageCls: string;
  eyebrowCls: string;
  titleCls: string;
  optionsCls: string;
  rowCls: string;
  rowLabelCls: string;
  switchOnCls: string;
  switchOffCls: string;
  knobCls: string;
  sliderTrackCls: string;
  sliderFillCls: string;
  sliderThumbCls: string;
  valueCls: string;
  panelCls: string;
  footerCls: string;
  swatchCls: string;
  selectedCls: string;
}

const THEMES: ThemeOption[] = [
  {
    name: "indigo",
    pageCls: "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-indigo-50 to-slate-100",
    eyebrowCls: "text-xs text-indigo-600 tracking-wide",
    titleCls: "text-2xl text-indigo-700 font-bold",
    optionsCls: "text-xs text-indigo-700",
    rowCls: "flex-row items-center justify-between px-2 py-1 bg-white border-indigo-200 rounded-lg shadow focus:bg-indigo-50 focus:border-indigo-500 transition-colors duration-150",
    rowLabelCls: "text-sm text-indigo-950",
    switchOnCls: "w-9 h-5 rounded-full bg-gradient-to-r from-indigo-500 to-indigo-600 border-indigo-500 shadow flex-row items-center",
    switchOffCls: "w-9 h-5 rounded-full bg-gradient-to-r from-indigo-100 to-indigo-200 border-indigo-200 shadow flex-row items-center",
    knobCls: "w-4 h-4 rounded-full bg-white border-indigo-200 shadow-md m-[2] translate-x-[0.5]",
    sliderTrackCls: "relative w-[120] h-3 rounded-full bg-indigo-100 border-indigo-200 shadow overflow-hidden",
    sliderFillCls: "absolute left-0 top-0 h-3 w-[72] rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600",
    sliderThumbCls: "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-indigo-500 shadow-md translate-x-[64]",
    valueCls: "text-xs text-indigo-700",
    panelCls: "flex-col gap-2 px-2 py-2 bg-white border-indigo-200 rounded-xl shadow-md",
    footerCls: "text-xs text-indigo-700",
    swatchCls: "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-indigo-500 to-indigo-700 border-indigo-300 focus:border-indigo-950 transition-colors duration-150 items-center justify-center",
    selectedCls: "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-indigo-500 to-indigo-700 border-indigo-950 transition-colors duration-150 items-center justify-center",
  },
  {
    name: "emerald",
    pageCls: "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-emerald-50 to-slate-100",
    eyebrowCls: "text-xs text-emerald-600 tracking-wide",
    titleCls: "text-2xl text-emerald-700 font-bold",
    optionsCls: "text-xs text-emerald-700",
    rowCls: "flex-row items-center justify-between px-2 py-1 bg-white border-emerald-200 rounded-lg shadow focus:bg-emerald-50 focus:border-emerald-500 transition-colors duration-150",
    rowLabelCls: "text-sm text-emerald-950",
    switchOnCls: "w-9 h-5 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 border-emerald-500 shadow flex-row items-center",
    switchOffCls: "w-9 h-5 rounded-full bg-gradient-to-r from-emerald-100 to-emerald-200 border-emerald-200 shadow flex-row items-center",
    knobCls: "w-4 h-4 rounded-full bg-white border-emerald-200 shadow-md m-[2] translate-x-[0.5]",
    sliderTrackCls: "relative w-[120] h-3 rounded-full bg-emerald-100 border-emerald-200 shadow overflow-hidden",
    sliderFillCls: "absolute left-0 top-0 h-3 w-[72] rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600",
    sliderThumbCls: "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-emerald-500 shadow-md translate-x-[64]",
    valueCls: "text-xs text-emerald-700",
    panelCls: "flex-col gap-2 px-2 py-2 bg-white border-emerald-200 rounded-xl shadow-md",
    footerCls: "text-xs text-emerald-700",
    swatchCls: "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-emerald-400 to-emerald-600 border-emerald-300 focus:border-emerald-950 transition-colors duration-150 items-center justify-center",
    selectedCls: "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-emerald-400 to-emerald-600 border-emerald-950 transition-colors duration-150 items-center justify-center",
  },
  {
    name: "amber",
    pageCls: "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-amber-50 to-slate-100",
    eyebrowCls: "text-xs text-amber-600 tracking-wide",
    titleCls: "text-2xl text-amber-700 font-bold",
    optionsCls: "text-xs text-amber-700",
    rowCls: "flex-row items-center justify-between px-2 py-1 bg-white border-amber-200 rounded-lg shadow focus:bg-amber-50 focus:border-amber-500 transition-colors duration-150",
    rowLabelCls: "text-sm text-amber-950",
    switchOnCls: "w-9 h-5 rounded-full bg-gradient-to-r from-amber-400 to-amber-600 border-amber-500 shadow flex-row items-center",
    switchOffCls: "w-9 h-5 rounded-full bg-gradient-to-r from-amber-100 to-amber-200 border-amber-200 shadow flex-row items-center",
    knobCls: "w-4 h-4 rounded-full bg-white border-amber-200 shadow-md m-[2] translate-x-[0.5]",
    sliderTrackCls: "relative w-[120] h-3 rounded-full bg-amber-100 border-amber-200 shadow overflow-hidden",
    sliderFillCls: "absolute left-0 top-0 h-3 w-[72] rounded-full bg-gradient-to-r from-amber-400 to-amber-600",
    sliderThumbCls: "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-amber-500 shadow-md translate-x-[64]",
    valueCls: "text-xs text-amber-700",
    panelCls: "flex-col gap-2 px-2 py-2 bg-white border-amber-200 rounded-xl shadow-md",
    footerCls: "text-xs text-amber-700",
    swatchCls: "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-amber-400 to-amber-600 border-amber-300 focus:border-amber-950 transition-colors duration-150 items-center justify-center",
    selectedCls: "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-amber-400 to-amber-600 border-amber-950 transition-colors duration-150 items-center justify-center",
  },
  {
    name: "rose",
    pageCls: "flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-rose-50 to-slate-100",
    eyebrowCls: "text-xs text-rose-600 tracking-wide",
    titleCls: "text-2xl text-rose-700 font-bold",
    optionsCls: "text-xs text-rose-700",
    rowCls: "flex-row items-center justify-between px-2 py-1 bg-white border-rose-200 rounded-lg shadow focus:bg-rose-50 focus:border-rose-500 transition-colors duration-150",
    rowLabelCls: "text-sm text-rose-950",
    switchOnCls: "w-9 h-5 rounded-full bg-gradient-to-r from-rose-400 to-rose-600 border-rose-500 shadow flex-row items-center",
    switchOffCls: "w-9 h-5 rounded-full bg-gradient-to-r from-rose-100 to-rose-200 border-rose-200 shadow flex-row items-center",
    knobCls: "w-4 h-4 rounded-full bg-white border-rose-200 shadow-md m-[2] translate-x-[0.5]",
    sliderTrackCls: "relative w-[120] h-3 rounded-full bg-rose-100 border-rose-200 shadow overflow-hidden",
    sliderFillCls: "absolute left-0 top-0 h-3 w-[72] rounded-full bg-gradient-to-r from-rose-400 to-rose-600",
    sliderThumbCls: "absolute left-0 top-[2] w-2 h-2 rounded-full bg-white border-rose-500 shadow-md translate-x-[64]",
    valueCls: "text-xs text-rose-700",
    panelCls: "flex-col gap-2 px-2 py-2 bg-white border-rose-200 rounded-xl shadow-md",
    footerCls: "text-xs text-rose-700",
    swatchCls: "w-8 h-6 rounded-lg shadow bg-gradient-to-b from-rose-400 to-rose-600 border-rose-300 focus:border-rose-950 transition-colors duration-150 items-center justify-center",
    selectedCls: "w-8 h-6 rounded-lg shadow-md bg-gradient-to-b from-rose-400 to-rose-600 border-rose-950 transition-colors duration-150 items-center justify-center",
  },
];

function themeByName(name: ThemeName): ThemeOption {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}

// ---------------------------------------------------------------------------
// Toggle row
// ---------------------------------------------------------------------------

function Toggle(props: { label: string; value: boolean; theme: ThemeOption; onToggle: () => void }) {
  let knob: NodeMirror | undefined;
  let initialized = false;
  createEffect(() => {
    if (!knob) return;
    const x = props.value ? 15.5 : 0.5;
    animate(knob, "translateX", x, {
      dur: initialized ? 160 : 1,
      easing: "out",
    });
    initialized = true;
  });
  return (
    <View
      class={props.theme.rowCls}
      focusable
      onPress={props.onToggle}
    >
      <Text class={props.theme.rowLabelCls}>{props.label}</Text>
      <View
        class={
          props.value
            ? props.theme.switchOnCls
            : props.theme.switchOffCls
        }
      >
        <View
          ref={knob}
          class={props.theme.knobCls}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Brightness (CIRCLE cycles 1..5, wraps)
// ---------------------------------------------------------------------------

const BRIGHTNESS_TRACK_W = 120;

function Brightness(props: { theme: ThemeOption }) {
  const [level, setLevel] = createSignal(3);
  const fillW = () => (level() / 5) * BRIGHTNESS_TRACK_W;
  return (
    <View
      class={props.theme.rowCls}
      focusable
      onPress={() => setLevel(level() >= 5 ? 1 : level() + 1)}
    >
      <Text class={props.theme.rowLabelCls}>BRIGHTNESS</Text>
      <View class="flex-row items-center gap-2">
        <View class={props.theme.sliderTrackCls}>
          <View class={props.theme.sliderFillCls} style={{ width: fillW() }} />
          <View class={props.theme.sliderThumbCls} style={{ translateX: fillW() - 8 }} />
        </View>
        <Text class={props.theme.valueCls}>{level()}/5</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Theme swatches
// ---------------------------------------------------------------------------

function ThemeRow(props: { value: ThemeName; theme: ThemeOption; onPick: (t: ThemeName) => void }) {
  return (
    <View class={props.theme.panelCls}>
      <Text class={props.theme.rowLabelCls}>THEME</Text>
      <View class="flex-row gap-2">
        {THEMES.map((t) => (
          <View
            class={props.value === t.name ? t.selectedCls : t.swatchCls}
            focusable
            onPress={() => props.onPick(t.name)}
          >
            <Show when={props.value === t.name}>
              <View class="w-2 h-2 rounded-full bg-white shadow" />
            </Show>
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Settings() {
  const [sfx, setSfx] = createSignal(true);
  const [vibration, setVibration] = createSignal(false);
  const [theme, setTheme] = createSignal<ThemeName>("indigo");
  const currentTheme = () => themeByName(theme());

  return (
    <View class={currentTheme().pageCls}>
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class={currentTheme().eyebrowCls}>PSP-UI SHOWCASE</Text>
          <Text class={currentTheme().titleCls}>Settings</Text>
        </View>
        <Text class={currentTheme().optionsCls}>4 OPTIONS</Text>
      </View>

      <View class="flex-col gap-2">
        <Toggle label="SOUND EFFECTS" value={sfx()} theme={currentTheme()} onToggle={() => setSfx(!sfx())} />
        <Toggle label="VIBRATION" value={vibration()} theme={currentTheme()} onToggle={() => setVibration(!vibration())} />
        <Brightness theme={currentTheme()} />
        <ThemeRow value={theme()} theme={currentTheme()} onPick={setTheme} />
      </View>

      <Text class={currentTheme().footerCls}>UP / DOWN move focus · CIRCLE toggle / cycle / select</Text>
    </View>
  );
}
