<script lang="ts">
  import Portal from "./Portal.svelte";
  import View from "./View.svelte";
  import type { ViewProps } from "./props.ts";

  let { class: className, children, ...rest }: ViewProps = $props();
</script>

<Portal>
  <View
    class={className ??
      "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200"}
    {...rest}
  >{@render children?.()}</View>
</Portal>
