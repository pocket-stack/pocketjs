<script lang="ts">
  import type { Snippet } from "svelte";
  import { Text, View } from "@pocketjs/framework/svelte/components";

  let { title, badge, children }: { title: string; badge?: Snippet; children?: Snippet } = $props();
</script>

<View class="flex-col gap-1 px-2 py-1 rounded-lg bg-white border-slate-200">
  <View class="flex-row items-center justify-between">
    <Text class="text-xs text-slate-500 tracking-wide">{title}</Text>
    {@render badge?.()}
  </View>
  {@render children?.()}
</View>
