<script setup lang="ts">
// Three-digit 7-seg counter (mine count / timer), clamped to -99..999.
import { View } from "@pocketjs/framework/vue-vapor/components";
import { computed } from "vue";
import Digit from "./Digit.vue";

const props = defineProps<{ value: number }>();

const text = computed(() => {
  const v = Math.max(-99, Math.min(999, Math.round(props.value)));
  return v < 0 ? "-" + String(-v).padStart(2, "0") : String(v).padStart(3, "0");
});
</script>

<template>
  <View class="flex-row bevel-[#808080,#ffffff] p-[1] gap-0">
    <Digit :ch="text[0]" />
    <Digit :ch="text[1]" />
    <Digit :ch="text[2]" />
  </View>
</template>
