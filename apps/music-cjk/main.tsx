// @title Pocket Music: CJK Library
import { createSignal, For, Show } from "solid-js";
import { mount } from "@pocketjs/framework";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getText } from "@pocketjs/framework/pak";

interface Track { title: string; artist: string; filename: string }

function Library() {
  const [tracks, setTracks] = createSignal<Track[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [stress, setStress] = createSignal(false);
  const [page, setPage] = createSignal(0);
  // Loaded after mounting, from a data blob rather than JS string literals.
  // No companion, OS font service, IME or remote-text component is involved.
  let loaded = false;
  onFrame(() => {
    if (!loaded) { loaded = true; setTracks(JSON.parse(getText("library:tracks"))); }
  });
  const move = (delta: number) => {
    if (stress()) setPage((page() + 1) % 2);
    else if (tracks().length) setSelected((selected() + delta + tracks().length) % tracks().length);
  };
  onButtonPress(BTN.DOWN, () => move(1));
  onButtonPress(BTN.UP, () => move(-1));
  onButtonPress(BTN.RTRIGGER, () => move(1));
  onButtonPress(BTN.LTRIGGER, () => move(-1));
  onButtonPress(BTN.SQUARE, () => setStress(!stress()));
  const visible = () => tracks().slice(Math.floor(selected() / 5) * 5, Math.floor(selected() / 5) * 5 + 5);
  const current = () => tracks()[selected()];
  const rows = () => Array.from({ length: 8 }, (_, row) => Array.from({ length: 24 }, (_, col) =>
    String.fromCodePoint(0x4e00 + ((row * 24 + col + page() * 64) % 256))).join(""));
  return <View class="w-full h-full bg-slate-950 flex-col p-3 gap-2" debugName="CjkLibrary">
    <View class="flex-row justify-between items-center">
      <Text class="text-lg text-white font-bold">Pocket Music</Text>
      <Text class="text-xs text-cyan-300">{stress() ? "192 UNIQUE GLYPHS" : "LOCAL LIBRARY"}</Text>
    </View>
    <Show when={stress()} fallback={<>
      <View class="flex-col h-[158] gap-1" debugName="TrackList">
        <For each={visible()}>{(track) => <View class="flex-row h-[28] items-center px-2 rounded"
          style={{ bgColor: track === current() ? "#164e63" : "#0f172a" }}>
          <Text class="text-base text-white">{track.title}</Text>
          <View class="grow" />
          <Text class="text-xs text-slate-300">{track.artist}</Text>
        </View>}</For>
      </View>
      <Text class="text-sm text-cyan-300" debugName="Filename">{current()?.filename ?? "Loading library"}</Text>
    </>}>
      <View class="flex-col h-[190]" debugName="GlyphPressure">
        <For each={rows()}>{row => <Text class="text-base text-white leading-[22]">{row}</Text>}</For>
      </View>
    </Show>
    <Text class="text-xs text-slate-400">D-PAD / L R: browse   SQUARE: glyph grid</Text>
  </View>;
}
mount(() => <Library />);
