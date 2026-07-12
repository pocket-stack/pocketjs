// demos/im/keyboard.tsx — the on-screen keyboard (OSK).
//
// The PSP has no hardware keyboard, so text entry is a focus grid: 40 key
// tiles under FocusGrid row/column d-pad traversal, CIRCLE presses the
// focused key, and the face buttons carry the chords every PSP OSK grew —
// SQUARE deletes, START sends, CROSS closes, RTRIGGER latches shift. The
// FocusScope keeps d-pad traversal inside the grid while the keyboard is up.
//
// Both case rows are string literals so the font atlas bakes every glyph a
// user can type (scripts/build.ts harvests codepoints from literals).

import { createSignal } from "solid-js";
import { FocusGrid, FocusScope, Focusable, Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { virtualFrame } from "@pocketjs/framework/clock";

export const OSK_H = 104;

const ROWS_LO = ["1234567890", "qwertyuiop", "asdfghjkl'", "zxcvbnm.?!"];
const ROWS_UP = ["1234567890", "QWERTYUIOP", "ASDFGHJKL'", "ZXCVBNM.?!"];

const KEY_CLS =
  "w-[42] h-[18] rounded-sm items-center justify-center bg-[#141f2a] border-[#1c2a38] transition-colors duration-100 focus:bg-[#33470f] focus:border-[#b8f34a]";

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

  /** The one source of truth for "which glyph is this key" — press() types it
   *  and the key cap renders it, so the two can never disagree. */
  const keyAt = (r: number, c: number): string => (shift() ? ROWS_UP : ROWS_LO)[r][c];

  const press = (r: number, c: number) => {
    if (virtualFrame() === props.openedFrame) return;
    props.onKey(keyAt(r, c));
  };

  // START = send stays registered in the thread — it works with the keyboard
  // open or closed, so a stashed draft can be fired without reopening it.
  // `latched`: this component mounts under a held TRIANGLE (the opener).
  onButtonPress(BTN.SQUARE, () => props.onBackspace(), { latched: true });
  onButtonPress(BTN.TRIANGLE, () => props.onSpace(), { latched: true });
  onButtonPress(BTN.CROSS, () => props.onClose(), { latched: true });
  onButtonPress(BTN.RTRIGGER, () => setShift(!shift()), { latched: true });

  return (
    <FocusScope
      restoreFocus={false}
      class="flex-col px-2 pt-1 gap-1 bg-[#0a1118] border-[#1a2733]"
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
          ○ KEY · △ SPACE · □ DELETE · R SHIFT · START SEND · × CLOSE
        </Text>
      </View>
    </FocusScope>
  );
}
