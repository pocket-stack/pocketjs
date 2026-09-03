<script lang="ts">
  import { Focusable, Text } from "@pocketjs/framework/svelte/components";

  // `bind:` on a component is plain prop plumbing and stays supported; only
  // `bind:` on a host element is refused under a custom renderer.
  let { value = $bindable(0) }: { value?: number } = $props();
</script>

<Focusable
  class="px-2 py-1 rounded-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700"
  onPress={() => (value += 1)}
>
  <Text class="text-xs text-white font-bold">BIND +1</Text>
</Focusable>
