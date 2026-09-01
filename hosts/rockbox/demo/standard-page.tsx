import { Show, createSignal, onMount } from "solid-js";
import { animate } from "@pocketjs/framework/animation";
import { TICKS_PER_SECOND } from "@pocketjs/framework/clock";
import {
  Image,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { createSpriteAnimation } from "@pocketjs/framework/lifecycle";
import { frameworkName } from "@pocketjs/framework/solid";

const SPINNER_FRAMES = [
  "spinner-00.svg",
  "spinner-01.svg",
  "spinner-02.svg",
  "spinner-03.svg",
  "spinner-04.svg",
  "spinner-05.svg",
  "spinner-06.svg",
  "spinner-07.svg",
] as const;

function Stat(props: { label: string; value: string; cls: string }) {
  return (
    <View class="flex-col items-end">
      <Text class={props.cls}>{props.value}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">{props.label}</Text>
    </View>
  );
}

/** The official PocketJS Hero demo, fixed to the iPod's 320x240 viewport. */
export default function StandardPage() {
  const [count, setCount] = createSignal(0);
  const spinner = createSpriteAnimation(SPINNER_FRAMES, { frameStep: 3 });
  let underline: NodeMirror | undefined;

  onMount(() => {
    if (underline) animate(underline, "width", 196, {
      dur: 700,
      easing: "out",
      delay: 150,
    });
  });

  return (
    <View class="w-[320] h-[240] flex-col justify-between p-[16] bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-center justify-between">
        <View class="flex-row items-center gap-[8]">
          <Image class="w-[34] h-[34] rounded-[8] shadow" src="logo.png" />
          <View class="flex-col">
            <Text class="text-base text-slate-950 font-bold tracking-wide">PocketJS</Text>
            <Text class="text-xs text-slate-500">{frameworkName()} + QUICKJS</Text>
          </View>
        </View>
        <View class="flex-row gap-[10]">
          <Stat label="FPS" value={String(TICKS_PER_SECOND)} cls="text-base text-emerald-600 font-bold" />
          <Stat label="NODES" value="42" cls="text-base text-blue-600 font-bold" />
          <Stat label="DRAWS" value="9" cls="text-base text-amber-600 font-bold" />
        </View>
      </View>

      <View class="flex-col gap-[5]">
        <Text class="text-xs text-blue-600 tracking-wide">ONE RUST CORE · ONE JSX APP</Text>
        <View class="flex-row items-center justify-between">
          <Text class="text-2xl text-slate-950 font-bold">JSX at 60 FPS.</Text>
          <Image class="w-[34] h-[34]" src={spinner()} />
        </View>
        <View
          ref={underline}
          class="h-[3] w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
          style={{ translateX: count() * 2 }}
        />
        <Text class="text-sm text-slate-600">Flexbox, springs and baked type on iPod classic.</Text>
      </View>

      <View class="flex-row items-center gap-[12]">
        <View
          class="px-[12] py-[6] rounded-[10] shadow bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
          focusable
          onPress={() => setCount((value) => value + 1)}
        >
          <Text class="text-sm text-white font-bold">Press Select</Text>
        </View>
        <Text class="text-sm text-slate-600">Count: {count()}</Text>
        <Show when={count() > 3}>
          <Text class="text-xs text-emerald-600">Reactive.</Text>
        </Show>
      </View>
    </View>
  );
}
