<script lang="ts">
  import type { Snippet } from "svelte";
  import { getAllContexts, onMount } from "svelte";
  import { ENUMS, SCREEN_H, SCREEN_W } from "../../../contracts/spec/spec.ts";
  import { getOps, hostViewport } from "../host.ts";
  import { getOverlayRoot } from "../overlay.ts";
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
    // Size to the live logical viewport — desktop widget hosts resize it, so a
    // portal opened after a resize still lands full-window.
    const viewport = hostViewport(getOps());
    const host: NodeMirror = createElement("view");
    setProp(
      host,
      "style",
      {
        width: viewport?.w ?? SCREEN_W,
        height: viewport?.h ?? SCREEN_H,
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        zIndex: 1000,
        // Pure plumbing: a full-screen box that must never claim a hit itself.
        // Its CONTENT still claims normally, so a modal scrim keeps blocking.
        hitPass: 1,
      },
      undefined,
    );
    insertNode(getOverlayRoot(), host);
    const dispose = mountInto(PortalHost, host, { props: box, context: getAllContexts() });
    return () => {
      dispose();
      if (host.parent) detachNode(host.parent, host);
    };
  });
</script>
