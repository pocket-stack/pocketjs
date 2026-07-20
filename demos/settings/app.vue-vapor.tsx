import { ref } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { animate } from "@pocketjs/framework/vue-vapor/animation";

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
    sliderFillCls: "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600",
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
    sliderFillCls: "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600",
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
    sliderFillCls: "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-amber-400 to-amber-600",
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
    sliderFillCls: "absolute left-0 top-0 h-3 w-[120] rounded-full bg-gradient-to-r from-rose-400 to-rose-600",
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

function propValue<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function callbackProp<T extends (...args: any[]) => unknown>(value: T | (() => T)): T {
  if (typeof value !== "function") return value;
  if (value.length === 0) {
    const resolved = (value as () => T)();
    if (typeof resolved === "function") return resolved;
  }
  return value as T;
}

const Toggle = (
  props: { label: string; value: boolean; themeName: ThemeName; onToggle: () => void },
) => {
  let knob: NodeMirror | undefined;
  const label = () => propValue(props.label as string | (() => string));
  const value = () => propValue(props.value as boolean | (() => boolean));
  const current = ref(value());
  const themeName = () => propValue(props.themeName as ThemeName | (() => ThemeName));
  const onToggle = () => callbackProp(props.onToggle as (() => void) | (() => () => void));
  const palette = () => themeByName(themeName());
  const moveKnob = (dur: number) => {
    if (!knob) return;
    animate(knob, "translateX", current.value ? 15.5 : 0.5, { dur, easing: "out" });
  };
  return (
    <View
      class={palette().rowCls}
      focusable
      onPress={() => {
        current.value = !current.value;
        moveKnob(160);
        onToggle()();
      }}
    >
      <Text class={palette().rowLabelCls}>{label()}</Text>
      <View class={current.value ? palette().switchOnCls : palette().switchOffCls}>
        <View
          nodeRef={(node: NodeMirror | null) => {
            knob = node ?? undefined;
            moveKnob(1);
          }}
          class={palette().knobCls}
          style={{ translateX: current.value ? 15.5 : 0.5 }}
        />
      </View>
    </View>
  );
};

const BRIGHTNESS_TRACK_W = 120;
const BRIGHTNESS_INITIAL_LEVEL = 3;
const BRIGHTNESS_THUMB_W = 8;
const brightnessWidth = (level: number): number => (level / 5) * BRIGHTNESS_TRACK_W;
const brightnessScale = (level: number): number => level / 5;
const brightnessFillOffset = (level: number): number => -(BRIGHTNESS_TRACK_W * (1 - brightnessScale(level))) / 2;

const Brightness = (props: { themeName: ThemeName }) => {
  const level = ref(BRIGHTNESS_INITIAL_LEVEL);
  const themeName = () => propValue(props.themeName as ThemeName | (() => ThemeName));
  const palette = () => themeByName(themeName());
  let fill: NodeMirror | undefined;
  let thumb: NodeMirror | undefined;
  const moveLevel = (dur: number) => {
    const target = brightnessWidth(level.value);
    const scale = brightnessScale(level.value);
    const fillOffset = brightnessFillOffset(level.value);
    if (!fill || !thumb) return;
    animate(fill, "scaleX", scale, { dur, easing: "out" });
    animate(fill, "translateX", fillOffset, { dur, easing: "out" });
    animate(thumb, "translateX", target - BRIGHTNESS_THUMB_W, { dur, easing: "out" });
  };

  return (
    <View
      class={palette().rowCls}
      focusable
      onPress={() => {
        level.value = level.value >= 5 ? 1 : level.value + 1;
        moveLevel(150);
      }}
    >
      <Text class={palette().rowLabelCls}>BRIGHTNESS</Text>
      <View class="flex-row items-center gap-2">
        <View class={palette().sliderTrackCls}>
          <View
            nodeRef={(node: NodeMirror | null) => {
              fill = node ?? undefined;
              moveLevel(1);
            }}
            class={palette().sliderFillCls}
            style={{ scaleX: brightnessScale(BRIGHTNESS_INITIAL_LEVEL), translateX: brightnessFillOffset(BRIGHTNESS_INITIAL_LEVEL) }}
          />
          <View
            nodeRef={(node: NodeMirror | null) => {
              thumb = node ?? undefined;
              moveLevel(1);
            }}
            class={palette().sliderThumbCls}
            style={{ translateX: brightnessWidth(BRIGHTNESS_INITIAL_LEVEL) - BRIGHTNESS_THUMB_W }}
          />
        </View>
        <View class="w-9 flex-row justify-end">
          <Text class={palette().valueCls}>{level.value}/5</Text>
        </View>
      </View>
    </View>
  );
};

const ThemeRow = (
  props: { value: ThemeName; themeName: ThemeName; onPick: (t: ThemeName) => void },
) => {
  const value = () => propValue(props.value as ThemeName | (() => ThemeName));
  const themeName = () => propValue(props.themeName as ThemeName | (() => ThemeName));
  const onPick = () => callbackProp(props.onPick as ((t: ThemeName) => void) | (() => (t: ThemeName) => void));
  const palette = () => themeByName(themeName());
  return (
    <View class={palette().panelCls}>
      <Text class={palette().rowLabelCls}>THEME</Text>
      <View class="flex-row gap-2">
        {THEMES.map((t) => (
          <View class={value() === t.name ? t.selectedCls : t.swatchCls} focusable onPress={() => onPick()(t.name)}>
            {value() === t.name ? <View class="w-2 h-2 rounded-full bg-white shadow" /> : null}
          </View>
        ))}
      </View>
    </View>
  );
};

export default function Settings() {
  const sfx = ref(true);
  const vibration = ref(false);
  const theme = ref<ThemeName>("indigo");
  const currentTheme = () => themeByName(theme.value);

  return (
    <View class={currentTheme().pageCls}>
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class={currentTheme().eyebrowCls}>POCKETJS SHOWCASE</Text>
          <Text class={currentTheme().titleCls}>Settings</Text>
        </View>
        <Text class={currentTheme().optionsCls}>4 OPTIONS</Text>
      </View>

      <View class="flex-col gap-2">
        <Toggle label="SOUND EFFECTS" value={sfx.value} themeName={theme.value} onToggle={() => { sfx.value = !sfx.value; }} />
        <Toggle label="VIBRATION" value={vibration.value} themeName={theme.value} onToggle={() => { vibration.value = !vibration.value; }} />
        <Brightness themeName={theme.value} />
        <ThemeRow value={theme.value} themeName={theme.value} onPick={(next: ThemeName) => { theme.value = next; }} />
      </View>

      <Text class={currentTheme().footerCls}>UP / DOWN move focus - CIRCLE toggle / cycle / select</Text>
    </View>
  );
}
