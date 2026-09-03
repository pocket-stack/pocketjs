<script lang="ts">
  import { pushFocusGrid, type FocusGridOptions } from "../input.ts";
  import View from "./View.svelte";
  import { resolveActive, type NodeMirror, type ViewProps } from "./props.ts";

  interface Props extends ViewProps, Partial<FocusGridOptions> {
    active?: boolean | (() => boolean);
  }

  let { active, columns, wrap, nodeRef, children, ...rest }: Props = $props();

  let root = $state<NodeMirror | undefined>(undefined);

  $effect(() => {
    if (!root || columns === undefined || !resolveActive(active)) return;
    return pushFocusGrid(root, { columns, wrap });
  });
</script>

<View
  {...rest}
  nodeRef={(node: NodeMirror) => {
    root = node;
    nodeRef?.(node);
  }}
>{@render children?.()}</View>
