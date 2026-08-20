<script setup lang="ts">
// The taskbar: the Start button (PocketJS favicon mark, gen-icons
// start-logo), one button per window, the sunken clock tray.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { TaskEntry } from "./state.ts";
import T98 from "./T98.vue";

const props = defineProps<{
  entries: TaskEntry[];
  activeId: number;
  startOpen: boolean;
  clock: string;
  buttonW: number;
}>();
</script>

<template>
  <View
    class="absolute left-0 right-0 bottom-0 h-[28] flex-row items-center bg-[#c0c0c0] bevel-[#ffffff,#808080] pl-[2] pr-[2] gap-[3]"
    :style="{ zIndex: 10000 }"
  >
    <View
      :class="
        props.startOpen
          ? 'h-[22] w-[54] flex-row justify-center items-center gap-[3] bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]'
          : 'h-[22] w-[54] flex-row justify-center items-center gap-[3] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]'
      "
    >
      <Image class="w-[16] h-[16]" src="icons/start-logo.svg" />
      <T98 bold t="Start" />
    </View>
    <View class="w-[1] h-[22] bevel-[#808080,#ffffff]" />
    <View class="flex-1 flex-row items-center gap-[3] overflow-hidden">
      <View
        v-for="entry in props.entries"
        :key="entry.id"
        :class="
          entry.id === props.activeId
            ? 'h-[22] flex-row items-center gap-[4] px-[4] bg-[#dfdfdf] bevel-[#808080,#ffffff]'
            : 'h-[22] flex-row items-center gap-[4] px-[4] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]'
        "
        :style="{ width: props.buttonW }"
      >
        <Image class="w-[16] h-[16]" :src="entry.icon" />
        <View class="flex-1 flex-row overflow-hidden">
          <T98 :bold="entry.id === props.activeId" :t="entry.title" />
        </View>
      </View>
    </View>
    <View class="h-[22] flex-row items-center px-[8] bevel-[#808080,#ffffff]">
      <T98 :t="props.clock" />
    </View>
  </View>
</template>
