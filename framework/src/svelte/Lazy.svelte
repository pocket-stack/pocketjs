<script lang="ts">
  import type { Snippet } from "svelte";
  import { onFrame } from "../frame.svelte.ts";
  import { resolveActive } from "./props.ts";

  interface Props {
    /** Mount the content while this is truthy; unmount (destroy) when false. */
    when: boolean | (() => boolean);
    /**
     * Host frames to show `fallback` before revealing `children` the first time
     * this becomes active (default 0 = reveal immediately). Models on-demand
     * content build, not texture residency — textures upload at pak load.
     */
    reveal?: number;
    fallback?: Snippet;
    children: Snippet;
  }

  let { when, reveal = 0, fallback, children }: Props = $props();

  const frames = Math.max(0, Math.floor(reveal));
  const active = $derived(resolveActive(when));

  // A one-shot latch: once elapsed the content stays revealed for this
  // component's lifetime, so a later re-activation replays no spinner.
  let ready = $state(frames === 0);
  let elapsed = 0;

  if (frames > 0) {
    onFrame(() => {
      if (ready || !active) return;
      if (++elapsed >= frames) ready = true;
    });
  }
</script>

{#if active}
  {#if ready}
    {@render children()}
  {:else}
    {@render fallback?.()}
  {/if}
{/if}
