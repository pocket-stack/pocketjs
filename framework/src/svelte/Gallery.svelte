<script lang="ts">
  import type { Snippet } from "svelte";
  import { BTN, ENUMS, SCREEN_H, SCREEN_W } from "../../../contracts/spec/spec.ts";
  import { animate, type EasingName } from "../anim.ts";
  import { onButtonPress } from "../frame.svelte.ts";
  import View from "./View.svelte";
  import type { NodeMirror } from "./props.ts";

  interface Props {
    count: number;
    /** Controlled current page (0-based). */
    page: number;
    onPageChange?: (next: number) => void;
    /** Rendered for pages inside the mount window only. */
    renderPage: Snippet<[number]>;
    /** Pages kept mounted on each side of the current one (default 1). */
    window?: number;
    duration?: number;
    easing?: EasingName;
    /** Bind LTRIGGER/RTRIGGER to page(-/+1) internally (default true). */
    bindTriggers?: boolean;
    wrap?: boolean;
    class?: string;
  }

  let {
    count,
    page,
    onPageChange,
    renderPage,
    window: win = 1,
    duration = 300,
    easing = "out",
    bindTriggers = true,
    wrap = false,
    class: className,
  }: Props = $props();

  const mountWindow = Math.max(0, Math.floor(win));
  const initialPage = page;
  const pages = $derived(Array.from({ length: count }, (_, index) => index));

  let strip = $state<NodeMirror | undefined>(undefined);

  const clampPage = (n: number): number =>
    wrap ? ((n % count) + count) % count : Math.max(0, Math.min(count - 1, n));

  function go(delta: number): void {
    const next = clampPage(page + delta);
    if (next !== page) onPageChange?.(next);
  }

  if (bindTriggers) {
    onButtonPress(BTN.LTRIGGER, () => go(-1));
    onButtonPress(BTN.RTRIGGER, () => go(1));
  }

  // Skip the mount run so the strip starts in place.
  let prevPage = initialPage;
  $effect(() => {
    const p = page;
    if (!strip || p === prevPage) return;
    prevPage = p;
    animate(strip, "translateX", -p * SCREEN_W, { dur: duration, easing });
  });
</script>

<View
  class={className}
  style={className
    ? undefined
    : { width: SCREEN_W, height: SCREEN_H, overflow: ENUMS.Overflow.Hidden }}
>
  <View
    style={{ width: SCREEN_W, height: SCREEN_H, translateX: -initialPage * SCREEN_W }}
    nodeRef={(node: NodeMirror) => (strip = node)}
  >
    {#each pages as index (index)}
      <View
        style={{
          posType: ENUMS.PosType.Absolute,
          insetT: 0,
          insetR: 0,
          insetB: 0,
          insetL: 0,
          translateX: index * SCREEN_W,
        }}
      >
        {#if Math.abs(index - page) <= mountWindow}
          {@render renderPage(index)}
        {/if}
      </View>
    {/each}
  </View>
</View>
