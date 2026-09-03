<script lang="ts">
  import { applyStyle, type ImageProps, type NodeMirror } from "./props.ts";

  let { class: className, src, style, debugName, nodeRef }: ImageProps = $props();
</script>

<image
  class={className}
  src={src}
  debugName={debugName}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
  {@attach (node: NodeMirror) => applyStyle(node, style)}
></image>
