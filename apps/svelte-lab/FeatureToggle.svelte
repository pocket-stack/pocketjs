<script lang="ts">
  import { Focusable, Text } from "@pocketjs/framework/svelte/components";

  let { label, enabled, onToggle }: { label: string; enabled: boolean; onToggle: () => void } =
    $props();
</script>

<Focusable
  class={enabled
    ? "px-2 py-1 rounded-md bg-emerald-600 border-emerald-500 focus:bg-emerald-500"
    : "px-2 py-1 rounded-md bg-slate-300 border-slate-200 focus:bg-slate-200"}
  onPress={onToggle}
>
  <Text class={enabled ? "text-xs text-white font-bold" : "text-xs text-slate-600 font-bold"}>
    {label}
  </Text>
</Focusable>
