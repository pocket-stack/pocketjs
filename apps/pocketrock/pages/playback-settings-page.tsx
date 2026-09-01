import { For, Show, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

/** Stable ids for the settings exposed by the Rockbox playback service. */
export type PlaybackSettingId =
  | "repeat"
  | "shuffle"
  | "resume"
  | "crossfade"
  | "replaygain"
  | "skip-length"
  | "auto-change-directory"
  | (string & {});

/** One row in the playback settings list. The shell owns its value/state. */
export interface PlaybackSettingRow {
  id: PlaybackSettingId;
  label: string;
  value: string;
  /** Adds the left/right affordance to the focused row when supplied. */
  adjustable?: boolean;
  disabled?: boolean;
}

export interface PlaybackSettingsPageProps {
  /** Defaults to Playback. */
  title?: string;
  /** The shell's current setting snapshot. No defaults are applied in-page. */
  rows?: readonly PlaybackSettingRow[];
  /** Selected row index in the complete (not just visible) list. */
  selected?: number;
  /** Pixel list offset, normally driven by the shell's wheel scroller. */
  offset?: number;
  /** Shows the MENU: Back affordance in the title bar. */
  back?: boolean;
  /** Optional status copy shown above the wheel hint. */
  notice?: string;
  /** Called by a touch/host surface; wheel button routing remains in the shell. */
  onPress?: (row: PlaybackSettingRow, index: number) => void;
  /** Direction is -1 for left and +1 for right. */
  onAdjust?: (row: PlaybackSettingRow, direction: -1 | 1, index: number) => void;
}

/** Useful fixture/default presentation for shells that have not read the host yet. */
export const DEFAULT_PLAYBACK_SETTINGS: readonly PlaybackSettingRow[] = [
  { id: "repeat", label: "Repeat", value: "All", adjustable: true },
  { id: "shuffle", label: "Shuffle", value: "Off", adjustable: true },
  { id: "resume", label: "Resume Playback", value: "Ask", adjustable: true },
  { id: "crossfade", label: "Crossfade", value: "Off", adjustable: true },
  { id: "replaygain", label: "ReplayGain", value: "Track", adjustable: true },
  { id: "skip-length", label: "Skip Length", value: "5 sec", adjustable: true },
  { id: "auto-change-directory", label: "Auto-Change Dir", value: "On", adjustable: true },
];

const ROW_H = 30;
const LIST_TOP = 36;
const LIST_H = 180;
const FOOTER_TOP = LIST_TOP + LIST_H;
const SCREEN_W = 320;
const SCREEN_H = 240;
const WINDOW_ROWS = Math.ceil(LIST_H / ROW_H) + 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compact 320x240 playback settings surface. It deliberately has no local
 * setting state: changing a value belongs to the host service, then the shell
 * passes the new row model back through props. This keeps USB/service changes
 * from leaving a stale settings page behind.
 */
export default function PlaybackSettingsPage(props: PlaybackSettingsPageProps) {
  const rows = () => props.rows ?? DEFAULT_PLAYBACK_SETTINGS;
  const selected = createMemo(() => rows().length
    ? clamp(Math.trunc(props.selected ?? 0), 0, rows().length - 1)
    : 0);
  const offset = () => Math.max(0, props.offset ?? 0);
  const first = createMemo(() => Math.max(
    0,
    Math.min(Math.max(0, rows().length - WINDOW_ROWS), Math.floor(offset() / ROW_H) - 1),
  ));
  const visible = createMemo(() => rows().slice(first(), first() + WINDOW_ROWS));
  const translateY = createMemo(() => first() * ROW_H - offset());
  const selectionY = createMemo(() => selected() * ROW_H - offset());

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
        <Show when={props.back}>
          <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
            <Text class="text-xs text-white font-bold">MENU: Back</Text>
          </View>
        </Show>
        <Text class="text-base text-white font-bold">{props.title ?? "Playback"}</Text>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
      </View>

      <Show when={rows().length > 0} fallback={
        <View class="absolute left-0 top-[36] w-[320] h-[180] flex-col items-center justify-center bg-[#f5f6f8]">
          <Text class="text-sm text-[#364250] font-bold">No playback settings</Text>
          <Text class="mt-[4] text-xs text-[#778392]">Playback service unavailable</Text>
        </View>
      }>
        <View class="absolute left-0 top-[36] w-[320] h-[180] overflow-hidden">
          <View class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]" style={{ translateY: selectionY() }} />
          <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
            <For each={visible()}>{(row, visibleIndex) => {
              const rowIndex = () => first() + visibleIndex();
              const focused = () => rowIndex() === selected();
              const textClass = () => row.disabled
                ? "text-sm text-[#98a1ac]"
                : focused()
                  ? "text-sm text-white font-bold"
                  : "text-sm text-[#18202a] font-bold";
              const valueClass = () => row.disabled
                ? "absolute right-[10] top-[9] text-xs text-[#a6aeb8]"
                : focused()
                  ? "absolute right-[10] top-[9] text-xs text-[#e0ebf8] font-bold"
                  : "absolute right-[10] top-[9] text-xs text-[#687484]";
              return (
                <View
                  class="relative w-[320] h-[30]"
                  focusable={!row.disabled}
                  onPress={() => {
                    if (!row.disabled) props.onPress?.(row, rowIndex());
                  }}
                >
                  <Text class={textClass()}>{row.label}</Text>
                  <Text class={valueClass()}>{row.value}</Text>
                  <Show when={rowIndex() + 1 < rows().length && !focused() && rowIndex() + 1 !== selected()}>
                    <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
                  </Show>
                </View>
              );
            }}</For>
          </View>
        </View>
      </Show>

      <View class="absolute left-0 top-[216] w-[320] h-[24] flex-row items-center justify-between px-[8] bg-[#e5e9ee] border-t border-[#c5cdd7]">
        <Text class="text-[10px] text-[#526274] font-bold">WHEEL: SELECT</Text>
        <Text class="text-[10px] text-[#526274] font-bold">L/R: ADJUST</Text>
        <Text class="text-[10px] text-[#697586]">MENU: BACK</Text>
      </View>
      <Show when={props.notice}>
        <Text class="absolute left-[8] top-[198] text-[10px] text-[#697586]">{props.notice}</Text>
      </Show>
    </View>
  );
}

export { SCREEN_W, SCREEN_H };
