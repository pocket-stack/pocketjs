// apps/3ds-demo/app.tsx — dual-output acceptance demo for the 3ds-dev host.
//
// The primary display keeps only directly observable host facts: its fixed
// 400x240 bounds, one rendered image, and the live circle-pad sample. The
// auxiliary display is a 10,000-row VirtualList. Its viewport mounts only the
// visible window plus overscan, while touch drag/fling changes the canvas
// transform without laying out all rows.

import { createSignal } from "solid-js";
import { AuxiliarySurface, Image, Text, View } from "@pocketjs/framework/components";
import { analogRaw, analogX, analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";

const PAD_TRAVEL = 26;
const LIST_ROWS = 10_000;
const ROW_HEIGHT = 48;
const GROUPS = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"] as const;

function BottomRow(index: number) {
  const ordinal = String(index + 1).padStart(5, "0");
  const value = String((index * 37 + 11) % 1000).padStart(3, "0");
  return (
    <View
      debugName={`VirtualRow${ordinal}`}
      class={
        index % 2 === 0
          ? "flex-row items-center w-full h-full px-3 gap-3 bg-slate-950 border-b border-slate-800"
          : "flex-row items-center w-full h-full px-3 gap-3 bg-slate-900 border-b border-slate-800"
      }
    >
      <View class="items-center justify-center w-8 h-8 rounded-lg bg-cyan-950 border border-cyan-800">
        <Text class="text-xs text-cyan-300 font-bold">{String((index % 99) + 1).padStart(2, "0")}</Text>
      </View>
      <View class="flex-col grow gap-1">
        <Text class="text-sm text-slate-100 font-bold">ROW {ordinal}</Text>
        <Text class="text-xs text-slate-500 tracking-wide">
          {GROUPS[index % GROUPS.length]} · VALUE {value}
        </Text>
      </View>
      <Text class="text-xs text-slate-600">{ordinal}</Text>
    </View>
  );
}

export default function ThreeDsDemo() {
  const [padX, setPadX] = createSignal(0);
  const [padY, setPadY] = createSignal(0);
  const [padRaw, setPadRaw] = createSignal(analogRaw());

  onFrame(() => {
    setPadX(analogX());
    setPadY(analogY());
    setPadRaw(analogRaw());
  });

  const padLabel = () => `0x${padRaw().toString(16).padStart(4, "0")}`;

  return (
    <>
      <View debugName="ThreeDsScreen" class="relative flex-col w-full h-full bg-slate-950 overflow-hidden">
        <View class="absolute left-[196] top-0 w-[8] h-[3] bg-slate-500" />
        <View class="absolute left-[196] bottom-0 w-[8] h-[3] bg-slate-500" />
        <View class="absolute left-0 top-[116] w-[3] h-[8] bg-slate-500" />
        <View class="absolute right-0 top-[116] w-[3] h-[8] bg-slate-500" />

        <View class="absolute left-0 top-0 w-[18] h-[3] bg-red-500" />
        <View class="absolute left-0 top-0 w-[3] h-[18] bg-red-500" />
        <View class="absolute right-0 top-0 w-[18] h-[3] bg-emerald-500" />
        <View class="absolute right-0 top-0 w-[3] h-[18] bg-emerald-500" />
        <View class="absolute left-0 bottom-0 w-[18] h-[3] bg-blue-500" />
        <View class="absolute left-0 bottom-0 w-[3] h-[18] bg-blue-500" />
        <View class="absolute right-0 bottom-0 w-[18] h-[3] bg-amber-500" />
        <View class="absolute right-0 bottom-0 w-[3] h-[18] bg-amber-500" />

        <View debugName="Content" class="flex-col w-full h-full p-3 gap-3">
          <View debugName="Header" class="flex-row items-center justify-between">
            <View class="flex-row items-center gap-2">
              <Image class="w-8 h-8 rounded-lg" src="logo.png" />
              <View class="flex-col">
                <Text class="text-base text-slate-50 font-bold tracking-wide">PocketJS on 3DS</Text>
                <Text class="text-xs text-slate-400 tracking-wide">TOP SCREEN · PICA200</Text>
              </View>
            </View>
            <View class="px-2 py-1 rounded-md border border-slate-600 bg-slate-900">
              <Text class="text-sm text-emerald-400 font-bold">400 × 240</Text>
            </View>
          </View>

          <View debugName="Middle" class="flex-row items-center gap-3">
            <Image debugName="OrientKey" class="w-16 h-16" src="orient-key.svg" />

            <View class="flex-col grow gap-1">
              <Text class="text-xs text-slate-500 tracking-wide">AUXILIARY PERFORMANCE TEST</Text>
              <Text class="text-2xl text-slate-50 font-bold">10,000 ROWS</Text>
              <Text class="text-xs text-cyan-300 tracking-wide">VIRTUAL WINDOW · 48 PX ROWS</Text>
            </View>

            <View debugName="Pad" class="flex-col items-center gap-1">
              <View class="relative w-[72] h-[72] rounded-lg border border-slate-700 bg-slate-900">
                <View class="absolute left-[33] top-[33] w-[6] h-[6] rounded-full bg-slate-700" />
                <View
                  class="absolute left-[31] top-[31] w-[10] h-[10] rounded-full bg-cyan-400"
                  style={{
                    translateX: Math.round(padX() * PAD_TRAVEL),
                    translateY: Math.round(padY() * PAD_TRAVEL),
                  }}
                />
              </View>
              <Text class="text-xs text-slate-400 tracking-wide">PAD {padLabel()}</Text>
            </View>
          </View>

          <View class="flex-col p-3 gap-1 rounded-lg border border-slate-700 bg-slate-900">
            <Text class="text-sm text-slate-100 font-bold">BOTTOM SCREEN: VIRTUAL LIST</Text>
            <Text class="text-xs text-slate-400 tracking-wide">
              DRAG · RELEASE TO FLING · TOUCH AGAIN TO STOP
            </Text>
          </View>
        </View>
      </View>

      <AuxiliarySurface>
        <VirtualList
          surface="auxiliary"
          count={LIST_ROWS}
          rowHeight={ROW_HEIGHT}
          height={240}
          overscan={ROW_HEIGHT}
          focusRows={false}
          renderRow={BottomRow}
        />
      </AuxiliarySurface>
    </>
  );
}
