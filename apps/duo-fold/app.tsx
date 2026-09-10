import { createSignal, Show } from "solid-js";
import { Focusable, Image, Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { reportAppAction } from "@pocketjs/framework/host";
import { connectFold, type FoldCommand } from "./service.ts";

export default function Fold() {
  const service = connectFold();
  const [visible, setVisible] = createSignal(true);
  const [degrees, setDegrees] = createSignal(0);
  const [mode, setMode] = createSignal("Starting motion...");
  const [source, setSource] = createSignal(false);
  let frames = 0, actions = 0;
  onFrame(() => {
    frames++;
    const state = service?.poll();
    if (state) {
      setDegrees(Math.round(state.degrees));
      setSource(state.source);
      setMode(state.manual ? "Manual preview" : state.available && state.samples > 0 ? "Plane locked" : "Waiting for motion");
    }
    if (frames === 480 && source()) setVisible(false);
  });
  function send(command: FoldCommand) {
    service?.send(command);
    reportAppAction("fold_control", ++actions);
  }
  return (
    <View class="relative w-[320] h-[480] overflow-hidden">
      <Focusable debugName="FoldControlsToggle" onPress={() => { setVisible(!visible()); reportAppAction("fold_control", ++actions); }}
        class="absolute right-[8] top-[24] w-[44] h-[44] items-center justify-center">
        <Image class="w-[32] h-[32]" src="pocketjs-icon.png" />
      </Focusable>
      <Show when={!source()}>
        <View class="absolute left-[22] top-[164] w-[276] flex-col gap-3">
          <Text class="text-2xl font-bold text-white">Pocket Fold</Text>
          <Text class="text-sm text-slate-300">Capture a home screen to begin.</Text>
          <Text class="text-sm text-slate-300">{service ? "Face the screen, then Set zero." : "Requires the iPod touch 4 host."}</Text>
        </View>
      </Show>
      <Show when={visible()}>
        <View class="absolute left-[12] bottom-[14] w-[296] h-[156] flex-col p-[12] gap-[10] rounded-[16] bg-slate-900 border-slate-600 border">
          <View class="flex-row justify-between items-center">
            <Text class="text-sm font-bold text-white">{mode()}</Text>
            <Text class="text-sm text-cyan-300">{degrees()} deg</Text>
          </View>
          <Text class="text-xs text-slate-300">Face screen, then Set zero</Text>
          <View class="flex-row gap-[8]">
            <Focusable debugName="FoldCalibrate" onPress={() => send({ op: "calibrate" })}
              class="w-[128] h-[34] rounded-lg bg-sky-600 items-center justify-center">
              <Text class="text-sm font-bold text-white">Set zero</Text>
            </Focusable>
            <Focusable debugName="FoldMotion" onPress={() => send({ op: "motion" })}
              class="w-[128] h-[34] rounded-lg bg-slate-700 items-center justify-center">
              <Text class="text-sm text-white">Gyroscope</Text>
            </Focusable>
          </View>
          <View class="flex-row gap-[8]">
            <Focusable debugName="FoldLeft" onPress={() => send({ op: "manual", degrees: Math.max(-80, degrees() - 15) })}
              class="w-[80] h-[28] rounded-lg bg-slate-800 items-center justify-center">
              <Text class="text-sm text-slate-200">-15 deg</Text>
            </Focusable>
            <Focusable debugName="FoldFlat" onPress={() => send({ op: "manual", degrees: 0 })}
              class="w-[96] h-[28] rounded-lg bg-slate-800 items-center justify-center">
              <Text class="text-sm text-slate-200">Flat</Text>
            </Focusable>
            <Focusable debugName="FoldRight" onPress={() => send({ op: "manual", degrees: Math.min(80, degrees() + 15) })}
              class="w-[80] h-[28] rounded-lg bg-slate-800 items-center justify-center">
              <Text class="text-sm text-slate-200">+15 deg</Text>
            </Focusable>
          </View>
        </View>
      </Show>
    </View>
  );
}
