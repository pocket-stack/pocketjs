<script lang="ts">
  import type { Snippet } from "svelte";
  import { onButtonPress, type ButtonPressOptions } from "../frame.svelte.ts";

  interface Props extends ButtonPressOptions {
    button: number;
    onPress: (pressed: number, buttons: number) => void;
    children?: Snippet;
  }

  let { button, onPress, allowWhenBlocked, active, latched, children }: Props = $props();

  onButtonPress(button, (pressed, buttons) => onPress(pressed, buttons), {
    allowWhenBlocked,
    active,
    latched,
  });
</script>

{@render children?.()}
