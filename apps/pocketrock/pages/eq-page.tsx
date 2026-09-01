import { For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

/** A single EQ band as supplied by the owning player/settings page. */
export interface EqBand {
  /** Display label, for example `60 Hz` or `1 kHz`. */
  frequency: string;
  /** Gain in dB. The visual range is clamped to -12..+12 dB. */
  gain: number;
}

export type EqSelection = "enabled" | "preset" | "bands";

export interface EqPageProps {
  enabled: boolean;
  preset: string;
  presets?: readonly string[];
  bands: readonly EqBand[];
  /** Index of the band highlighted by the click wheel. */
  selectedBand: number;
  /** Optional control selection, useful when the parent maps wheel focus. */
  selectedControl?: EqSelection;
  /** True while LEFT/RIGHT changes the selected band's gain. */
  adjusting?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  onPresetChange?: (preset: string) => void;
  onBandSelect?: (index: number) => void;
  /** Request one LEFT (-1) or RIGHT (+1) gain step for the selected band. */
  onAdjust?: (index: number, direction: -1 | 1) => void;
}

export const DEFAULT_EQ_PRESETS = ["Flat", "Rock", "Acoustic", "Bass Boost"] as const;
export const DEFAULT_EQ_BANDS: readonly EqBand[] = [
  { frequency: "60 Hz", gain: 0 },
  { frequency: "250 Hz", gain: 0 },
  { frequency: "1 kHz", gain: 0 },
  { frequency: "4 kHz", gain: 0 },
  { frequency: "12 kHz", gain: 0 },
];

const TOP_BAR =
  "absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]";
const CONTROL_TEXT = "text-xs text-[#18202a] font-bold";
const CONTROL_SELECTED_TEXT = "text-xs text-white font-bold";
const BAND_TEXT = "text-xs text-[#18202a]";
const BAND_SELECTED_TEXT = "text-xs text-white font-bold";

function clampGain(gain: number): number {
  return Math.max(-12, Math.min(12, Number.isFinite(gain) ? gain : 0));
}

function gainLabel(gain: number): string {
  const value = Math.round(clampGain(gain) * 10) / 10;
  if (value > 0) return `+${value} dB`;
  return `${value} dB`;
}

function nextPreset(current: string, presets: readonly string[]): string {
  if (presets.length === 0) return current;
  const index = presets.indexOf(current);
  return presets[(index + 1 + presets.length) % presets.length] ?? current;
}

function TopBar(props: { enabled: boolean }) {
  return (
    <View class={TOP_BAR} debugName="EqTopBar">
      <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
        <Text class="text-xs text-white font-bold">MENU: Back</Text>
      </View>
      <Text class="text-base text-white font-bold">Equalizer</Text>
      <Text class="absolute right-[8] top-[12] text-xs text-[#e9eef6] font-bold">
        {props.enabled ? "ON" : "OFF"}
      </Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function ToggleRow(props: EqPageProps) {
  const selected = () => props.selectedControl === "enabled";
  return (
    <View
      class={selected()
        ? "absolute left-[7] top-[4] w-[306] h-[25] flex-row items-center bg-[#2378d4] border border-[#1e67b6]"
        : "absolute left-[7] top-[4] w-[306] h-[25] flex-row items-center bg-[#e9edf2] border border-[#c3ccd8]"}
      focusable
      debugName="EqEnabled"
      onPress={() => props.onEnabledChange?.(!props.enabled)}
    >
      <Text class={selected() ? CONTROL_SELECTED_TEXT : CONTROL_TEXT}>Equalizer</Text>
      <Text class={selected() ? "absolute left-[68] text-xs text-[#d9eaff]" : "absolute left-[68] text-xs text-[#687484]"}>
        Master tone
      </Text>
      <View class="absolute right-[8] top-[5] w-[36] h-[14] rounded-[7] bg-[#c7d0dc] border border-[#98a8bb]">
        <View
          class={props.enabled ? "absolute left-[19] top-[1] w-[12] h-[10] rounded-[5] bg-[#2378d4]" : "absolute left-[2] top-[1] w-[12] h-[10] rounded-[5] bg-[#71839e]"}
        />
      </View>
      <Text class={selected() ? "absolute right-[51] text-xs text-white font-bold" : "absolute right-[51] text-xs text-[#566273] font-bold"}>
        {props.enabled ? "ON" : "OFF"}
      </Text>
    </View>
  );
}

function PresetRow(props: EqPageProps) {
  const selected = () => props.selectedControl === "preset";
  const presets = () => props.presets ?? DEFAULT_EQ_PRESETS;
  return (
    <View
      class={selected()
        ? "absolute left-[7] top-[31] w-[306] h-[25] flex-row items-center bg-[#2378d4] border border-[#1e67b6]"
        : "absolute left-[7] top-[31] w-[306] h-[25] flex-row items-center bg-[#e9edf2] border border-[#c3ccd8]"}
      focusable
      debugName="EqPreset"
      onPress={() => props.onPresetChange?.(nextPreset(props.preset, presets()))}
    >
      <Text class={selected() ? CONTROL_SELECTED_TEXT : CONTROL_TEXT}>Preset</Text>
      <Text class={selected() ? "absolute left-[68] text-xs text-[#d9eaff]" : "absolute left-[68] text-xs text-[#687484]"}>
        tap to cycle
      </Text>
      <Text class={selected() ? "absolute right-[10] text-xs text-white font-bold" : "absolute right-[10] text-xs text-[#2378d4] font-bold"}>
        {props.preset}
      </Text>
    </View>
  );
}

function GainTrack(props: { gain: number; selected: boolean }) {
  const gain = () => clampGain(props.gain);
  const fillWidth = () => Math.round(Math.abs(gain()) / 12 * 57);
  const fillOffset = () => gain() < 0 ? 59 - fillWidth() : 59;
  return (
    <View class="absolute left-[67] top-[8] w-[118] h-[9] bg-[#d8dee6] border border-[#aeb9c7] overflow-hidden">
      <View class={props.selected ? "absolute top-0 h-[7] bg-[#d9edff]" : "absolute top-0 h-[7] bg-[#5e9fdf]"} style={{ width: fillWidth(), translateX: fillOffset() }} />
      <View class={props.selected ? "absolute left-[58] top-0 w-[1] h-[7] bg-[#ffffff]" : "absolute left-[58] top-0 w-[1] h-[7] bg-[#6f7c8c]"} />
    </View>
  );
}

function BandRow(props: { band: EqBand; index: number; selected: boolean; onSelect?: (index: number) => void }) {
  return (
    <View
      class={props.selected
        ? "absolute left-[7] w-[306] flex-row items-center bg-[#2378d4]"
        : "absolute left-[7] w-[306] flex-row items-center"}
      style={{ top: 74 + props.index * 24, height: 24 }}
      focusable
      debugName={`EqBand:${props.band.frequency}`}
      onPress={() => props.onSelect?.(props.index)}
    >
      <Text class={props.selected ? BAND_SELECTED_TEXT : BAND_TEXT}>{props.band.frequency}</Text>
      <GainTrack gain={props.band.gain} selected={props.selected} />
      <Text class={props.selected ? "absolute right-[8] text-xs text-white font-bold" : "absolute right-[8] text-xs text-[#405064]"}>
        {gainLabel(props.band.gain)}
      </Text>
      <Show when={!props.selected}>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#d5d9df]" />
      </Show>
    </View>
  );
}

/**
 * 320x240 PocketRock equalizer surface.
 *
 * This component intentionally owns no service calls or local EQ state. The
 * shell supplies the current values and applies changes from the callbacks,
 * so it can be reused by the USB/settings flows without coupling the screen
 * to Rockbox host availability.
 */
export function EqPage(props: EqPageProps) {
  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden" debugName="EqPage">
      <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#f5f6f8] overflow-hidden">
        <ToggleRow {...props} />
        <PresetRow {...props} />
        <View class="absolute left-[7] top-[59] w-[306] h-[15] flex-row items-center">
          <Text class="absolute left-[4] text-xs text-[#687484] font-bold">BAND</Text>
          <Text class="absolute left-[67] text-xs text-[#687484] font-bold">GAIN</Text>
          <Text class="absolute right-[8] text-xs text-[#687484] font-bold">VALUE</Text>
        </View>
        <For each={props.bands.slice(0, 5)}>
          {(band, index) =>
            <BandRow
              band={band}
              index={index()}
              selected={
                (props.selectedControl === undefined || props.selectedControl === "bands") &&
                index() === Math.max(0, Math.min(props.bands.length - 1, props.selectedBand))
              }
              onSelect={props.onBandSelect}
            />
          }
        </For>
        <View class="absolute left-0 right-0 bottom-0 h-[10] flex-row items-center bg-[#e2e6eb] border-t border-[#c2cad4]">
          <Text class="absolute left-[9] text-xs text-[#687484]">
            {props.adjusting ? "LEFT / RIGHT  ADJUST" : "CLICK  SELECT   LEFT / RIGHT  ADJUST"}
          </Text>
        </View>
      </View>
      <TopBar enabled={props.enabled} />
    </View>
  );
}

export default EqPage;
