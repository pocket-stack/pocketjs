import { For, Show, createMemo, type Accessor } from "solid-js";
import {
  Text,
  View,
} from "@pocketjs/framework/components";
import {
  CONTACT_LIST_HEIGHT,
  CONTACT_ROW_HEIGHT,
  contactSelectionY,
} from "../../../framework/src/ipod-list-motion.ts";

/** The visual mode is owned by the shell; this page does not install input handlers. */
export type QueuePageMode = "browse" | "move" | "remove";

export interface QueuePageItem {
  /** Stable queue index used by the playback service. */
  index: number;
  title: string;
  artist?: string;
  album?: string;
  path?: string;
}

export interface QueuePageProps {
  items: readonly QueuePageItem[];
  /** Zero-based position in `items`, rather than the service's queue index. */
  selected: number;
  /** Pixel scroll offset supplied by the shell's list scroller. */
  offset?: number;
  /** Service queue index of the item currently playing. */
  playingIndex?: number | null;
  mode?: QueuePageMode;
  title?: string;
  back?: boolean;
  /** Row presses are reported to the shell; no service is called here. */
  onSelect?: (position: number, item: QueuePageItem) => void;
  onPlay?: (position: number, item: QueuePageItem) => void;
  /** Called when the shell exposes a row press while in move mode. */
  onMove?: (position: number, item: QueuePageItem) => void;
  onRemove?: (position: number, item: QueuePageItem) => void;
}

const QUEUE_WINDOW_ROWS = Math.ceil(CONTACT_LIST_HEIGHT / CONTACT_ROW_HEIGHT) + 2;

function NavigationBar(props: { title: string; back: boolean; mode: QueuePageMode }) {
  const modeLabel = () => props.mode === "move" ? "MOVE" : props.mode === "remove" ? "DELETE" : "";
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4px] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
      </Show>
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <Show when={modeLabel()}>
        <View class="absolute right-[6] top-[8] h-[20] px-[6] flex-row items-center rounded-[3px] bg-[#40516a]">
          <Text class="text-xs text-white font-bold">{modeLabel()}</Text>
        </View>
      </Show>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function QueueRow(props: {
  position: Accessor<number>;
  item: Accessor<QueuePageItem>;
  playing: Accessor<boolean>;
  selected: Accessor<boolean>;
  onPress?: () => void;
}) {
  return (
    <View
      focusable={props.onPress !== undefined}
      onPress={props.onPress}
      class="relative w-[320] h-[30] flex-row items-center pl-[8] pr-[7]"
    >
      <Text class={props.selected() ? "w-[18] text-xs text-[#e7f1ff] text-right" : "w-[18] text-xs text-[#7c8795] text-right"}>
        {String(props.position() + 1).padStart(2, "0")}
      </Text>
      <Text class={props.playing() ? (props.selected() ? "w-[17] pl-[4] text-xs text-white font-bold" : "w-[17] pl-[4] text-xs text-[#1d5fa9] font-bold") : "w-[17] pl-[4] text-xs text-transparent"}>
        ▶
      </Text>
      <View class="flex-1 h-[28] flex-col justify-center overflow-hidden">
        <Text class={props.selected() ? "text-sm text-white font-bold" : "text-sm text-[#18202a] font-bold"}>
          {props.item().title || props.item().path || "Untitled"}
        </Text>
        <Show when={props.item().artist || props.item().album}>
          <Text class={props.selected() ? "text-xs text-[#d9e9ff]" : "text-xs text-[#687484]"}>
            {props.item().artist || props.item().album}
          </Text>
        </Show>
      </View>
    </View>
  );
}

function QueueList(props: QueuePageProps) {
  const offset = () => Math.max(0, props.offset ?? 0);
  const first = createMemo(() => Math.max(
    0,
    Math.min(
      Math.max(0, props.items.length - QUEUE_WINDOW_ROWS),
      Math.floor(offset() / CONTACT_ROW_HEIGHT) - 1,
    ),
  ));
  const visible = createMemo(() => props.items.slice(first(), first() + QUEUE_WINDOW_ROWS));
  const translateY = createMemo(() => first() * CONTACT_ROW_HEIGHT - offset());
  const selected = createMemo(() => Math.max(0, Math.min(props.items.length - 1, props.selected)));

  return (
    <View class="absolute left-0 top-0 w-[320] h-[204] bg-[#f5f6f8] overflow-hidden">
      <Show when={props.items.length > 0} fallback={
        <View class="absolute left-0 top-0 w-[320] h-[204] flex-col items-center justify-center bg-[#f5f6f8]">
          <Text class="text-base text-[#344255] font-bold">Queue is empty</Text>
          <Text class="mt-[4] text-xs text-[#7a8592]">Add music from the library</Text>
        </View>
      }>
        <View
          class="absolute left-0 top-0 w-[320] flex-col"
          style={{ translateY: translateY() }}
        >
          <For each={visible()}>{(_, index) => {
            const rowIndex = () => first() + index();
            return (
              <View class="relative w-[320] h-[30]">
                <Show when={rowIndex() + 1 < props.items.length}>
                  <View class="absolute left-[8] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
                </Show>
              </View>
            );
          }}</For>
        </View>

        <View
          class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]"
          style={{ translateY: contactSelectionY(selected(), offset()) }}
        />

        <View
          class="absolute left-0 top-0 w-[320] flex-col"
          style={{ translateY: translateY() }}
        >
          <For each={visible()}>{(item, index) => {
            const rowIndex = () => first() + index();
            return (
              <QueueRow
                position={rowIndex}
                item={() => item}
                playing={() => props.playingIndex === item.index}
                selected={() => rowIndex() === selected()}
                onPress={() => {
                  props.onSelect?.(rowIndex(), item);
                  if (props.mode === "remove") props.onRemove?.(rowIndex(), item);
                  else if (props.mode === "move") props.onMove?.(rowIndex(), item);
                  else props.onPlay?.(rowIndex(), item);
                }}
              />
            );
          }}</For>
        </View>
      </Show>
    </View>
  );
}

function ModeHint(props: { mode: QueuePageMode }) {
  return (
    <Show when={props.mode !== "browse"}>
      <View class="absolute left-0 bottom-0 w-[320] h-[22] flex-row items-center justify-center bg-[#263346e8]">
        <Text class="text-xs text-white font-bold">
          {props.mode === "move" ? "MOVE MODE  ·  choose a destination" : "DELETE MODE  ·  press to remove"}
        </Text>
      </View>
    </Show>
  );
}

/**
 * 320x240 PocketRock queue surface. The shell owns scrolling, global buttons,
 * service calls, and mode transitions; this component only renders the state.
 */
export default function QueuePage(props: QueuePageProps) {
  const mode = () => props.mode ?? "browse";
  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <QueueList {...props} mode={mode()} />
      <NavigationBar title={props.title ?? "Queue"} back={props.back ?? false} mode={mode()} />
      <ModeHint mode={mode()} />
    </View>
  );
}
