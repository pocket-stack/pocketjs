<script setup lang="ts">
// One field cell: raised while hidden, flat when revealed (red on the bust
// mine), flag/mine art, colored adjacency digit.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { MinesData } from "./state.ts";
import type { Cell } from "./mines.ts";
import T98 from "./T98.vue";

const props = defineProps<{ data: MinesData; i: number }>();

const c = (): Cell => props.data.board.value.cells[props.i];
const bust = (): boolean => props.data.board.value.bust === props.i;
const heldDown = (): boolean => props.data.held.value === props.i && c().state === "hidden";

const NUM_COLORS = [
  "", // 0 unused
  "text-[#0000ff]",
  "text-[#008000]",
  "text-[#ff0000]",
  "text-[#000080]",
  "text-[#800000]",
  "text-[#008080]",
  "text-[#000000]",
  "text-[#808080]",
];
</script>

<template>
  <View
    v-if="c().state !== 'revealed'"
    :class="
      heldDown()
        ? 'w-[16] h-[16] bg-[#c0c0c0] bevel-[#808080,#c0c0c0] flex-col justify-center items-center'
        : 'w-[16] h-[16] bg-[#c0c0c0] bevel-[#ffffff,#808080] bevel-w-[2] flex-col justify-center items-center'
    "
  >
    <Image v-if="c().state === 'flag'" class="w-[8] h-[8]" src="icons/flag.svg" />
  </View>
  <View
    v-else
    :class="
      bust()
        ? 'w-[16] h-[16] bg-[#ff0000] bevel-[#808080,#ff0000] flex-col justify-center items-center'
        : 'w-[16] h-[16] bg-[#c0c0c0] bevel-[#808080,#c0c0c0] flex-col justify-center items-center'
    "
  >
    <Image v-if="c().mine" class="w-[8] h-[8]" src="icons/mine.svg" />
    <T98
      v-else-if="c().adj > 0"
      bold
      :cls="NUM_COLORS[c().adj] || 'text-[#000000]'"
      :t="String(c().adj)"
    />
  </View>
</template>
