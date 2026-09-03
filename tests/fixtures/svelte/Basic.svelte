<script lang="ts">
  import { state } from "./store.svelte.ts";
</script>

<view class="p-2 flex-col">
  <text>{state.label}</text>
  {#if state.on}
    <text>shown</text>
  {/if}
  {#each state.items as item (item.id)}
    <text>{item.n}</text>
  {/each}
  <view focusable onpress={() => (state.presses += 1)}>
    <text>press</text>
  </view>
</view>
