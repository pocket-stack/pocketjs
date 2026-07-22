// iPod nano (2nd generation) UI mockup at the device's native 176x132
// logical resolution. The click wheel is translated by Pocket Stage into the
// portable BTN contract: UP/DOWN rotate, CIRCLE selects, TRIANGLE goes back,
// LEFT/RIGHT skip, START toggles playback.

import { For, Show, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import {
  MAIN_MENU,
  MUSIC_MENU,
  createNanoPlayerState,
  currentTrack,
  formatNanoTime,
  reduceNanoPlayer,
  type NanoMenu,
  type NanoPlayerAction,
  type NanoPlayerState,
} from "./state.ts";
import { connectNanoAudioService } from "./svc.ts";

const HEADER = "h-[18] flex-row items-center bg-gradient-to-b from-[#f7f7f7] to-[#b8b8b8]";
const ROW = "h-[19] flex-row items-center justify-between pl-[7] pr-[6] bg-[#f4f4f4]";
const ROW_SELECTED =
  "h-[19] flex-row items-center justify-between pl-[7] pr-[6] bg-gradient-to-b from-[#68b5ed] to-[#1475c4]";
const ROW_TEXT = "text-xs text-[#151515]";
const ROW_TEXT_SELECTED = "text-xs text-white font-bold";

function Header(props: { state: NanoPlayerState; title: string }) {
  return (
    <View debugName="NanoHeader" class={HEADER}>
      <View class="w-[27] pl-[5] flex-row items-center">
        <Text class="text-xs text-[#202020] font-bold">{props.state.playing ? ">" : "II"}</Text>
      </View>
      <View class="flex-1 items-center justify-center overflow-hidden">
        <Text class="text-xs text-[#202020] font-bold">{props.title}</Text>
      </View>
      <View class="w-[27] pr-[4] flex-row items-center justify-end">
        <View class="w-[17] h-[8] p-[1] border-[#303030] bg-[#f2f2f2]">
          <View class="w-[11] h-[4] bg-[#58a84f]" />
        </View>
        <View class="w-[2] h-[4] bg-[#303030]" />
      </View>
    </View>
  );
}

function MenuRows(props: {
  state: NanoPlayerState;
  menu: NanoMenu;
  labels: readonly string[];
}) {
  return (
    <View debugName="NanoMenu" class="flex-1 flex-col bg-[#f4f4f4] overflow-hidden">
      <For each={props.labels}>
        {(label, index) => {
          const selected = () => props.state.selected[props.menu] === index();
          return (
            <View class={selected() ? ROW_SELECTED : ROW} debugName={label}>
              <View class="flex-1 overflow-hidden">
                <Text class={selected() ? ROW_TEXT_SELECTED : ROW_TEXT}>{label}</Text>
              </View>
              <Text class={selected() ? ROW_TEXT_SELECTED : ROW_TEXT}>{">"}</Text>
            </View>
          );
        }}
      </For>
    </View>
  );
}

function MainMenu(props: { state: NanoPlayerState }) {
  return (
    <View class="w-full h-full flex-col bg-[#f4f4f4]">
      <Header state={props.state} title="iPod" />
      <MenuRows state={props.state} menu="main" labels={MAIN_MENU} />
    </View>
  );
}

function MusicMenu(props: { state: NanoPlayerState }) {
  return (
    <View class="w-full h-full flex-col bg-[#f4f4f4]">
      <Header state={props.state} title="Music" />
      <MenuRows state={props.state} menu="music" labels={MUSIC_MENU} />
    </View>
  );
}

function SongsMenu(props: { state: NanoPlayerState }) {
  return (
    <View class="w-full h-full flex-col bg-[#f4f4f4]">
      <Header state={props.state} title="Songs" />
      <MenuRows state={props.state} menu="songs" labels={props.state.tracks.map((track) => track.title)} />
    </View>
  );
}

function NowPlaying(props: { state: NanoPlayerState }) {
  const track = () => currentTrack(props.state);
  const progress = () =>
    props.state.durationMs > 0
      ? Math.max(0, Math.min(1, props.state.positionMs / props.state.durationMs))
      : 0;
  return (
    <View class="w-full h-full flex-col bg-[#f4f4f4]">
      <Header state={props.state} title="Now Playing" />
      <View class="flex-1 flex-col px-[8] pt-[4] pb-[3] bg-[#f4f4f4] overflow-hidden">
        <View class="h-[14] flex-row justify-end">
          <Text class="text-xs text-[#555555]">{props.state.trackIndex + 1} of {props.state.tracks.length}</Text>
        </View>
        <View class="h-[18] overflow-hidden">
          <Text class="text-xs text-[#111111] font-bold">{track().title}</Text>
        </View>
        <View class="h-[16] overflow-hidden">
          <Text class="text-xs text-[#333333]">{track().artist}</Text>
        </View>
        <View class="h-[16] overflow-hidden">
          <Text class="text-xs text-[#666666]">{track().album ?? "Local Music"}</Text>
        </View>
        <View class="flex-1 flex-col justify-end">
          <View class="h-[8] p-[1] bg-[#d1d1d1] border-[#929292] overflow-hidden">
            <View
              class="h-[4] w-[158] bg-gradient-to-r from-[#73b9ec] to-[#1a76bf]"
              style={{
                scaleX: progress(),
                translateX: -(158 * (1 - progress())) / 2,
              }}
            />
          </View>
          <View class="h-[16] flex-row items-center justify-between">
            <Text class="text-xs text-[#444444]">{formatNanoTime(props.state.positionMs)}</Text>
            <Text class="text-xs text-[#444444]">-{formatNanoTime(props.state.durationMs - props.state.positionMs)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function Placeholder(props: { state: NanoPlayerState }) {
  return (
    <View class="w-full h-full flex-col bg-[#f4f4f4]">
      <Header state={props.state} title="iPod" />
      <View class="flex-1 flex-col items-center justify-center px-[8]">
        <Text class="text-xs text-[#222222] font-bold">{props.state.placeholderTitle}</Text>
        <Text class="text-xs text-[#777777]">Press MENU to go back</Text>
      </View>
    </View>
  );
}

function NanoScreen(props: { state: NanoPlayerState }) {
  // Keep the branch itself reactive. A plain top-level ternary in a Solid
  // component is evaluated only once, while Show tracks the screen signal.
  return (
    <>
      <Show when={props.state.screen === "main"}>
        <MainMenu state={props.state} />
      </Show>
      <Show when={props.state.screen === "music"}>
        <MusicMenu state={props.state} />
      </Show>
      <Show when={props.state.screen === "songs"}>
        <SongsMenu state={props.state} />
      </Show>
      <Show when={props.state.screen === "now-playing"}>
        <NowPlaying state={props.state} />
      </Show>
      <Show when={props.state.screen === "placeholder"}>
        <Placeholder state={props.state} />
      </Show>
    </>
  );
}

export default function IpodNano() {
  const audio = connectNanoAudioService();
  const [state, setState] = createSignal(createNanoPlayerState(audio !== null));

  const dispatch = (action: NanoPlayerAction): void => {
    const transition = reduceNanoPlayer(state(), action);
    if (transition.state !== state()) setState(transition.state);
    if (audio) {
      for (const command of transition.commands) audio.send(command);
    }
  };

  onButtonPress(BTN.DOWN, () => dispatch({ type: "wheel", direction: 1 }));
  onButtonPress(BTN.UP, () => dispatch({ type: "wheel", direction: -1 }));
  onButtonPress(BTN.CIRCLE, () => dispatch({ type: "select" }));
  onButtonPress(BTN.TRIANGLE, () => dispatch({ type: "back" }));
  onButtonPress(BTN.LEFT, () => dispatch({ type: "previous" }));
  onButtonPress(BTN.RIGHT, () => dispatch({ type: "next" }));
  onButtonPress(BTN.START, () => dispatch({ type: "toggle-play" }));

  // The service is polled once per guest turn. Mock mode advances at 4 Hz,
  // not every frame, so its changing progress does not defeat demand render.
  let mockFrames = 0;
  onFrame(() => {
    if (audio) {
      for (const event of audio.poll()) dispatch({ type: "host", event });
      return;
    }
    if (++mockFrames >= 15) {
      mockFrames = 0;
      dispatch({ type: "mock-tick", deltaMs: 250 });
    }
  });

  return (
    <View debugName="IPodNanoScreen" class="w-full h-full flex-col bg-[#f4f4f4] overflow-hidden">
      <NanoScreen state={state()} />
    </View>
  );
}
