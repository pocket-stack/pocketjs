<script setup lang="ts">
// Shut Down dialog content (radio + button hit math in programs.ts
// shutdownHit). Radios are nested rounded circles — rounded-full cannot
// combine with bevel classes.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { ShutdownData } from "./state.ts";
import T98 from "./T98.vue";
import Button98 from "./Button98.vue";

const props = defineProps<{ data: ShutdownData }>();

const RADIOS = [
  { i: 0, label: "Shut down" },
  { i: 1, label: "Restart" },
];
</script>

<template>
  <View class="flex-1 flex-col p-[10]">
    <View class="flex-row items-start gap-[10]">
      <Image class="w-[32] h-[32]" src="icons/shutdown.svg" />
      <View class="flex-col gap-[2]">
        <T98 t="What do you want the computer to do?" />
      </View>
    </View>
    <View class="h-[10]" />
    <View class="flex-col pl-[46]">
      <View v-for="r in RADIOS" :key="r.i" class="h-[20] flex-row items-center gap-[6]">
        <View class="w-[12] h-[12] rounded-full bg-[#808080] flex-col justify-center items-center">
          <View class="w-[10] h-[10] rounded-full bg-[#ffffff] flex-col justify-center items-center">
            <View v-if="props.data.choice.value === r.i" class="w-[4] h-[4] rounded-full bg-[#000000]" />
          </View>
        </View>
        <T98 :t="r.label" />
      </View>
    </View>
    <View class="flex-1" />
    <View class="flex-row justify-end gap-[6]">
      <Button98 label="OK" :armed="props.data.armed.value === 'ok'" />
      <Button98 label="Cancel" :armed="props.data.armed.value === 'cancel'" />
    </View>
  </View>
</template>
