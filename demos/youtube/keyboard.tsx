// demos/youtube/keyboard.tsx — the search OSK.
//
// The Pocket Talk keyboard (demos/im/keyboard.tsx) restyled for the tube:
// same 40-key FocusGrid + face-button chords (the pattern every PSP OSK
// grew), START wired to "run the search" by the parent. Both case rows stay
// string literals so the font atlas bakes every glyph a user can type.

import { createSignal } from "solid-js";
import { FocusGrid, FocusScope, Focusable, Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { virtualFrame } from "@pocketjs/framework/clock";

export const OSK_H = 104;

const ROWS_LO = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm.?!"];
const ROWS_UP = ["1234567890", "QWERTYUIOP", "ASDFGHJKL'", "ZXCVBNM.?!"];

const KEY_CLS =
  "w-[42] h-[18] rounded-sm items-center justify-center bg-[#1c232e] border-[#252e3a] transition-colors duration-100 focus:bg-[#4a1418] focus:border-[#ff4757]";

interface KeyboardProps {
  /** Virtual frame the keyboard was opened on — a press that opened it must
   *  not also type on the freshly focused key in the same frame. */
  openedFrame: number;
  onKey: (ch: string) => void;
  onSpace: () => void;
  onBackspace: () => void;
  onClose: () => void;
}

export function Keyboard(props: KeyboardProps) {
  const [shift, setShift] = createSignal(false);

  const keyAt = (r: number, c: number): string => (shift() ? ROWS_UP : ROWS_LO)[r][c];

  const press = (r: number, c: number) => {
    if (virtualFrame() === props.openedFrame) return;
    props.onKey(keyAt(r, c));
  };

  // `latched`: this component mounts under a held TRIANGLE (the opener).
  onButtonPress(BTN.SQUARE, () => props.onBackspace(), { latched: true });
  onButtonPress(BTN.TRIANGLE, () => props.onSpace(), { latched: true });
  onButtonPress(BTN.CROSS, () => props.onClose(), { latched: true });
  onButtonPress(BTN.RTRIGGER, () => setShift(!shift()), { latched: true });

  return (
    <FocusScope
      restoreFocus={false}
      class="flex-col px-2 pt-1 gap-1 bg-[#10151c] border-[#1d2634]"
      style={{ height: OSK_H }}
    >
      <FocusGrid columns={10} wrap class="flex-col gap-1">
        {ROWS_LO.map((row, r) => (
          <View class="flex-row gap-1 justify-center">
            {row.split("").map((_, c) => (
              <Focusable class={KEY_CLS} onPress={() => press(r, c)}>
                <Text class="text-xs font-bold" style={{ textColor: "#dbe7ee", lineHeight: 12 }}>
                  {keyAt(r, c)}
                </Text>
              </Focusable>
            ))}
          </View>
        ))}
      </FocusGrid>
      <View class="flex-row justify-center">
        <Text class="text-xs tracking-wide" style={{ textColor: "#5f7480", lineHeight: 12 }}>
          ○ KEY · △ SPACE · □ DELETE · R SHIFT · START SEARCH · × CLOSE
        </Text>
      </View>
    </FocusScope>
  );
}
