<script lang="ts">
  import { BTN } from "@pocketjs/framework/svelte/input";
  import { ActionHandler, FocusScope, Text, View } from "@pocketjs/framework/svelte/components";
  import { createSpriteAnimation } from "@pocketjs/framework/svelte/lifecycle";
  import CounterButton from "./CounterButton.svelte";
  import FeatureCard from "./FeatureCard.svelte";
  import FeatureToggle from "./FeatureToggle.svelte";
  import { recordPress, session } from "./store.svelte.ts";

  interface Feature {
    id: string;
    label: string;
    enabled: boolean;
  }

  let bound = $state(0);
  let features = $state<Feature[]>([
    { id: "runes", label: "RUNES", enabled: true },
    { id: "each", label: "EACH", enabled: true },
    { id: "snippets", label: "SNIPPETS", enabled: true },
  ]);

  const enabledCount = $derived(features.filter((feature) => feature.enabled).length);

  const spinner = createSpriteAnimation(
    ["spinner-00.svg", "spinner-01.svg", "spinner-02.svg", "spinner-03.svg"],
    { frameStep: 6 },
  );

  function toggle(id: string): void {
    const feature = features.find((candidate) => candidate.id === id);
    if (feature) feature.enabled = !feature.enabled;
  }

  // Rotating the list proves keyed {#each} reorders rather than rebuilds.
  function rotate(): void {
    features = [...features.slice(1), features[0]];
  }
</script>

<ActionHandler button={BTN.TRIANGLE} onPress={rotate} />

<View
  debugName="SvelteLab"
  class="w-full h-full flex-col gap-2 p-4 bg-gradient-to-b from-slate-50 to-slate-100"
>
  <View class="flex-row items-center justify-between">
    <View class="flex-col">
      <Text class="text-lg text-slate-950 font-bold">Svelte Feature Lab</Text>
      <Text class="text-xs text-slate-500">runes and snippets · PocketJS custom renderer</Text>
    </View>
    <Text class="text-xs text-blue-600 font-bold">{enabledCount}/3 ON</Text>
  </View>

  <FeatureCard title="COMPONENT BIND">
    {#snippet badge()}
      <Text class="text-xs text-blue-600">$bindable()</Text>
    {/snippet}
    <View class="flex-row items-center gap-2">
      <CounterButton bind:value={bound} />
      <Text class="text-xs text-slate-600">bound: {bound}</Text>
      <Text class="text-xs text-slate-400">frame: {spinner.current}</Text>
    </View>
  </FeatureCard>

  <FeatureCard title="KEYED EACH · TRIANGLE ROTATES">
    <FocusScope class="flex-row gap-2" autoFocus>
      {#each features as feature (feature.id)}
        <FeatureToggle
          label={feature.label}
          enabled={feature.enabled}
          onToggle={() => {
            toggle(feature.id);
            recordPress();
          }}
        />
      {/each}
    </FocusScope>
  </FeatureCard>

  <View class="flex-row items-center justify-between">
    {#if enabledCount === 0}
      <Text class="text-xs text-amber-600">All features off.</Text>
    {:else}
      <Text class="text-xs text-emerald-600">Reactive through runes.</Text>
    {/if}
    <Text class="text-xs text-slate-500">module presses: {session.presses}</Text>
  </View>
</View>
