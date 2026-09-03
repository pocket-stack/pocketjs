<script lang="ts">
  import { pushFocusScope, type FocusScopeOptions } from "../input.ts";
  import View from "./View.svelte";
  import { resolveActive, type NodeMirror, type ViewProps } from "./props.ts";

  interface Props extends ViewProps, FocusScopeOptions {
    active?: boolean | (() => boolean);
  }

  let { active, autoFocus, restoreFocus, nodeRef, children, ...rest }: Props = $props();

  let root = $state<NodeMirror | undefined>(undefined);

  $effect(() => {
    if (!root || !resolveActive(active)) return;
    return pushFocusScope(root, { autoFocus, restoreFocus });
  });
</script>

<View
  {...rest}
  nodeRef={(node: NodeMirror) => {
    root = node;
    nodeRef?.(node);
  }}
>{@render children?.()}</View>
