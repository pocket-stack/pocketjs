<script lang="ts">
  import { applyStyle, type CompositorSurfaceProps, type NodeMirror } from "./props.ts";

  let { class: className, package: pkg, focused, style, debugName, nodeRef }:
    CompositorSurfaceProps = $props();
</script>

<surface
  class={className}
  package={pkg}
  focused={focused}
  debugName={debugName}
  {@attach (node: NodeMirror) => nodeRef?.(node)}
  {@attach (node: NodeMirror) => applyStyle(node, style)}
></surface>
