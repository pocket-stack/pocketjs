<script lang="ts">
  import { Text, View } from "@pocketjs/framework/svelte/components";

  // Svelte has no emits: a callback prop is the whole mechanism.
  let { label, enabled, onToggle }: { label: string; enabled: boolean; onToggle: () => void } =
    $props();
</script>

<View
  debugName="FeatureToggle"
  class={enabled
    ? "flex-1 flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-emerald-600 border-emerald-500 focus:bg-emerald-500"
    : "flex-1 flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-slate-200 border-slate-300 focus:bg-blue-100"}
  focusable
  onPress={onToggle}
>
  <Text class={enabled ? "text-xs text-white font-bold" : "text-xs text-slate-600 font-bold"}>
    {label}
  </Text>
  <Text class={enabled ? "text-xs text-white" : "text-xs text-slate-500"}>
    {enabled ? "ON" : "OFF"}
  </Text>
</View>
