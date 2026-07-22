// Virtual cursor demo (input.cursor; spec ops 27..29): a teal desktop with a
// centered column of pressable rows. The framework cursor hovers them (hover
// IS the `focus:` variant), holds `active:` while the press button is down
// over one, and fires onPress on release — the status line records the click.
//
// The golden tape steers with the d-pad (enableCursor dpadSpeed: 60 = exactly
// 1 px/frame — analog would need an analog lane in the native capture format;
// the nub path is covered by tests/cursor.test.ts).

import { Text, View } from "@pocketjs/framework/components";
import { createSignal } from "solid-js";

const ROWS = ["REPLAY TAPE", "OPEN MEMORY STICK", "LAUNCH SHELL"] as const;

export default function CursorDemo() {
  const [status, setStatus] = createSignal("hover a row, press CIRCLE");
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-[10] bg-[#008080]">
      <View debugName="Panel" class="w-[240] flex-col gap-[8]">
        {ROWS.map((label) => (
          <View
            debugName={label}
            focusable
            onPress={() => setStatus(label)}
            class="h-[24] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080] focus:bg-[#d2cec6] active:bevel-[#000000,#ffffff,#808080,#dfdfdf]"
          >
            <Text class="text-xs text-black">{label}</Text>
          </View>
        ))}
      </View>
      <View debugName="Status" class="h-[18] pl-[8] pr-[8] flex-col justify-center bg-[#c0c0c0] bevel-[#808080,#ffffff]">
        <Text class="text-xs text-black">{status()}</Text>
      </View>
    </View>
  );
}
