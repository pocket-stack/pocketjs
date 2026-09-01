import { Show, type JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

export type SoundSettingKey =
  | "volume"
  | "balance"
  | "bass"
  | "treble"
  | "channelMode"
  | "crossfeed"
  | "equalizer";

export type ChannelMode = "Stereo" | "Mono" | "Custom";

/** Values are owned by the shell/service layer; this page only renders them. */
export interface SoundSettingsModel {
  /** Rockbox centibels, normally -7400 through 0. */
  volume: number;
  /** -100 is fully left, 0 is centered, 100 is fully right. */
  balance: number;
  /** Rockbox sound-unit values, normally -24 through 24. */
  bass: number;
  treble: number;
  channelMode: ChannelMode;
  crossfeed: boolean;
}

export interface SoundSettingsPageProps {
  model: SoundSettingsModel;
  /** The highlighted row, from 0 (Volume) through 6 (Equalizer). */
  selected: number;
  /** True while LEFT/RIGHT is adjusting the selected setting. */
  adjusting?: boolean;
  /** Request moving the row highlight; no input/service code lives here. */
  onSelect?: (index: number) => void;
  /** Request one LEFT (-1) or RIGHT (+1) adjustment for the selected setting. */
  onAdjust?: (key: Exclude<SoundSettingKey, "equalizer">, direction: -1 | 1) => void;
  /** Request navigation to the full equalizer page. */
  onOpenEqualizer?: () => void;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function signed(value: number, suffix = ""): string {
  return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

function volumeLabel(centibels: number): string {
  return centibels <= -7400 ? "Mute" : `${(centibels / 100).toFixed(1)} dB`;
}

function TopBar() {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
        <Text class="text-xs text-white font-bold">MENU: Back</Text>
      </View>
      <Text class="text-base text-white font-bold">Sound Settings</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function Row(props: {
  label: string;
  selected: boolean;
  adjusting: boolean;
  onPress?: () => void;
  children: JSX.Element;
}) {
  return (
    <View
      class={props.selected
        ? "relative w-[320] h-[29] flex-row items-center pl-[12] pr-[10] bg-[#2378d4]"
        : "relative w-[320] h-[29] flex-row items-center pl-[12] pr-[10] bg-[#f5f6f8]"}
      focusable={Boolean(props.onPress)}
      onPress={props.onPress}
    >
      <Text class={props.selected ? "w-[82] text-sm font-bold text-white" : "w-[82] text-sm font-bold text-[#18202a]"}>
        {props.label}
      </Text>
      <View class="flex-1 h-[29] flex-row items-center justify-end">{props.children}</View>
      <Show when={!props.selected}>
        <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
      </Show>
      <Show when={props.selected && props.adjusting}>
        <Text class="absolute right-[10] bottom-[1] text-[9] text-[#dcecff]">LEFT / RIGHT</Text>
      </Show>
    </View>
  );
}

function Slider(props: {
  value: number;
  minimum: number;
  maximum: number;
  label: string;
  selected: boolean;
}) {
  const fraction = clamp((props.value - props.minimum) / (props.maximum - props.minimum), 0, 1);
  const fillWidth = Math.round(fraction * 126);
  const thumbX = clamp(fillWidth - 3, 0, 120);
  return (
    <>
      <Text class={props.selected ? "w-[58] text-right text-xs text-white" : "w-[58] text-right text-xs text-[#526170]"}>
        {props.label}
      </Text>
      <View class={props.selected ? "relative ml-[8] w-[126] h-[5] rounded-[3] bg-[#7eb7ec]" : "relative ml-[8] w-[126] h-[5] rounded-[3] bg-[#c1c9d2]"}>
        <View class={props.selected ? "absolute left-0 top-0 h-[5] rounded-[3] bg-white" : "absolute left-0 top-0 h-[5] rounded-[3] bg-[#4a7eaf]"} style={{ width: fillWidth }} />
        <View class={props.selected ? "absolute top-[-3] w-[7] h-[11] rounded-[2] border bg-[#e9f4ff] border-[#205b95]" : "absolute top-[-3] w-[7] h-[11] rounded-[2] border bg-[#eff3f7] border-[#687786]"} style={{ translateX: thumbX }} />
      </View>
    </>
  );
}

function Value(props: { children: JSX.Element; selected: boolean }) {
  return (
    <Text class={props.selected ? "text-sm text-white" : "text-sm text-[#526170]"}>{props.children}</Text>
  );
}

/**
 * A 320x240 iPod list page. It is deliberately service-free: the host wires
 * wheel/button input into the callbacks and commits any setting changes.
 */
export default function SoundSettingsPage(props: SoundSettingsPageProps) {
  const isSelected = (index: number) => props.selected === index;
  const isAdjusting = (index: number) => isSelected(index) && Boolean(props.adjusting);

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-[36] w-[320] h-[204] overflow-hidden">
        <Row label="Volume" selected={isSelected(0)} adjusting={isAdjusting(0)} onPress={() => props.onSelect?.(0)}>
          <Slider value={props.model.volume} minimum={-7400} maximum={0} label={volumeLabel(props.model.volume)} selected={isSelected(0)} />
        </Row>
        <Row label="Balance" selected={isSelected(1)} adjusting={isAdjusting(1)} onPress={() => props.onSelect?.(1)}>
          <Slider value={props.model.balance} minimum={-100} maximum={100} label={props.model.balance === 0 ? "Center" : signed(props.model.balance)} selected={isSelected(1)} />
        </Row>
        <Row label="Bass" selected={isSelected(2)} adjusting={isAdjusting(2)} onPress={() => props.onSelect?.(2)}>
          <Slider value={props.model.bass} minimum={-24} maximum={24} label={signed(props.model.bass, " dB")} selected={isSelected(2)} />
        </Row>
        <Row label="Treble" selected={isSelected(3)} adjusting={isAdjusting(3)} onPress={() => props.onSelect?.(3)}>
          <Slider value={props.model.treble} minimum={-24} maximum={24} label={signed(props.model.treble, " dB")} selected={isSelected(3)} />
        </Row>
        <Row label="Channel Mode" selected={isSelected(4)} adjusting={isAdjusting(4)} onPress={() => props.onSelect?.(4)}>
          <Value selected={isSelected(4)}>{isAdjusting(4) ? `‹ ${props.model.channelMode} ›` : props.model.channelMode}</Value>
        </Row>
        <Row label="Crossfeed" selected={isSelected(5)} adjusting={isAdjusting(5)} onPress={() => props.onSelect?.(5)}>
          <Value selected={isSelected(5)}>{isAdjusting(5) ? `‹ ${props.model.crossfeed ? "On" : "Off"} ›` : props.model.crossfeed ? "On" : "Off"}</Value>
        </Row>
        <Row label="Equalizer" selected={isSelected(6)} adjusting={false} onPress={props.onOpenEqualizer}>
          <Text class={isSelected(6) ? "text-lg text-white" : "text-lg text-[#526170]"}>›</Text>
        </Row>
      </View>
      <TopBar />
    </View>
  );
}

/** Convenient callback adapter for hosts that map buttons to an active row. */
export function adjustSoundSetting(
  props: SoundSettingsPageProps,
  direction: -1 | 1,
): void {
  const keys: readonly SoundSettingKey[] = [
    "volume", "balance", "bass", "treble", "channelMode", "crossfeed", "equalizer",
  ];
  const key = keys[clamp(props.selected, 0, keys.length - 1)];
  if (key !== "equalizer") props.onAdjust?.(key, direction);
}
