import { For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

export const POCKETROCK_HOME_DESTINATIONS = [
  "Now Playing",
  "Music",
  "Queue",
  "Files",
  "Apps",
  "Settings",
] as const;

export type PocketRockHomeDestination = (typeof POCKETROCK_HOME_DESTINATIONS)[number];

const POCKETROCK_HOME_LINKS: readonly Exclude<PocketRockHomeDestination, "Now Playing">[] = [
  "Music",
  "Queue",
  "Files",
  "Apps",
  "Settings",
];

export const POCKETROCK_SETTINGS_DESTINATIONS = [
  "Sound",
  "Playback",
  "Display",
  "Power",
  "Storage",
  "System Information",
] as const;

export type PocketRockSettingsDestination = (typeof POCKETROCK_SETTINGS_DESTINATIONS)[number];

export interface PocketRockNowPlaying {
  title: string;
  artist: string;
  album?: string;
  playing?: boolean;
}

export interface PocketRockHomePageProps {
  /** Index into POCKETROCK_HOME_DESTINATIONS. */
  selected: number;
  nowPlaying: PocketRockNowPlaying | null;
  /** Optional live values aligned to the five non-player destinations. */
  subtitles?: Partial<Record<Exclude<PocketRockHomeDestination, "Now Playing">, string>>;
}

export interface PocketRockSettingsPageProps {
  /** Index into POCKETROCK_SETTINGS_DESTINATIONS. */
  selected: number;
  /** Compact current values, such as "78%" or "Backlight on". */
  values?: Partial<Record<PocketRockSettingsDestination, string>>;
}

const HEADER = "absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]";
const LIST = "absolute left-0 top-[36] w-[320] h-[204] bg-[#f5f6f8] overflow-hidden";
const ROW = "relative w-[320] h-[30] flex-row items-center justify-between pl-[12] pr-[9]";
const ROW_SELECTED = "relative w-[320] h-[30] flex-row items-center justify-between pl-[12] pr-[9] bg-[#2378d4]";

function HubHeader(props: { title: string }) {
  return (
    <View class={HEADER}>
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function Divider() {
  return <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />;
}

/**
 * Root menu at the iPod's 320 x 240 logical resolution.  The selected row owns
 * its blue background so its text is always painted above the selection layer.
 */
export function PocketRockHomePage(props: PocketRockHomePageProps) {
  const nowTitle = () => props.nowPlaying?.title ?? "Nothing Playing";
  const nowArtist = () => props.nowPlaying?.artist ?? "Select a track";
  const nowAlbum = () => props.nowPlaying?.album ?? "";
  const nowSelected = () => props.selected === 0;

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class={LIST}>
        <View class={nowSelected()
          ? "relative w-[320] h-[54] flex-col justify-center pl-[12] pr-[9] bg-[#2378d4]"
          : "relative w-[320] h-[54] flex-col justify-center pl-[12] pr-[9] bg-[#e9edf2]"}>
          <View class="flex-row items-center">
            <Text class={nowSelected() ? "text-sm text-white font-bold" : "text-sm text-[#18202a] font-bold"}>
              Now Playing
            </Text>
            <Text class={nowSelected() ? "ml-[6] text-xs text-[#d9ecff]" : "ml-[6] text-xs text-[#687484]"}>
              {props.nowPlaying?.playing ? ">" : "||"}
            </Text>
          </View>
          <Text class={nowSelected() ? "text-xs text-[#d9ecff]" : "text-xs text-[#687484]"}>
            {nowTitle()} — {nowArtist()}{nowAlbum() ? ` · ${nowAlbum()}` : ""}
          </Text>
          <Divider />
        </View>

        <For each={POCKETROCK_HOME_LINKS}>{(destination, index) => {
          const absoluteIndex = () => index() + 1;
          const selected = () => props.selected === absoluteIndex();
          return (
            <View class={selected() ? ROW_SELECTED : ROW}>
              <Text class={selected() ? "text-sm text-white font-bold" : "text-sm text-[#18202a] font-bold"}>
                {destination}
              </Text>
              <Text class={selected() ? "text-xs text-[#d9ecff]" : "text-xs text-[#687484]"}>
                {props.subtitles?.[destination] ?? ">"}
              </Text>
              <Divider />
            </View>
          );
        }}</For>
      </View>
      <HubHeader title="PocketRock" />
    </View>
  );
}

/** A six-row settings hub with the same contact-list rhythm as the root menu. */
export function PocketRockSettingsPage(props: PocketRockSettingsPageProps) {
  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View class={LIST}>
        <For each={POCKETROCK_SETTINGS_DESTINATIONS}>{(destination, index) => {
          const selected = () => props.selected === index();
          return (
            <View class={selected()
              ? "relative w-[320] h-[34] flex-row items-center justify-between pl-[12] pr-[9] bg-[#2378d4]"
              : "relative w-[320] h-[34] flex-row items-center justify-between pl-[12] pr-[9]"}>
              <Text class={selected() ? "text-sm text-white font-bold" : "text-sm text-[#18202a] font-bold"}>
                {destination}
              </Text>
              <Text class={selected() ? "text-xs text-[#d9ecff]" : "text-xs text-[#687484]"}>
                {props.values?.[destination] ?? ">"}
              </Text>
              <Divider />
            </View>
          );
        }}</For>
      </View>
      <HubHeader title="Settings" />
    </View>
  );
}
