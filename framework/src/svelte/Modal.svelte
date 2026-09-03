<script lang="ts">
  import type { Snippet } from "svelte";
  import { pushButtonHandlerBlock } from "../frame.svelte.ts";
  import { setProp, type NodeMirror } from "../renderer-svelte.ts";
  import FocusScope from "./FocusScope.svelte";
  import Portal from "./Portal.svelte";
  import View from "./View.svelte";
  import { resolveActive } from "./props.ts";

  interface Props {
    class?: string;
    panelClass?: string;
    open?: boolean | (() => boolean);
    children?: Snippet;
  }

  let { class: className, panelClass, open, children }: Props = $props();

  let backdrop = $state<NodeMirror | undefined>(undefined);
  let panel = $state<NodeMirror | undefined>(undefined);

  const visible = $derived(resolveActive(open));

  $effect(() => {
    if (!visible) return;
    return pushButtonHandlerBlock();
  });

  $effect(() => {
    if (backdrop) setProp(backdrop, "style", { opacity: visible ? 0.62 : 0 }, undefined);
    if (panel) {
      setProp(panel, "style", { opacity: visible ? 1 : 0, translateY: 0, scale: 1 }, undefined);
    }
  });
</script>

<Portal>
  <View class={className ?? "absolute inset-0 z-50 flex-col items-center justify-center"}>
    <View
      class="absolute inset-0 bg-slate-950"
      style={{ opacity: 0 }}
      nodeRef={(node: NodeMirror) => (backdrop = node)}
    />
    <FocusScope
      active={() => visible}
      class={panelClass ??
        "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200"}
      style={{ opacity: 0, translateY: 0, scale: 1 }}
      nodeRef={(node: NodeMirror) => (panel = node)}
    >{@render children?.()}</FocusScope>
  </View>
</Portal>
