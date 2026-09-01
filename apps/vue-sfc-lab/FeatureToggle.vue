<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const props = defineProps<{
  label: string;
  enabled: boolean;
}>();
const emit = defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <View
    debug-name="FeatureToggle"
    :class="props.enabled
      ? 'flex-1 flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-emerald-600 border-emerald-500 focus:bg-emerald-500'
      : 'flex-1 flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-slate-200 border-slate-300 focus:bg-blue-100'"
    focusable
    @press="emit('toggle')"
  >
    <Text :class="props.enabled ? 'text-xs text-white font-bold' : 'text-xs text-slate-600 font-bold'">
      {{ props.label }}
    </Text>
    <Text :class="props.enabled ? 'text-xs text-white' : 'text-xs text-slate-500'">
      {{ props.enabled ? "ON" : "OFF" }}
    </Text>
  </View>
</template>
