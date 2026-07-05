import { computed, ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { BTN } from "@pocketjs/framework/vue-vapor/input";

interface Track {
  title: string;
  artist: string;
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

const TRACK_FRAMES = 300;
const PROGRESS_TRACK_W = 160;

export default function Music() {
  const trackIndex = ref(0);
  const playing = ref(true);
  const position = ref(0);
  const barsFrame = ref(0);
  const track = computed(() => TRACKS[trackIndex.value]);
  const pct = computed(() => Math.round((position.value / TRACK_FRAMES) * 100));

  const selectTrack = (i: number) => {
    trackIndex.value = i;
    position.value = 0;
    playing.value = true;
  };
  const nextTrack = () => {
    trackIndex.value = (trackIndex.value + 1) % TRACKS.length;
    position.value = 0;
  };
  const prevTrack = () => {
    trackIndex.value = (trackIndex.value - 1 + TRACKS.length) % TRACKS.length;
    position.value = 0;
  };
  const barHeight = (i: number): number => {
    if (!playing.value) return 6;
    const v = Math.abs(Math.sin(barsFrame.value * 0.15 + i * 1.7));
    return 6 + Math.round(v * 20);
  };

  onButtonPress(BTN.LTRIGGER, prevTrack);
  onButtonPress(BTN.RTRIGGER, nextTrack);
  onFrame(() => {
    if (!playing.value) return;
    barsFrame.value++;
    const p = position.value + 1;
    if (p >= TRACK_FRAMES) nextTrack();
    else position.value = p;
  });

  return (
    <View class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
        <View class="flex-row items-end justify-between">
          <View class="flex-col">
            <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
            <Text class="text-2xl text-slate-950 font-bold">Now Playing</Text>
          </View>
          <Text class="text-xs text-slate-500">TRACK {trackIndex.value + 1} / {TRACKS.length}</Text>
        </View>

        <View class="flex-row items-center gap-3">
          <View class={track.value.coverCls} focusable onPress={() => { playing.value = !playing.value; }}>
            <Text class="text-base text-white font-bold">{playing.value ? ">" : "II"}</Text>
          </View>

          <View class="flex-col grow gap-1">
            <Text class="text-base text-slate-950 font-bold">{track.value.title}</Text>
            <Text class="text-xs text-slate-600">{track.value.artist}</Text>
            <View class="flex-row items-center gap-2">
              <View class="w-[160] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
                <View
                  class="h-2 w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
                  style={{ width: (position.value / TRACK_FRAMES) * PROGRESS_TRACK_W }}
                />
              </View>
              <Text class="text-xs text-slate-500">{pct.value}%</Text>
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
                trackIndex.value === i
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

        <Text class="text-xs text-slate-500">UP / DOWN focus - CIRCLE play/select - L/R skip track</Text>
    </View>
  );
}
