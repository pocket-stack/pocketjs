<script lang="ts">
  import type { Snippet } from "svelte";

  // The root of a nested mount: Portal hands it the caller's snippet through a
  // rune box so a changing snippet still propagates across the mount boundary.
  let { content }: { content?: Snippet } = $props();
</script>

{@render content?.()}
