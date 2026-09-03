<script lang="ts">
  import { applyPress, applyStyle, type NodeMirror, type ViewProps } from "./props.ts";

  let { class: className, style, onPress, focusable, debugName, nodeRef, children }: ViewProps =
    $props();
</script>

<view
  class={className}
  focusable={focusable}
  debugName={debugName}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
  {@attach (node: NodeMirror) => {
    applyStyle(node, style);
    applyPress(node, onPress);
  }}
>{@render children?.()}</view>
