<script lang="ts">
  import View from "./View.svelte";
  import type { ViewProps } from "./props.ts";

  let { class: className, children, ...rest }: ViewProps = $props();
</script>

<View class={className ?? "relative flex-col w-full h-full bg-slate-50 overflow-hidden"} {...rest}>
  {@render children?.()}
</View>
