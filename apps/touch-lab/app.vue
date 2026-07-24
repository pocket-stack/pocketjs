<script setup lang="ts">
// Touch event smoke test: three pads exercising start/move/end/cancel,
// implicit capture, and bubbling — click/drag on them in the web host.
import { ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import type { PocketTouchEvent } from "@pocketjs/framework/vue-vapor/input";

const log = ref<string[]>([]);
const tapCount = ref(0);
const dragPos = ref("—");
const bubbleOrder = ref("—");

function push(msg: string): void {
  log.value = [msg, ...log.value].slice(0, 6);
  (globalThis as any).__touchLabLog = log.value;
  (globalThis as any).__touchLab = { taps: tapCount.value, drag: dragPos.value, bubble: bubbleOrder.value };
}

let downX = 0;
let downY = 0;

function onStart(ev: PocketTouchEvent): void {
  const t = ev.changedTouches[0];
  downX = t.clientX;
  downY = t.clientY;
  push(`start ${t.clientX},${t.clientY} ts=${ev.timeStamp.toFixed(0)}`);
}

function onEnd(ev: PocketTouchEvent): void {
  const t = ev.changedTouches[0];
  push(`end ${t.clientX},${t.clientY} touches=${ev.touches.length}`);
  const dx = t.clientX - downX;
  const dy = t.clientY - downY;
  if (dx * dx + dy * dy <= 64) tapCount.value++;
}

function onMove(ev: PocketTouchEvent): void {
  const t = ev.changedTouches[0];
  dragPos.value = `${t.clientX},${t.clientY}`;
  (globalThis as any).__touchLab = { taps: tapCount.value, drag: dragPos.value, bubble: bubbleOrder.value };
}

// Bubble probe: reset on every press; child claims the press via
// stopPropagation so parent only records presses that landed on itself.
let childClaimed = false;
function syncLab(): void {
  (globalThis as any).__touchLab = { taps: tapCount.value, drag: dragPos.value, bubble: bubbleOrder.value };
}
function onBubbleAreaStart(): void {
  childClaimed = false;
  bubbleOrder.value = "none";
  syncLab();
}
function onBubbleChild(ev: PocketTouchEvent): void {
  childClaimed = true;
  bubbleOrder.value = "child";
  syncLab();
  ev.stopPropagation();
}
function onBubbleParent(): void {
  if (!childClaimed) {
    bubbleOrder.value = "parent";
    syncLab();
  }
}
</script>

<template>
  <View class="w-full h-full flex-col gap-2 bg-slate-950 p-2" @touchstart="onBubbleAreaStart">
    <Text class="text-xs text-slate-400">touch-events smoke: taps={{ tapCount }} drag={{ dragPos }} bubble={{ bubbleOrder }}</Text>

    <View class="flex-row gap-2">
      <View
        class="w-24 h-16 rounded-lg bg-blue-700 items-center justify-center"
        @touchstart="onStart"
        @touchend="onEnd"
        @touchcancel="() => push('cancel')"
      >
        <Text class="text-xs text-white">TAP PAD</Text>
      </View>

      <View
        class="w-24 h-16 rounded-lg bg-emerald-700 items-center justify-center"
        @touchstart="onStart"
        @touchmove="onMove"
        @touchend="onEnd"
      >
        <Text class="text-xs text-white">DRAG PAD</Text>
      </View>

      <View
        class="w-24 h-16 rounded-lg bg-rose-800 items-center justify-center"
        @touchstart="onBubbleParent"
      >
        <View
          class="w-16 h-10 rounded bg-rose-500 items-center justify-center"
          @touchstart="onBubbleChild"
        >
          <Text class="text-xs text-white">CHILD</Text>
        </View>
      </View>
    </View>

    <View class="flex-col">
      <Text v-for="(line, i) in log" :key="i" class="text-xs text-slate-300">{{ line }}</Text>
    </View>
  </View>
</template>
