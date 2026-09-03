<script lang="ts">
  import type { Snippet } from "svelte";
  import { Text, View } from "@pocketjs/framework/svelte/components";

  // Svelte's answer to named slots: snippets, passed like any other prop.
  let {
    title,
    badge,
    footer,
    children,
  }: { title: string; badge?: Snippet; footer?: Snippet; children?: Snippet } = $props();
</script>

<View
  debugName="FeatureCard"
  class="flex-1 flex-col gap-2 p-3 rounded-xl shadow-md bg-white border-slate-200"
>
  <View class="flex-row items-center justify-between">
    <Text class="text-sm text-slate-950 font-bold">{title}</Text>
    {@render badge?.()}
  </View>
  {@render children?.()}
  <View class="flex-row items-center justify-between">
    {@render footer?.()}
  </View>
</View>
