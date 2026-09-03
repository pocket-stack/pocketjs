<script lang="ts">
  import { Text, View } from "@pocketjs/framework/svelte/components";
  import BindableButton from "./BindableButton.svelte";
  import FeatureCard from "./FeatureCard.svelte";
  import FeatureToggle from "./FeatureToggle.svelte";
  import { recordPress, session } from "./store.svelte.ts";

  interface Feature {
    id: string;
    label: string;
    enabled: boolean;
  }

  let count = $state(0);
  let features = $state<Feature[]>([
    { id: "runes", label: "RUNES", enabled: true },
    { id: "each", label: "EACH", enabled: true },
    { id: "snippets", label: "SNIPPETS", enabled: true },
  ]);

  const enabledCount = $derived(features.filter((feature) => feature.enabled).length);

  function toggleFeature(id: string): void {
    const feature = features.find((candidate) => candidate.id === id);
    if (!feature) return;
    feature.enabled = !feature.enabled;
    recordPress();
  }
</script>

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

  <FeatureCard title="COMPONENT BINDING">
    {#snippet badge()}
      <Text class="text-xs text-blue-600">$bindable()</Text>
    {/snippet}

    <BindableButton bind:value={count} label="VALUE +1" />

    <View class="flex-row items-center justify-between">
      {#if count === 0}
        <Text class="text-xs text-slate-500">if: idle</Text>
      {:else if count < 4}
        <Text class="text-xs text-blue-600">else if: active</Text>
      {:else}
        <Text class="text-xs text-emerald-600">else: complete</Text>
      {/if}
      <Text class="text-xs text-slate-600">parent value: {count}</Text>
    </View>

    <!-- A block with several roots and no wrapper element, which the renderer
         anchors on a comment rather than a native node. -->
    {#if count > 0}
      <Text class="text-xs text-slate-600">block: fragment</Text>
      <View
        class="h-1 rounded-md bg-gradient-to-r from-blue-500 to-cyan-500"
        style={{ width: 80 + count * 12 }}
      />
    {:else}
      <Text class="text-xs text-slate-400">block else: press → then ○</Text>
      <View class="h-1 w-16 rounded-full bg-slate-200" />
    {/if}

    {#snippet footer()}
      <Text class="text-xs text-slate-500">props + callbacks + snippets</Text>
      <Text class="text-xs text-slate-400">$state + $derived</Text>
    {/snippet}
  </FeatureCard>

  <View class="flex-row gap-2">
    {#each features as feature (feature.id)}
      <FeatureToggle
        label={feature.label}
        enabled={feature.enabled}
        onToggle={() => toggleFeature(feature.id)}
      />
    {/each}
  </View>

  <View class="flex-row items-center justify-between">
    <View class="flex-row gap-2">
      {#each features as feature, index (`summary-${feature.id}`)}
        <Text class="text-xs text-slate-500">{index + 1}.{feature.label}</Text>
      {/each}
    </View>
    <Text class="text-xs text-slate-400">module presses: {session.presses}</Text>
  </View>
</View>
