<script lang="ts">
  import { Text, View } from "@pocketjs/framework/svelte/components";

  // $bindable is Svelte's two-way prop: the parent's state is written directly.
  let { label = "VALUE +1", value = $bindable(0) }: { label?: string; value?: number } = $props();
</script>

<View
  debugName="BindableButton"
  class="flex-row items-center justify-between px-3 py-2 rounded-lg shadow bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
  focusable
  onPress={() => value++}
>
  <Text class="text-sm text-white font-bold">{label}</Text>
  <Text class="text-sm text-white font-bold">{value}</Text>
</View>
