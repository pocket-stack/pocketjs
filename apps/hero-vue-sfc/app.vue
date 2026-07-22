<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { animate } from "@pocketjs/framework/vue-vapor/animation";
import { createSpriteAnimation } from "@pocketjs/framework/vue-vapor/lifecycle";
import { frameworkName } from "@pocketjs/framework/vue-vapor";

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

const count = ref(0);
const spinnerSrc = createSpriteAnimation(SPINNER_FRAMES, { frameStep: SPINNER_FRAME_STEP });
let underline: NodeMirror | undefined;

function captureUnderline(node: NodeMirror | null): void {
  underline = node ?? undefined;
}

onMounted(() => {
  if (underline) animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
});
</script>

<template>
  <View
    debug-name="HeroScreen"
    class="w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-50 to-slate-100"
  >
    <View debug-name="Header" class="flex-row items-center justify-between">
      <View class="flex-row items-center gap-3">
        <Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
        <View class="flex-col">
          <Text class="text-base text-slate-950 font-bold tracking-wide">PocketJS</Text>
          <Text class="text-xs text-slate-500 tracking-wide">{{ frameworkName() }} + RUST + SCEGU</Text>
        </View>
      </View>
      <View class="flex-row gap-4">
        <View class="flex-col items-end">
          <Text class="text-lg text-emerald-600 font-bold">60</Text>
          <Text class="text-xs text-slate-500 tracking-wide">FPS</Text>
        </View>
        <View class="flex-col items-end">
          <Text class="text-lg text-blue-600 font-bold">42</Text>
          <Text class="text-xs text-slate-500 tracking-wide">NODES</Text>
        </View>
        <View class="flex-col items-end">
          <Text class="text-lg text-amber-600 font-bold">9</Text>
          <Text class="text-xs text-slate-500 tracking-wide">DRAWS</Text>
        </View>
      </View>
    </View>

    <View class="flex-col gap-2">
      <Text class="text-xs text-blue-600 tracking-wide">ONE RUST CORE · ONE JSX APP</Text>
      <View class="flex-row items-center justify-between">
        <Text class="text-4xl text-slate-950 font-bold">JSX at 60 FPS.</Text>
        <Image class="w-10 h-10" :src="spinnerSrc" />
      </View>
      <View
        :node-ref="captureUnderline"
        class="h-1 w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
        :style="{ translateX: count * 2 }"
      />
      <Text class="text-sm text-slate-600">Flexbox, springs and baked type — running on a 2005 handheld.</Text>
    </View>

    <View class="flex-row items-center gap-4">
      <View
        class="px-4 py-2 rounded-xl shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
        focusable
        @press="count++"
      >
        <Text class="text-base text-white font-bold">Press Circle</Text>
      </View>
      <Text class="text-sm text-slate-600">Count: {{ count }}</Text>
      <Text v-if="count > 3" class="text-sm text-emerald-600">Reactive on real hardware.</Text>
    </View>
  </View>
</template>
