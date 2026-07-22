<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const props = defineProps<{ title: string }>();
</script>

<template>
  <View
    debug-name="FeatureCard"
    class="flex-1 flex-col gap-2 p-3 rounded-xl shadow-md bg-white border-slate-200"
  >
    <View class="flex-row items-center justify-between">
      <Text class="text-sm text-slate-950 font-bold">{{ props.title }}</Text>
      <slot name="badge" />
    </View>
    <slot />
    <View class="flex-row items-center justify-between">
      <slot name="footer" />
    </View>
  </View>
</template>
