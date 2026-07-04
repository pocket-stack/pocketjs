// demos/music/app.tsx — "music player" showcase: the one demo with a genuinely
// continuous animation. The other three only ever tween TO a resting value
// (mount fades, focus transitions, a capped count-up); here the equalizer
// bars and the progress fill are DIRECT signal-driven style bindings
// (style={{height: ...}}, same mechanism as hero.tsx's underline
// translateX={count()*2}) stepped every frame for as long as playback runs —
// no animate()/spring() involved, no natural end. LTRIGGER/RTRIGGER skip
// tracks (the one button pair none of the other three demos touch); CIRCLE
// on the cover toggles play/pause, CIRCLE on a track row selects it.
//
// Design notes: every class a FULL literal (per-track cover accent baked per
// entry); text single-line.

import { Text, View, defineComponent } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { createSignal } from "@pocketjs/framework/reactivity";
import { BTN } from "@pocketjs/framework/input";
import { frameworkName } from "@pocketjs/framework";

interface Track {
  title: string;
  artist: string;
  /** cover/play-pause control: FULL literal (fixed size + per-track accent). */
  coverCls: string;
}

const TRACKS: Track[] = [
  {
    title: "MIDNIGHT REPLAY",
    artist: "SYNC PULSE",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-blue-500 to-blue-700 border-blue-300 focus:border-slate-900 transition-colors duration-150",
  },
  {
    title: "GLASS HORIZON",
    artist: "AMBER TIDE",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-amber-400 to-amber-700 border-amber-300 focus:border-slate-900 transition-colors duration-150",
  },
  {
    title: "STATIC BLOOM",
    artist: "NEON DRIFTERS",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-cyan-500 to-cyan-700 border-cyan-300 focus:border-slate-900 transition-colors duration-150",
  },
];

const TRACK_FRAMES = 300; // 5s per track at 60 Hz (demo-length, not the real song)
const PROGRESS_TRACK_W = 160; // progress track px — matches the w-[160] track class

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default defineComponent(function Music() {
  const [trackIndex, setTrackIndex] = createSignal(0);
  const [playing, setPlaying] = createSignal(true);
  const [position, setPosition] = createSignal(0); // frames into the current track
  const [barsFrame, setBarsFrame] = createSignal(0);

  const selectTrack = (i: number) => {
    setTrackIndex(i);
    setPosition(0);
    setPlaying(true);
  };

  const nextTrack = () => {
    setTrackIndex((trackIndex() + 1) % TRACKS.length);
    setPosition(0);
  };

  const prevTrack = () => {
    setTrackIndex((trackIndex() - 1 + TRACKS.length) % TRACKS.length);
    setPosition(0);
  };

  onButtonPress(BTN.LTRIGGER, prevTrack);
  onButtonPress(BTN.RTRIGGER, nextTrack);
  onFrame(() => {
    if (!playing()) return;
    setBarsFrame(barsFrame() + 1);
    const p = position() + 1;
    if (p >= TRACK_FRAMES) nextTrack();
    else setPosition(p);
  });

  const barHeight = (i: number): number => {
    if (!playing()) return 6;
    const v = Math.abs(Math.sin(barsFrame() * 0.15 + i * 1.7));
    return 6 + Math.round(v * 20);
  };

  const track = () => TRACKS[trackIndex()];
  const pct = () => Math.round((position() / TRACK_FRAMES) * 100);

  return (
    <View class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">PSP-UI SHOWCASE · {frameworkName()}</Text>
          <Text class="text-2xl text-slate-950 font-bold">Now Playing</Text>
        </View>
        <Text class="text-xs text-slate-500">TRACK {trackIndex() + 1} / {TRACKS.length}</Text>
      </View>

      <View class="flex-row items-center gap-3">
        <View class={track().coverCls} focusable onPress={() => setPlaying(!playing())}>
          <Text class="text-base text-white font-bold">{playing() ? ">" : "II"}</Text>
        </View>

        <View class="flex-col grow gap-1">
          <Text class="text-base text-slate-950 font-bold">{track().title}</Text>
          <Text class="text-xs text-slate-600">{track().artist}</Text>
          <View class="flex-row items-center gap-2">
            <View class="w-[160] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
              <View
                class="h-2 w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
                style={{ width: (position() / TRACK_FRAMES) * PROGRESS_TRACK_W }}
              />
            </View>
            <Text class="text-xs text-slate-500">{pct()}%</Text>
          </View>
        </View>

        <View class="flex-row items-end gap-1 h-16">
          {([0, 1, 2, 3] as const).map((i) => (
            <View class="w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600" style={{ height: barHeight(i) }} />
          ))}
        </View>
      </View>

      <View class="flex-col gap-1">
        {TRACKS.map((t, i) => (
          <View
            class={
              trackIndex() === i
                ? "flex-row items-center justify-between p-1 rounded-lg shadow bg-blue-50 border-blue-500 focus:border-blue-600 transition-colors duration-150"
                : "flex-row items-center justify-between p-1 rounded-lg shadow bg-white border-slate-200 focus:border-blue-500 transition-colors duration-150"
            }
            focusable
            onPress={() => selectTrack(i)}
          >
            <Text class="text-xs text-slate-900">{t.title}</Text>
            <Text class="text-xs text-slate-500">{t.artist}</Text>
          </View>
        ))}
      </View>

      <Text class="text-xs text-slate-500">UP / DOWN focus · CIRCLE play/select · L/R skip track</Text>
    </View>
  );
});
