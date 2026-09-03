<script lang="ts">
  import type { FocusGridOptions } from "../input.ts";
  import FocusGrid from "./FocusGrid.svelte";
  import View from "./View.svelte";
  import type { ViewProps } from "./props.ts";

  interface Props extends ViewProps, Partial<FocusGridOptions> {
    /** Cross-axis gap in px, applied through the style object so `class` stays
     *  a single compiled literal. */
    gap?: number;
    active?: boolean | (() => boolean);
  }

  let { gap, columns, wrap, active, class: className, style, children, ...rest }: Props = $props();

  const cls = $derived(className ?? "flex-row flex-wrap");
  const gridStyle = $derived(gap != null ? { ...(style ?? {}), gap } : style);
</script>

{#if columns != null}
  <FocusGrid {...rest} class={cls} style={gridStyle} {columns} {wrap} {active}>
    {@render children?.()}
  </FocusGrid>
{:else}
  <View {...rest} class={cls} style={gridStyle}>{@render children?.()}</View>
{/if}
