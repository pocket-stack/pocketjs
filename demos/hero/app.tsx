// Demo app + the jsx.d.ts typecheck fixture (bunx tsc --noEmit must pass).
// Uses all three public primitives, class literals, a dynamic style object,
// focus + onPress, and a signal in text — the exact surface phase v1 supports.

import { Image, Text, View, animate, createMemo, createSignal, onMount, Show, type NodeMirror } from "psp-ui";

const SPINNER_FRAME_STEP = 3;
const SPINNER_FRAMES = [
  "spinner-00.svg",
  "spinner-01.svg",
  "spinner-02.svg",
  "spinner-03.svg",
  "spinner-04.svg",
  "spinner-05.svg",
  "spinner-06.svg",
  "spinner-07.svg",
];

const [spinnerFrame, setSpinnerFrame] = createSignal(0);

export function heroFrame(): void {
  setSpinnerFrame((spinnerFrame() + 1) % (SPINNER_FRAMES.length * SPINNER_FRAME_STEP));
}

function Stat(props: { label: string; value: string; cls: string }) {
  return (
    <View class="flex-col items-end">
      <Text class={props.cls}>{props.value}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">{props.label}</Text>
    </View>
  );
}

export default function Hero() {
  const [count, setCount] = createSignal(0);
  const spinnerSrc = createMemo(() => {
    const i = Math.floor(spinnerFrame() / SPINNER_FRAME_STEP) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[i];
  });
  let underline: NodeMirror | undefined;
  onMount(() => {
    // Underline sweeps in once on mount — native tween, zero steady-state JS.
    if (underline) animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
  });
  return (
    <View class="w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-center justify-between">
        <View class="flex-row items-center gap-3">
          <Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
          <View class="flex-col">
            <Text class="text-base text-slate-950 font-bold tracking-wide">psp-ui</Text>
            <Text class="text-xs text-slate-500 tracking-wide">SOLID + RUST + SCEGU</Text>
          </View>
        </View>
        <View class="flex-row gap-4">
          <Stat label="FPS" value="60" cls="text-lg text-emerald-600 font-bold" />
          <Stat label="NODES" value="42" cls="text-lg text-blue-600 font-bold" />
          <Stat label="DRAWS" value="9" cls="text-lg text-amber-600 font-bold" />
        </View>
      </View>

      <View class="flex-col gap-2">
        <Text class="text-xs text-blue-600 tracking-wide">ONE RUST CORE · ONE JSX APP</Text>
        <View class="flex-row items-center justify-between">
          <Text class="text-4xl text-slate-950 font-bold">JSX at 60 FPS.</Text>
          <Image class="w-10 h-10" src={spinnerSrc()} />
        </View>
        <View
          ref={underline}
          class="h-1 w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
          style={{ translateX: count() * 2 }}
        />
        <Text class="text-sm text-slate-600">
          Flexbox, springs and baked type — running on a 2005 handheld.
        </Text>
      </View>

      <View class="flex-row items-center gap-4">
        <View
          class="px-4 py-2 rounded-xl shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
          focusable
          onPress={() => setCount(count() + 1)}
        >
          <Text class="text-base text-white font-bold">Press Circle</Text>
        </View>
        <Text class="text-sm text-slate-600">Count: {count()}</Text>
        <Show when={count() > 3}>
          <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
        </Show>
      </View>
    </View>
  );
}
