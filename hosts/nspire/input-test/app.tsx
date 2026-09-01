import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import {
  analogRaw,
  onFrame,
} from "@pocketjs/framework/lifecycle";

interface ProbeState {
  buttons: number;
  keys: string;
  rawX: number;
  rawY: number;
  frame: number;
}

function hex16(value: number): string {
  return ("0000" + value.toString(16).toUpperCase()).slice(-4);
}

export default function InputTest() {
  const [state, setState] = createSignal<ProbeState>({
    buttons: 0,
    keys: "NONE",
    rawX: 128,
    rawY: 128,
    frame: 0,
  });
  let frame = 0;

  onFrame((buttons) => {
    frame += 1;
    if ((frame & 1) !== 0) return;
    const analog = analogRaw();
    const diagnostic = (
      globalThis as typeof globalThis & { __pocketInputDiagnostic?: string }
    ).__pocketInputDiagnostic;
    setState({
      buttons,
      keys: diagnostic && diagnostic.length > 0 ? diagnostic : "NONE",
      rawX: (analog >> 8) & 0xff,
      rawY: analog & 0xff,
      frame,
    });
  });

  const dotX = () => Math.round((state().rawX / 255) * 116);
  const dotY = () => Math.round((state().rawY / 255) * 90);

  return (
    <View class="w-[320] h-[240] bg-slate-950 p-2 flex-col gap-2 overflow-hidden">
      <View class="flex-row items-center justify-between">
        <Text class="text-sm font-bold text-white">CX II INPUT TEST</Text>
        <Text class="text-xs text-slate-400">FRAME {state().frame}</Text>
      </View>

      <View class="flex-row gap-2">
        <View class="w-[164] flex-col gap-1">
          <Text class="text-xs text-slate-400">CURRENT KEYS</Text>
          <View class="w-[164] h-[128] p-2 rounded bg-slate-800 border-slate-600">
            <Text class="text-lg font-bold text-emerald-400">{state().keys}</Text>
          </View>
          <Text class="text-xs text-slate-400">POCKET MASK</Text>
          <Text class="text-sm font-bold text-white">0x{hex16(state().buttons)}</Text>
          <Text class="text-xs text-slate-500">ALL CX II MATRIX KEYS SCANNED</Text>
        </View>

        <View class="w-[132] flex-col gap-1">
          <Text class="text-xs text-slate-400">ANALOG RAW</Text>
          <Text class="text-sm font-bold text-white">
            X {state().rawX}  Y {state().rawY}
          </Text>
          <View class="relative w-[124] h-[98] rounded bg-slate-900 border-slate-600 overflow-hidden">
            <View class="absolute w-[124] h-[1] bg-slate-700" style={{ translateY: 48 }} />
            <View class="absolute w-[1] h-[98] bg-slate-700" style={{ translateX: 61 }} />
            <View
              class="absolute w-2 h-2 rounded-full bg-amber-400"
              style={{ translateX: dotX(), translateY: dotY() }}
            />
          </View>
          <Text class="text-xs text-slate-400">LIFT = 128 / 128</Text>
          <Text class="text-xs text-slate-400">EXIT = CTRL + ESC</Text>
        </View>
      </View>
    </View>
  );
}
