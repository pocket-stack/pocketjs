// Classic-chrome bevel demo: a Win98-style window mock built from the bevel
// ring props (spec.ts PROP.bevelOuter*..bevelWidth) + the existing 2-stop
// caption gradient. Exercises every bevel form the compiler accepts:
//   - double-ring raised (window frame, buttons — 98.css shadow-stack colors)
//   - double-ring sunken (text well: top/left dark, bottom/right light)
//   - single-ring thin (status-bar cells)
//   - active: inversion on the buttons (renders once hosts wire setActive)
// Golden captures: initial layout + d-pad focus moved onto CANCEL.

import { Text, View } from "@pocketjs/framework/components";

export default function Chrome() {
  return (
    <View class="w-full h-full flex-col justify-center items-center bg-[#008080]">
      <View
        debugName="Win98Window"
        class="w-[380] h-[220] flex-col bg-[#c0c0c0] p-[3] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
      >
        <View
          debugName="Titlebar"
          class="h-[18] flex-row items-center justify-between pl-[4] pr-[2] bg-gradient-to-r from-[#000080] to-[#1084d0]"
        >
          <Text class="text-xs text-white font-bold tracking-wide">POCKETJS — CHROME</Text>
          <View class="flex-row gap-[2]">
            <View class="w-[16] h-[14] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]" />
            <View class="w-[16] h-[14] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]" />
            <View class="w-[16] h-[14] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]" />
          </View>
        </View>

        <View debugName="Body" class="flex-1 flex-col gap-[10] p-[12]">
          <Text class="text-xs text-black">The quick brown fox jumps over the lazy dog.</Text>
          <View
            debugName="TextWell"
            class="h-[46] p-[6] bg-white bevel-[#808080,#ffffff,#0a0a0a,#dfdfdf]"
          >
            <Text class="text-xs text-black">C:\PSP\GAME\POCKETSHELL</Text>
          </View>
          <View class="flex-row gap-[8] justify-end">
            <View
              debugName="BtnOk"
              focusable
              class="h-[22] w-[74] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080] focus:bg-[#d2cec6] active:bevel-[#000000,#ffffff,#808080,#dfdfdf]"
            >
              <Text class="text-xs text-black">OK</Text>
            </View>
            <View
              debugName="BtnCancel"
              focusable
              class="h-[22] w-[74] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080] focus:bg-[#d2cec6] active:bevel-[#000000,#ffffff,#808080,#dfdfdf]"
            >
              <Text class="text-xs text-black">CANCEL</Text>
            </View>
          </View>
        </View>

        <View debugName="StatusBar" class="h-[18] flex-row gap-[2] pt-[2]">
          <View class="flex-1 pl-[4] flex-col justify-center bevel-[#808080,#ffffff]">
            <Text class="text-xs text-black">READY</Text>
          </View>
          <View class="w-[90] pl-[4] flex-col justify-center bevel-[#808080,#ffffff]">
            <Text class="text-xs text-black">480 x 272</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
