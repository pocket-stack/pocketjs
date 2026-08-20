<script setup lang="ts">
// Dialog push button; armed = pressed bevel + 1px content nudge.
import { View } from "@pocketjs/framework/vue-vapor/components";
import T98 from "./T98.vue";

const props = defineProps<{ label: string; armed: boolean }>();
</script>

<template>
  <View
    :class="
      props.armed
        ? 'w-[75] h-[23] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]'
        : 'w-[75] h-[23] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]'
    "
  >
    <View :class="props.armed ? 'ml-[1] mt-[1]' : ''">
      <T98 :t="props.label" />
    </View>
  </View>
</template>
