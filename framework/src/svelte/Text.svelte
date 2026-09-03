<script lang="ts">
  import { applyStyle, type NodeMirror, type TextProps } from "./props.ts";

  let { class: className, style, debugName, nodeRef, children }: TextProps = $props();
</script>

<text
  class={className}
  debugName={debugName}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
  {@attach (node: NodeMirror) => applyStyle(node, style)}
>{@render children?.()}</text>
