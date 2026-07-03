// demos/music.tsx — "music player" showcase: the one demo with a genuinely
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

import { createSignal } from "solid-js";
import { BTN } from "../spec/spec.ts";
import type { NodeMirror } from "../src/renderer.ts";

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
// Transport state + frame driver (wired by music-main.tsx)
// ---------------------------------------------------------------------------

const [trackIndex, setTrackIndex] = createSignal(0);
const [playing, setPlaying] = createSignal(true);
const [position, setPosition] = createSignal(0); // frames into the current track
const [barsFrame, setBarsFrame] = createSignal(0);
let prevButtons = 0;

function selectTrack(i: number): void {
  setTrackIndex(i);
  setPosition(0);
  setPlaying(true);
}

function nextTrack(): void {
  setTrackIndex((trackIndex() + 1) % TRACKS.length);
  setPosition(0);
}

function prevTrack(): void {
  setTrackIndex((trackIndex() - 1 + TRACKS.length) % TRACKS.length);
  setPosition(0);
}

/** height in px — a resting flat line when paused, a bounded pseudo-random
 *  bounce (per-bar phase offset) while playing. Pure function of barsFrame,
 *  so goldens stay byte-exact for a fixed frame index. */
function barHeight(i: number): number {
  if (!playing()) return 6;
  const v = Math.abs(Math.sin(barsFrame() * 0.15 + i * 1.7));
  return 6 + Math.round(v * 20);
}

export function musicFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (pressed & BTN.LTRIGGER) prevTrack();
  if (pressed & BTN.RTRIGGER) nextTrack();
  if (playing()) {
    setBarsFrame(barsFrame() + 1);
    const p = position() + 1;
    if (p >= TRACK_FRAMES) nextTrack();
    else setPosition(p);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function Music() {
  const track = () => TRACKS[trackIndex()];
  const pct = () => Math.round((position() / TRACK_FRAMES) * 100);

  return (
    <view class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <view class="flex-row items-end justify-between">
        <view class="flex-col">
          <text class="text-xs text-blue-600 tracking-wide">PSP-UI SHOWCASE</text>
          <text class="text-2xl text-slate-950 font-bold">Now Playing</text>
        </view>
        <text class="text-xs text-slate-500">TRACK {trackIndex() + 1} / {TRACKS.length}</text>
      </view>

      <view class="flex-row items-center gap-3">
        <view class={track().coverCls} focusable onPress={() => setPlaying(!playing())}>
          <text class="text-base text-white font-bold">{playing() ? ">" : "II"}</text>
        </view>

        <view class="flex-col grow gap-1">
          <text class="text-base text-slate-950 font-bold">{track().title}</text>
          <text class="text-xs text-slate-600">{track().artist}</text>
          <view class="flex-row items-center gap-2">
            <view class="w-[160] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
              <view
                class="h-2 w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
                style={{ width: (position() / TRACK_FRAMES) * PROGRESS_TRACK_W }}
              />
            </view>
            <text class="text-xs text-slate-500">{pct()}%</text>
          </view>
        </view>

        <view class="flex-row items-end gap-1 h-16">
          {([0, 1, 2, 3] as const).map((i) => (
            <view class="w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600" style={{ height: barHeight(i) }} />
          ))}
        </view>
      </view>

      <view class="flex-col gap-1">
        {TRACKS.map((t, i) => (
          <view
            class={
              trackIndex() === i
                ? "flex-row items-center justify-between p-1 rounded-lg shadow bg-blue-50 border-blue-500 focus:border-blue-600 transition-colors duration-150"
                : "flex-row items-center justify-between p-1 rounded-lg shadow bg-white border-slate-200 focus:border-blue-500 transition-colors duration-150"
            }
            focusable
            onPress={() => selectTrack(i)}
          >
            <text class="text-xs text-slate-900">{t.title}</text>
            <text class="text-xs text-slate-500">{t.artist}</text>
          </view>
        ))}
      </view>

      <text class="text-xs text-slate-500">UP / DOWN focus · CIRCLE play/select · L/R skip track</text>
    </view>
  );
}
