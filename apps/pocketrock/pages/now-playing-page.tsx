import { Show } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";

export type RepeatMode = "off" | "all" | "one";

/** Data supplied by the Rockbox playback service; the page owns no playback state. */
export interface NowPlayingPageProps {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  playing?: boolean;
  volume?: number;
  shuffle?: boolean;
  repeat?: RepeatMode;
  back?: boolean;
}

const TRACK_LIMIT = 29;
const META_LIMIT = 32;
const PROGRESS_WIDTH = 296;

function clipped(value: string | undefined, fallback: string, limit: number): string {
  const text = value?.trim() || fallback;
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function bounded(value: number | undefined, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value! : min));
}

function clock(seconds: number | undefined): string {
  const total = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds! : 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function repeatLabel(mode: RepeatMode | undefined): string {
  switch (mode) {
  case "one": return "REPEAT 1";
  case "all": return "REPEAT ALL";
  default: return "REPEAT OFF";
  }
}

/**
 * A fixed 320x240 now-playing surface for the PocketRock shell.
 * Artwork is deliberately optional so an unloaded cover never costs a texture.
 */
export default function NowPlayingPage(props: NowPlayingPageProps) {
  const duration = () => Math.max(0, Number.isFinite(props.durationSeconds) ? props.durationSeconds! : 0);
  const position = () => bounded(props.positionSeconds, 0, duration());
  const progress = () => duration() > 0 ? Math.round(PROGRESS_WIDTH * position() / duration()) : 0;
  const volume = () => Math.round(bounded(props.volume, 0, 100));

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
        <Show when={props.back}>
          <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
            <Text class="text-xs text-white font-bold">MENU: Back</Text>
          </View>
        </Show>
        <Text class="text-base text-white font-bold">Now Playing</Text>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
      </View>

      <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#eef1f5]">
        <View class="absolute left-[12] top-[12] w-[78] h-[78] rounded-[5] bg-[#25354b] border border-[#69798e] overflow-hidden">
          <Show
            when={props.artwork}
            fallback={<View class="absolute left-0 top-0 w-[78] h-[78] bg-gradient-to-br from-[#6d7f99] via-[#40546e] to-[#25354b]" />}
          >
            <Image class="w-[78] h-[78]" src={props.artwork} />
          </Show>
          <Show when={!props.artwork}>
            <View class="absolute left-[17] top-[17] w-[44] h-[44] rounded-full border-[4] border-[#b8c4d3]">
              <View class="absolute left-[15] top-[15] w-[6] h-[6] rounded-full bg-[#dbe3ec]" />
            </View>
          </Show>
        </View>

        <View class="absolute left-[102] top-[12] w-[206] h-[78] overflow-hidden">
          <Text class={props.playing === false ? "text-xs text-[#6e7886] font-bold" : "text-xs text-[#2378d4] font-bold"}>
            {props.playing === false ? "PAUSED" : "NOW PLAYING"}
          </Text>
          <Text class="mt-[2] h-[19] text-base text-[#18202a] font-bold">
            {clipped(props.title, "Nothing Playing", TRACK_LIMIT)}
          </Text>
          <Text class="mt-[1] h-[15] text-xs text-[#405166]">
            {clipped(props.artist, "Select a track", META_LIMIT)}
          </Text>
          <Text class="mt-[1] h-[15] text-xs text-[#697586]">
            {clipped(props.album, "Unknown album", META_LIMIT)}
          </Text>
        </View>

        <View class="absolute left-[12] top-[106] w-[296] h-[38]">
          <View class="flex-row justify-between">
            <Text class="text-xs text-[#405166] font-bold">{clock(position())}</Text>
            <Text class="text-xs text-[#697586]">{clock(duration())}</Text>
          </View>
          <View class="absolute left-0 top-[19] w-[296] h-[5] rounded-[3] bg-[#c3cbd5] overflow-hidden">
            <View class="h-[5] rounded-[3] bg-[#2378d4]" style={{ width: progress() }} />
          </View>
          <Text class="absolute left-0 top-[28] text-xs text-[#697586]">{props.playing === false ? "Stopped" : "Playing"}</Text>
          <Text class="absolute right-0 top-[28] text-xs text-[#405166]">VOL {volume()}%</Text>
        </View>

        <View class="absolute left-[12] top-[158] w-[296] h-[34] flex-row items-center justify-between border-t border-[#cdd4dd]">
          <Text class="text-xs text-[#405166] font-bold">{props.shuffle ? "SHUFFLE ON" : "SHUFFLE OFF"}</Text>
          <Text class="text-xs text-[#405166] font-bold">{repeatLabel(props.repeat)}</Text>
          <Text class="text-xs text-[#697586]">SELECT Play</Text>
        </View>
      </View>
    </View>
  );
}
