import { Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import type {
  PocketRockEmptyStateProps,
  PocketRockInfoCardProps,
  PocketRockListRowProps,
  PocketRockPageProps,
  PocketRockSliderProps,
  PocketRockStatusBadgeProps,
  PocketRockTone,
} from "./types.ts";

export const POCKETROCK_SCREEN_WIDTH = 320;
export const POCKETROCK_SCREEN_HEIGHT = 240;
export const POCKETROCK_TOP_BAR_HEIGHT = 36;
export const POCKETROCK_CONTENT_HEIGHT = 204;
export const POCKETROCK_LIST_ROW_HEIGHT = 30;

const SLIDER_TRACK_WIDTH = 172;

const TONE_SURFACE: Record<PocketRockTone, string> = {
  neutral: "bg-[#ffffff] border-[#d5d9df]",
  accent: "bg-[#e8f1fb] border-[#8bb7e8]",
  success: "bg-[#eaf6ee] border-[#83ba91]",
  warning: "bg-[#fff6df] border-[#d8ae57]",
  danger: "bg-[#fff0f0] border-[#dc8d8d]",
};

const TONE_TEXT: Record<PocketRockTone, string> = {
  neutral: "text-[#4d5b6c]",
  accent: "text-[#1d65b2]",
  success: "text-[#32773e]",
  warning: "text-[#87621b]",
  danger: "text-[#a13c3c]",
};

/** The shared 36px chrome used by every shell page. */
export function PocketRockTopBar(props: {
  title: string;
  back?: boolean;
  backLabel?: string;
}) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">{props.backLabel ?? "MENU: Back"}</Text>
        </View>
      </Show>
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

/**
 * A page-sized shell. Keep the body as a single clipping layer so pages can
 * virtualize their own lists without an extra wrapper per list item.
 */
export function PocketRockPage(props: PocketRockPageProps) {
  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class="absolute left-0 top-[36] w-[320] h-[204] overflow-hidden">
        {props.children}
      </View>
      <PocketRockTopBar
        title={props.title}
        back={props.back}
        backLabel={props.backLabel}
      />
      <Show when={props.notice}>
        <View class="absolute left-[8] bottom-[5] right-[8]">
          {props.notice}
        </View>
      </Show>
    </View>
  );
}

/**
 * The layers deliberately stay in this draw order: separator, blue selection,
 * then content. The foreground therefore remains readable when selected.
 */
export function PocketRockListRow(props: PocketRockListRowProps) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View
      class="relative w-[320] h-[30]"
      onPress={props.onPress}
      focusable={props.focusable}
      debugName={props.debugName}
      ref={props.ref}
      nodeRef={props.nodeRef}
      style={props.style}
    >
      <Show when={props.divider ?? true}>
        <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
      </Show>
      <Show when={props.selected}>
        <View class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]" />
      </Show>
      <View class="absolute left-0 top-0 w-[320] h-[30] flex-col justify-center pl-[12] pr-[9]">
        <Text class="text-sm text-[#18202a] font-bold">{props.title}</Text>
        <Show when={props.subtitle}>
          <Text class="text-xs text-[#687484]">{props.subtitle}</Text>
        </Show>
        <Show when={props.detail}>
          <Text class="absolute right-[9] top-[9] text-xs text-[#687484]">{props.detail}</Text>
        </Show>
      </View>
    </View>
  );
}

/** Compact card for USB state, playback metadata, and system summaries. */
export function PocketRockInfoCard(props: PocketRockInfoCardProps) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View class={tone() === "accent" ? "w-[296] mx-[12] px-[10] py-[8] rounded-[5] border bg-[#e8f1fb] border-[#8bb7e8]" : tone() === "success" ? "w-[296] mx-[12] px-[10] py-[8] rounded-[5] border bg-[#eaf6ee] border-[#83ba91]" : tone() === "warning" ? "w-[296] mx-[12] px-[10] py-[8] rounded-[5] border bg-[#fff6df] border-[#d8ae57]" : tone() === "danger" ? "w-[296] mx-[12] px-[10] py-[8] rounded-[5] border bg-[#fff0f0] border-[#dc8d8d]" : "w-[296] mx-[12] px-[10] py-[8] rounded-[5] border bg-[#ffffff] border-[#d5d9df]"}>
      <Text class="text-sm text-[#18202a] font-bold">{props.title}</Text>
      <Show when={props.detail}>
        <Text class={tone() === "accent" ? "mt-[2] text-xs text-[#1d65b2]" : tone() === "success" ? "mt-[2] text-xs text-[#32773e]" : tone() === "warning" ? "mt-[2] text-xs text-[#87621b]" : tone() === "danger" ? "mt-[2] text-xs text-[#a13c3c]" : "mt-[2] text-xs text-[#4d5b6c]"}>{props.detail}</Text>
      </Show>
      <Show when={props.children}>
        <View class="mt-[6]">{props.children}</View>
      </Show>
    </View>
  );
}

/** A non-interactive visual control; pages own click-wheel input and value changes. */
export function PocketRockSlider(props: PocketRockSliderProps) {
  const normalized = () => Math.max(0, Math.min(100, props.value));
  const fillWidth = () => Math.round(SLIDER_TRACK_WIDTH * normalized() / 100);
  const knobX = () => Math.max(0, fillWidth() - 4);
  return (
    <View class="relative w-[296] h-[30] mx-[12] flex-row items-center">
      <Text class={props.selected ? "w-[94] text-sm font-bold text-[#18202a]" : "w-[94] text-sm font-bold text-[#4d5b6c]"}>
        {props.label}
      </Text>
      <View class="relative w-[172] h-[6] rounded-[3] bg-[#cbd2dc]">
        <View class="absolute left-0 top-0 h-[6] rounded-[3] bg-[#2378d4]" style={{ width: fillWidth() }} />
        <View
          class={props.selected ? "absolute top-[-3] w-[12] h-[12] rounded-[6] border bg-white border-[#155a9e]" : "absolute top-[-3] w-[12] h-[12] rounded-[6] border bg-[#f5f6f8] border-[#758397]"}
          style={{ translateX: knobX() }}
        />
      </View>
      <Show when={props.valueLabel}>
        <Text class="absolute right-0 text-xs text-[#687484]">{props.valueLabel}</Text>
      </Show>
    </View>
  );
}

/** Short inline state marker; do not use it as a full-width alert. */
export function PocketRockStatusBadge(props: PocketRockStatusBadgeProps) {
  const tone = () => props.tone ?? "neutral";
  return (
    <View class={tone() === "accent" ? "h-[18] px-[6] flex-row items-center rounded-[9] border bg-[#e8f1fb] border-[#8bb7e8]" : tone() === "success" ? "h-[18] px-[6] flex-row items-center rounded-[9] border bg-[#eaf6ee] border-[#83ba91]" : tone() === "warning" ? "h-[18] px-[6] flex-row items-center rounded-[9] border bg-[#fff6df] border-[#d8ae57]" : tone() === "danger" ? "h-[18] px-[6] flex-row items-center rounded-[9] border bg-[#fff0f0] border-[#dc8d8d]" : "h-[18] px-[6] flex-row items-center rounded-[9] border bg-[#ffffff] border-[#d5d9df]"}>
      <Text class={tone() === "accent" ? "text-xs font-bold text-[#1d65b2]" : tone() === "success" ? "text-xs font-bold text-[#32773e]" : tone() === "warning" ? "text-xs font-bold text-[#87621b]" : tone() === "danger" ? "text-xs font-bold text-[#a13c3c]" : "text-xs font-bold text-[#4d5b6c]"}>{props.label}</Text>
    </View>
  );
}

/** Directional empty state for an unavailable queue, storage area, or library. */
export function PocketRockEmptyState(props: PocketRockEmptyStateProps) {
  return (
    <View class="w-[320] h-[204] flex-col items-center justify-center px-[24] bg-[#f5f6f8]">
      <View class="w-[32] h-[3] rounded-[2] bg-[#2378d4]" />
      <Text class="mt-[10] text-base text-[#18202a] font-bold">{props.title}</Text>
      <Show when={props.detail}>
        <Text class="mt-[3] text-xs text-[#687484]">{props.detail}</Text>
      </Show>
      <Show when={props.action}>
        <View class="mt-[10]">{props.action}</View>
      </Show>
    </View>
  );
}
