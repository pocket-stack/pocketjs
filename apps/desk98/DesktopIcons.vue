<script setup lang="ts">
// Desktop icons: a left column of 32px art + label, teal behind.
import { Image, View } from "@pocketjs/framework/vue-vapor/components";
import type { DeskIcon } from "./state.ts";
import T98 from "./T98.vue";

const props = defineProps<{ icons: DeskIcon[]; selected: number }>();
</script>

<template>
  <View class="absolute left-0 top-0 flex-col gap-[10] p-[8]">
    <View
      v-for="(icon, i) in props.icons"
      :key="icon.label"
      class="w-[74] flex-col items-center gap-[3]"
    >
      <Image class="w-[32] h-[32]" :src="icon.icon" />
      <View :class="props.selected === i ? 'bg-[#000080] px-[2]' : 'px-[2]'">
        <T98 cls="text-[#ffffff]" :t="icon.label" />
      </View>
    </View>
  </View>
</template>
