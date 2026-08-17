import { Show, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import {
  connectPocketMusic,
  type PocketMusicOperation,
  type PocketMusicState,
} from "./service.ts";

const OFFLINE: PocketMusicState = {
  daemonConnected: false,
  deviceConnected: false,
  playerRunning: false,
  playing: false,
  positionMs: 0,
  volume: 0,
  sequence: 0,
};

function timeLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusLabel(state: PocketMusicState): string {
  if (!state.daemonConnected) return "START DAEMON";
  if (!state.deviceConnected) return "CONNECT iPOD";
  if (!state.playerRunning) return "OPEN MUSIC";
  return state.playing ? "PLAYING" : "PAUSED";
}

export default function PocketMusic() {
  const connection = connectPocketMusic();
  const [state, setState] = createSignal(OFFLINE);

  const send = (op: PocketMusicOperation): void => connection?.send(op);
  onButtonPress(BTN.START, () => send("toggle"));
  onButtonPress(BTN.RIGHT, () => send("next"));
  onButtonPress(BTN.LEFT, () => send("previous"));
  onButtonPress(BTN.TRIANGLE, () => send("stop"));
  onButtonPress(BTN.CIRCLE, () => send("mute"));
  onButtonPress(BTN.DOWN, () => send("volume-up"));
  onButtonPress(BTN.UP, () => send("volume-down"));

  onFrame(() => {
    if (!connection) return;
    for (const next of connection.poll()) setState(next);
  });

  const duration = () => state().track?.durationMs ?? 0;
  const progress = () =>
    duration() > 0 ? Math.min(1, state().positionMs / duration()) : 0;

  return (
    <View class="w-full h-full flex-col bg-[#e9e9e9] overflow-hidden">
      <View class="h-[18] flex-row items-center px-[5] bg-gradient-to-b from-[#fafafa] to-[#bdbdbd]">
        <Text class="w-[24] text-xs text-[#1c1c1c] font-bold">{state().playing ? ">" : "II"}</Text>
        <View class="flex-1 items-center">
          <Text class="text-xs text-[#161616] font-bold">Pocket Music</Text>
        </View>
        <Text class="w-[24] text-xs text-[#1c1c1c]">{state().deviceConnected ? "iP" : "--"}</Text>
      </View>

      <Show
        when={state().track}
        fallback={
          <View class="flex-1 flex-col items-center justify-center px-[8]">
            <Text class="text-xs text-[#1c1c1c] font-bold">{statusLabel(state())}</Text>
            <Text class="text-xs text-[#666666]">Rockbox USB HID</Text>
          </View>
        }
      >
        {(track) => (
          <View class="flex-1 flex-col px-[8] pt-[5] pb-[3]">
            <View class="h-[19] overflow-hidden">
              <Text class="text-xs text-[#111111] font-bold">{track().title}</Text>
            </View>
            <View class="h-[15] overflow-hidden">
              <Text class="text-xs text-[#343434]">{track().artist}</Text>
            </View>
            <View class="h-[15] overflow-hidden">
              <Text class="text-xs text-[#666666]">{track().album || "Music"}</Text>
            </View>
            <View class="h-[8] mt-[3] p-[1] border-[#858585] bg-[#d0d0d0] overflow-hidden">
              <View
                class="w-[156] h-[4] bg-gradient-to-r from-[#65b5ef] to-[#1473bd]"
                style={{
                  scaleX: progress(),
                  translateX: -(156 * (1 - progress())) / 2,
                }}
              />
            </View>
            <View class="h-[15] flex-row justify-between">
              <Text class="text-xs text-[#444444]">{timeLabel(state().positionMs)}</Text>
              <Text class="text-xs text-[#444444]">-{timeLabel(duration() - state().positionMs)}</Text>
            </View>
          </View>
        )}
      </Show>

      <View class="h-[20] flex-row items-center px-[6] bg-gradient-to-b from-[#d5d5d5] to-[#a9a9a9]">
        <Text class="w-[32] text-xs text-[#222222] font-bold">VOL</Text>
        <View class="w-[102] h-[7] p-[1] border-[#707070] bg-[#eeeeee] overflow-hidden">
          <View
            class="w-[98] h-[3] bg-[#2e83c7]"
            style={{
              scaleX: state().volume / 100,
              translateX: -(98 * (1 - state().volume / 100)) / 2,
            }}
          />
        </View>
        <Text class="flex-1 text-xs text-[#222222] font-bold">{Math.round(state().volume)}</Text>
      </View>
    </View>
  );
}
