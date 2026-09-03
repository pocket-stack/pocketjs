<script lang="ts">
  import { onMount } from "svelte";
  import { frameworkName } from "@pocketjs/framework/svelte";
  import { animate } from "@pocketjs/framework/svelte/animation";
  import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/svelte/components";
  import { createSpriteAnimation } from "@pocketjs/framework/svelte/lifecycle";

  const SPINNER_FRAME_STEP = 3;
  const SPINNER_FRAMES = [
    "spinner-00.svg",
    "spinner-01.svg",
    "spinner-02.svg",
    "spinner-03.svg",
    "spinner-04.svg",
    "spinner-05.svg",
    "spinner-06.svg",
    "spinner-07.svg",
  ];

  let count = $state(0);
  const spinner = createSpriteAnimation(SPINNER_FRAMES, { frameStep: SPINNER_FRAME_STEP });
  let underline: NodeMirror | undefined;

  onMount(() => {
    // Underline sweeps in once on mount — native tween, zero steady-state JS.
    if (underline) animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
  });
</script>

{#snippet stat(label: string, value: string, cls: string)}
  <View class="flex-col items-end">
    <Text class={cls}>{value}</Text>
    <Text class="text-xs text-slate-500 tracking-wide">{label}</Text>
  </View>
{/snippet}

<View class="w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-50 to-slate-100">
  <View class="flex-row items-center justify-between">
    <View class="flex-row items-center gap-3">
      <Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
      <View class="flex-col">
        <Text class="text-base text-slate-950 font-bold tracking-wide">PocketJS</Text>
        <Text class="text-xs text-slate-500 tracking-wide">{frameworkName()} + RUST + SCEGU</Text>
      </View>
    </View>
    <View class="flex-row gap-4">
      {@render stat("FPS", "60", "text-lg text-emerald-600 font-bold")}
      {@render stat("NODES", "42", "text-lg text-blue-600 font-bold")}
      {@render stat("DRAWS", "9", "text-lg text-amber-600 font-bold")}
    </View>
  </View>

  <View class="flex-col gap-2">
    <Text class="text-xs text-blue-600 tracking-wide">ONE RUST CORE - ONE SVELTE APP</Text>
    <View class="flex-row items-center justify-between">
      <Text class="text-4xl text-slate-950 font-bold">Runes at 60 FPS.</Text>
      <Image class="w-10 h-10" src={spinner.current} />
    </View>
    <View
      class="h-1 w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
      style={{ translateX: count * 2 }}
      nodeRef={(node: NodeMirror) => (underline = node)}
    />
    <Text class="text-sm text-slate-600">
      Flexbox, springs and baked type - running through Svelte.
    </Text>
  </View>

  <View class="flex-row items-center gap-4">
    <View
      class="px-4 py-2 rounded-xl shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
      focusable
      onPress={() => count++}
    >
      <Text class="text-base text-white font-bold">Press Circle</Text>
    </View>
    <Text class="text-sm text-slate-600">Count: {count}</Text>
    {#if count > 3}
      <Text class="text-sm text-emerald-600">Reactive on real hardware.</Text>
    {/if}
  </View>
</View>
