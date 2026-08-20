<script setup lang="ts">
// About dialog content (OK button hit math in programs.ts aboutHit).
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { AboutData } from "./state.ts";
import T98 from "./T98.vue";
import Button98 from "./Button98.vue";

const props = defineProps<{ data: AboutData }>();
</script>

<template>
  <View class="flex-1 flex-col p-[10] gap-[8]">
    <View class="flex-row items-center gap-[10]">
      <Image class="w-[32] h-[32]" src="icons/computer.svg" />
      <T98 xl t="PocketJS 98" />
    </View>
    <View class="h-[2] flex-col">
      <View class="h-[1] bg-[#808080]" />
      <View class="h-[1] bg-[#ffffff]" />
    </View>
    <T98 t="A desktop compositor demo on the gpui backend." />
    <T98 t="Vue Vapor templates over the same DrawList the" />
    <T98 t="consoles boot; windows, menus and shortcuts" />
    <T98 t="live in the guest." />
    <T98 cls="text-[#808080]" t="github.com/pocket-stack/pocketjs" />
    <View class="flex-1" />
    <View class="flex-row justify-end">
      <Button98 label="OK" :armed="props.data.armed.value === 'ok'" />
    </View>
  </View>
</template>
