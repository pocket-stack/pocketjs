import { For, Show, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

/** A setting is rendered entirely from this model; input and persistence stay in the shell. */
export type DisplaySettingRow =
  | {
    id: string;
    kind: "slider";
    label: string;
    value: number;
    min: number;
    max: number;
    valueLabel?: string;
  }
  | {
    id: string;
    kind: "toggle";
    label: string;
    value: boolean;
    onLabel?: string;
    offLabel?: string;
  }
  | {
    id: string;
    kind: "enum";
    label: string;
    value: string;
  };

export interface DisplaySettingsPageProps {
  /** Display model, normally backed by Rockbox settings in the parent shell. */
  rows: readonly DisplaySettingRow[];
  /** Focused row in `rows`. */
  selected: number;
  /** Pixel scroll offset.  Rows are 30px, matching the main contact list. */
  offset?: number;
  title?: string;
  back?: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: readonly DisplaySettingRow[] = [
  { id: "brightness", kind: "slider", label: "Brightness", value: 68, min: 0, max: 100, valueLabel: "68%" },
  { id: "backlight-timeout", kind: "enum", label: "Backlight Timeout", value: "10 seconds" },
  { id: "backlight-charge", kind: "toggle", label: "Backlight on Charge", value: true },
  { id: "fade", kind: "toggle", label: "Fade In / Out", value: true },
  { id: "scroll-speed", kind: "enum", label: "Scroll Speed", value: "Fast" },
  { id: "lcd-sleep", kind: "enum", label: "LCD Sleep", value: "5 minutes" },
];

const ROW_HEIGHT = 30;
const BODY_HEIGHT = 204;
const WINDOW_ROWS = Math.ceil(BODY_HEIGHT / ROW_HEIGHT) + 2;

function SliderControl(props: { row: Extract<DisplaySettingRow, { kind: "slider" }>; selected: boolean }) {
  const ratio = createMemo(() => {
    const span = props.row.max - props.row.min;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (props.row.value - props.row.min) / span));
  });
  const value = () => props.row.valueLabel ?? `${Math.round(props.row.value)}`;

  return (
    <View class="absolute right-[9] top-[6] w-[100] h-[18]">
      <Text class={props.selected ? "absolute right-0 top-0 text-xs text-white font-bold" : "absolute right-0 top-0 text-xs text-[#526172] font-bold"}>
        {value()}
      </Text>
      <View class={props.selected ? "absolute left-0 bottom-0 w-[76] h-[3] bg-[#9ec9f1]" : "absolute left-0 bottom-0 w-[76] h-[3] bg-[#bcc5cf]"}>
        <View class={props.selected ? "h-[3] bg-white" : "h-[3] bg-[#3d83c8]"} style={{ width: Math.round(ratio() * 76) }} />
      </View>
      <View
        class={props.selected ? "absolute bottom-[-2] w-[7] h-[7] rounded-[4] bg-white" : "absolute bottom-[-2] w-[7] h-[7] rounded-[4] bg-[#286da9]"}
        style={{ left: Math.round(ratio() * 69) }}
      />
    </View>
  );
}

function ToggleControl(props: { row: Extract<DisplaySettingRow, { kind: "toggle" }>; selected: boolean }) {
  const label = () => props.row.value ? (props.row.onLabel ?? "On") : (props.row.offLabel ?? "Off");
  const track = () => props.row.value
    ? (props.selected ? "bg-[#d8edff]" : "bg-[#5796cf]")
    : (props.selected ? "bg-[#7eadd8]" : "bg-[#aeb7c1]");
  const knob = () => props.row.value ? "left-[31]" : "left-[2]";

  return (
    <View class="absolute right-[9] top-[7] w-[55] h-[16]">
      <View class={props.row.value
        ? (props.selected
          ? "absolute left-0 top-0 w-[55] h-[16] rounded-[8] bg-[#d8edff]"
          : "absolute left-0 top-0 w-[55] h-[16] rounded-[8] bg-[#5796cf]")
        : (props.selected
          ? "absolute left-0 top-0 w-[55] h-[16] rounded-[8] bg-[#7eadd8]"
          : "absolute left-0 top-0 w-[55] h-[16] rounded-[8] bg-[#aeb7c1]")}>
        <View class={props.row.value
          ? "absolute top-[2] left-[31] w-[12] h-[12] rounded-[6] bg-white"
          : "absolute top-[2] left-[2] w-[12] h-[12] rounded-[6] bg-white"} />
      </View>
      <Text class={props.selected ? "absolute right-[18] top-[3] text-[8] text-[#1b5d98] font-bold" : "absolute right-[18] top-[3] text-[8] text-white font-bold"}>
        {label()}
      </Text>
    </View>
  );
}

function EnumControl(props: { row: Extract<DisplaySettingRow, { kind: "enum" }>; selected: boolean }) {
  return (
    <View class="absolute right-[9] top-[7] h-[16] flex-row items-center">
      <Text class={props.selected ? "text-xs text-white font-bold" : "text-xs text-[#526172] font-bold"}>{props.row.value}</Text>
      <Text class={props.selected ? "ml-[4] text-xs text-[#d8edff]" : "ml-[4] text-xs text-[#7b8795]"}>›</Text>
    </View>
  );
}

function RowControl(props: { row: DisplaySettingRow; selected: boolean }) {
  if (props.row.kind === "slider") return <SliderControl row={props.row} selected={props.selected} />;
  if (props.row.kind === "toggle") return <ToggleControl row={props.row} selected={props.selected} />;
  return <EnumControl row={props.row} selected={props.selected} />;
}

/**
 * 320x240 display-settings surface.  It intentionally only virtualizes a short
 * contact-list window so it stays cheap while the wheel is moving.
 */
export function DisplaySettingsPage(props: DisplaySettingsPageProps) {
  const offset = () => Math.max(0, props.offset ?? 0);
  const first = createMemo(() => Math.max(
    0,
    Math.min(
      Math.max(0, props.rows.length - WINDOW_ROWS),
      Math.floor(offset() / ROW_HEIGHT) - 1,
    ),
  ));
  const visible = createMemo(() => props.rows.slice(first(), first() + WINDOW_ROWS));
  const translateY = createMemo(() => first() * ROW_HEIGHT - offset());

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
        <Show when={props.back}>
          <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
            <Text class="text-xs text-white font-bold">MENU: Back</Text>
          </View>
        </Show>
        <Text class="text-base text-white font-bold">{props.title ?? "Display"}</Text>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
      </View>

      <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#f5f6f8] overflow-hidden">
        <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
          <For each={visible()}>{(row, index) => {
            const rowIndex = () => first() + index();
            const selected = () => rowIndex() === props.selected;
            return (
              <View class="relative w-[320] h-[30]">
                <Show when={selected()}>
                  <View class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]" />
                </Show>
                <Show when={!selected() && rowIndex() + 1 < props.rows.length && rowIndex() + 1 !== props.selected}>
                  <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
                </Show>
                <Text class={selected() ? "absolute left-[12] top-[7] text-sm text-white font-bold" : "absolute left-[12] top-[7] text-sm text-[#18202a] font-bold"}>
                  {row.label}
                </Text>
                <RowControl row={row} selected={selected()} />
              </View>
            );
          }}</For>
        </View>
      </View>
    </View>
  );
}
