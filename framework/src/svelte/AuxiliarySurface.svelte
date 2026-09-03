<script lang="ts">
  import type { Snippet } from "svelte";
  import { getAllContexts, onMount } from "svelte";
  import { ENUMS } from "../../../contracts/spec/spec.ts";
  import { getAuxiliarySurfaceRoots } from "../display.ts";
  import {
    createElement,
    detachNode,
    insertNode,
    mountInto,
    setProp,
    type NodeMirror,
  } from "../renderer-svelte.ts";
  import PortalHost from "./PortalHost.svelte";

  let { children }: { children?: Snippet } = $props();

  const box = $state<{ content?: Snippet }>({ content: children });
  $effect(() => {
    box.content = children;
  });

  onMount(() => {
    const surface = getAuxiliarySurfaceRoots();
    const host: NodeMirror = createElement("view");
    setProp(
      host,
      "style",
      {
        width: surface.viewport.width,
        height: surface.viewport.height,
        overflow: ENUMS.Overflow.Hidden,
      },
      undefined,
    );
    insertNode(surface.app, host);
    const dispose = mountInto(PortalHost, host, { props: box, context: getAllContexts() });
    return () => {
      dispose();
      if (host.parent) detachNode(host.parent, host);
    };
  });
</script>
