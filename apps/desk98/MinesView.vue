<script setup lang="ts">
// Minesweeper content: sunken header (mine counter, smiley, timer) over the
// 9×9 field. The grid rides a static index array — the board ref retriggers
// cell reads, rows never move.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { MinesData } from "./state.ts";
import { MINES_W } from "./mines.ts";
import Counter from "./Counter.vue";
import MinesCell from "./MinesCell.vue";

const props = defineProps<{ data: MinesData }>();
const d = props.data;

const ROWS9 = Array.from({ length: MINES_W }, (_, i) => i);

const smiley = (): string => {
  if (d.smileyHeld.value) return "icons/smile.svg";
  const m = d.board.value;
  if (m.phase === "lost") return "icons/smile-dead.svg";
  if (m.phase === "won") return "icons/smile-cool.svg";
  if (d.held.value >= 0) return "icons/smile-ooh.svg";
  return "icons/smile.svg";
};
</script>

<template>
  <View class="flex-1 flex-col p-[5] bg-[#c0c0c0]">
    <View class="h-[36] flex-row items-center justify-between px-[5] bevel-[#808080,#ffffff] bevel-w-[2]">
      <Counter :value="10 - d.board.value.flags" />
      <View
        :class="
          d.smileyHeld.value
            ? 'w-[26] h-[26] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#808080,#ffffff]'
            : 'w-[26] h-[26] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#808080] bevel-w-[2]'
        "
      >
        <Image class="w-[16] h-[16]" :src="smiley()" />
      </View>
      <Counter :value="d.elapsed.value" />
    </View>
    <View class="h-[6]" />
    <View class="flex-col bevel-[#808080,#ffffff] bevel-w-[3] p-[3]">
      <View v-for="ry in ROWS9" :key="ry" class="flex-row">
        <MinesCell v-for="rx in ROWS9" :key="rx" :data="d" :i="ry * MINES_W + rx" />
      </View>
    </View>
  </View>
</template>
