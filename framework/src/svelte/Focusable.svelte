<script lang="ts">
  import View from "./View.svelte";
  import type { ViewProps } from "./props.ts";

  let { children, ...rest }: ViewProps = $props();
</script>

<View {...rest} focusable>{@render children?.()}</View>
