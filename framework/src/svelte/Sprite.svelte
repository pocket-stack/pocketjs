<script lang="ts">
  import { applyStyle, type NodeMirror, type SpriteProps } from "./props.ts";

  let { class: className, sprite, style, debugName, nodeRef }: SpriteProps = $props();
</script>

<image
  class={className}
  sprite={sprite}
  debugName={debugName}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
  {@attach (node: NodeMirror) => applyStyle(node, style)}
></image>
