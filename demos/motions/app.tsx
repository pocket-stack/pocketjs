// demos/motions — yui540 motion studies, rebuilt on baked keyframe timelines.
//
// Eighteen scenes port https://yui540.com/motions/53, /56 and /30 onto the
// PocketJS Tailwind engine: every animation is a `theme.keyframes` +
// `theme.animation` entry in ./pocket.config.ts, applied through static
// `animate-<name>` class utilities and replayed forever by the style-level
// `loop` period. ZERO per-frame JS runs while a scene plays — the whole
// choreography lives in styles.bin and ticks inside the Rust core.
//
// Left/Right on the d-pad switch scenes (remounting restarts the timelines,
// but each scene also loops on its own).

import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// motions/56 — アプリ起動 / レイアウト切り替え / シャッター / カード /
//              よいしょよいしょ / フォーカス
// ---------------------------------------------------------------------------

/** App launch: a 56px card presses in, blows up to the full stage, returns. */
function AppLaunch() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[132] top-[54] w-[56] h-[56] overflow-hidden animate-m56-applaunch-box">
        <View class="absolute inset-0 rounded-[20px] bg-[#888] animate-m56-applaunch-press" />
      </View>
    </View>
  );
}

/** Layout switch: split panes shrink apart, then a 3-row layout takes over. */
function LayoutSwap() {
  return (
    <View class="absolute left-[60] top-[23] w-[200] h-[130]">
      <View class="absolute inset-0 animate-m56-layout-p1">
        <View class="absolute left-0 top-0 h-full w-[102] rounded-[16px] bg-white animate-m56-layout-left" />
        <View class="absolute left-[98] top-0 h-full w-[102] animate-m56-layout-right">
          <View class="absolute left-0 top-0 w-full h-[66] bg-white animate-m56-layout-half-top" />
          <View class="absolute left-0 top-[64] w-full h-[66] bg-white animate-m56-layout-half-bottom" />
        </View>
      </View>
      <View class="absolute inset-0 animate-m56-layout-p2">
        <View class="absolute left-0 top-0 w-full h-[44] bg-white animate-m56-layout-row-top" />
        <View class="absolute left-0 top-[43] w-full h-[44] bg-white animate-m56-layout-row-mid" />
        <View class="absolute left-0 top-[86] w-full h-[44] bg-white animate-m56-layout-row-bottom" />
      </View>
    </View>
  );
}

/** Shutter: four slats billow open and squeeze shut above the handle bar. */
function Shutter() {
  return (
    <View class="absolute left-[60] top-0 w-[200] flex-col">
      <View class="w-full h-[8] bg-[#bbb] animate-m56-shutter-1" />
      <View class="w-full h-[8] bg-[#ccc] animate-m56-shutter-2" />
      <View class="w-full h-[8] bg-[#bbb] animate-m56-shutter-3" />
      <View class="w-full h-[8] bg-[#ccc] animate-m56-shutter-4" />
      <View class="w-full h-[16] bg-[#aaa]">
        <View class="absolute left-[82] top-[5] w-[36] h-[7] rounded-[999px] bg-[#f1f1f1]" />
      </View>
    </View>
  );
}

/** Card fan: five cards swing open around a shared bottom-center pivot. */
function CardFan() {
  return (
    <View class="absolute left-[122] top-[10] w-[75] h-[170]">
      <View class="absolute inset-0 origin-bottom animate-m56-fan-l2">
        <View class="absolute left-[6] top-0 w-[62] h-[95] rounded-[12px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute inset-0 origin-bottom animate-m56-fan-r2">
        <View class="absolute left-[6] top-0 w-[62] h-[95] rounded-[12px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute inset-0 origin-bottom animate-m56-fan-l1">
        <View class="absolute left-[6] top-0 w-[62] h-[95] rounded-[12px] bg-[#bbb]" />
      </View>
      <View class="absolute inset-0 origin-bottom animate-m56-fan-r1">
        <View class="absolute left-[6] top-0 w-[62] h-[95] rounded-[12px] bg-[#bbb]" />
      </View>
      <View class="absolute inset-0 origin-bottom animate-m56-fan-pulse">
        <View class="absolute left-[6] top-0 w-[62] h-[95] rounded-[12px] bg-[#999]" />
      </View>
    </View>
  );
}

/** Heave-ho: a pill squashes into a slab and hops right, twice. */
function HeaveHo() {
  return (
    <View class="absolute left-[70] top-[64] w-[190] h-[50]">
      <View class="absolute left-0 top-0 w-[60] h-[50] rounded-[999px] bg-[#bbb] animate-m56-heave" />
    </View>
  );
}

/** One L-shaped focus-ring corner (two #ccc bars). */
function RingCorner(props: { cls1: string; cls2: string }) {
  return (
    <>
      <View class={props.cls1} />
      <View class={props.cls2} />
    </>
  );
}

/** Focus ring: corner marks hop B -> C -> A, stretch across, snap back. */
function FocusRing() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[40] top-[50] w-[60] h-[60] flex-row justify-center items-center">
        <Text class="text-4xl font-bold text-[#888]">A</Text>
      </View>
      <View class="absolute left-[130] top-[50] w-[60] h-[60] flex-row justify-center items-center">
        <Text class="text-4xl font-bold text-[#888]">B</Text>
      </View>
      <View class="absolute left-[220] top-[50] w-[60] h-[60] flex-row justify-center items-center">
        <Text class="text-4xl font-bold text-[#888]">C</Text>
      </View>
      <View class="absolute left-[130] top-[50] w-[60] h-[60]">
        <View class="absolute left-0 top-0 w-[60] h-[60] animate-m56-focus-ring">
          <View class="absolute inset-[-10] animate-m56-focus-pulse">
            <RingCorner
              cls1="absolute left-0 top-0 w-[20] h-[10] bg-[#ccc]"
              cls2="absolute left-0 top-0 w-[10] h-[20] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute right-0 top-0 w-[20] h-[10] bg-[#ccc]"
              cls2="absolute right-0 top-0 w-[10] h-[20] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute right-0 bottom-0 w-[20] h-[10] bg-[#ccc]"
              cls2="absolute right-0 bottom-0 w-[10] h-[20] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute left-0 bottom-0 w-[20] h-[10] bg-[#ccc]"
              cls2="absolute left-0 bottom-0 w-[10] h-[20] bg-[#ccc]"
            />
          </View>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// motions/53 — メニュー / 十字キー / 共有 / ホバー / リロード / キーパッド
// ---------------------------------------------------------------------------

/** Menu: the pill stretches open, dots morph into an X, items bounce in. */
function Menu() {
  return (
    <View class="absolute left-[40] top-[56] w-[64] h-[64] rounded-[32px] bg-white overflow-hidden animate-m53-menu-pill">
      <View class="absolute left-[58] top-0 w-[64] h-[64]">
        <View class="absolute left-[6] top-[6] w-[52] h-[52] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-1">
          <Text class="text-lg font-bold text-[#777]">T</Text>
        </View>
      </View>
      <View class="absolute left-[115] top-0 w-[64] h-[64]">
        <View class="absolute left-[6] top-[6] w-[52] h-[52] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-2">
          <Text class="text-lg font-bold text-[#777]">B</Text>
        </View>
      </View>
      <View class="absolute left-[173] top-0 w-[64] h-[64]">
        <View class="absolute left-[6] top-[6] w-[52] h-[52] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-3">
          <Text class="text-lg font-bold text-[#777]">I</Text>
        </View>
      </View>
      <View class="absolute left-0 top-0 w-[64] h-[64]">
        <View class="absolute left-[12] top-[28] w-[8] h-[8] rounded-[4px] bg-[#777] animate-m53-menu-x-left" />
        <View class="absolute left-[28] top-[28] w-[8] h-[8] rounded-[4px] bg-[#777]" />
        <View class="absolute left-[44] top-[28] w-[8] h-[8] rounded-[4px] bg-[#777] animate-m53-menu-x-right" />
      </View>
    </View>
  );
}

/** D-pad: each cap stretches away from the center and snaps back in turn. */
function DPad() {
  return (
    <View class="absolute inset-0">
      {/* base plates (between cap and center) */}
      <View class="absolute left-[136] top-[78] w-[49] h-[6] rounded-[2px] bg-[#ccc]" />
      <View class="absolute left-[160] top-[60] w-[6] h-[49] rounded-[2px] bg-[#ccc]" />
      <View class="absolute left-[136] top-[84] w-[49] h-[6] rounded-[2px] bg-[#ccc]" />
      <View class="absolute left-[154] top-[60] w-[6] h-[49] rounded-[2px] bg-[#ccc]" />
      {/* caps */}
      <View class="absolute left-[138] top-[38] w-[45] h-[40] rounded-[8px] bg-[#888] animate-m53-dpad-up">
        <View class="absolute left-[9] top-[15] w-[12] h-[3] rounded-[2px] bg-white rotate-315" />
        <View class="absolute left-[24] top-[15] w-[12] h-[3] rounded-[2px] bg-white rotate-45" />
      </View>
      <View class="absolute left-[166] top-[62] w-[40] h-[45] rounded-[8px] bg-[#888] animate-m53-dpad-right">
        <View class="absolute left-[14] top-[15] w-[12] h-[3] rounded-[2px] bg-white rotate-45" />
        <View class="absolute left-[14] top-[26] w-[12] h-[3] rounded-[2px] bg-white rotate-315" />
      </View>
      <View class="absolute left-[138] top-[90] w-[45] h-[40] rounded-[8px] bg-[#888] animate-m53-dpad-down">
        <View class="absolute left-[9] top-[20] w-[12] h-[3] rounded-[2px] bg-white rotate-45" />
        <View class="absolute left-[24] top-[20] w-[12] h-[3] rounded-[2px] bg-white rotate-315" />
      </View>
      <View class="absolute left-[114] top-[62] w-[40] h-[45] rounded-[8px] bg-[#888] animate-m53-dpad-left">
        <View class="absolute left-[14] top-[15] w-[12] h-[3] rounded-[2px] bg-white rotate-315" />
        <View class="absolute left-[14] top-[26] w-[12] h-[3] rounded-[2px] bg-white rotate-45" />
      </View>
    </View>
  );
}

/** Share: buttons inflate from their bottom edge; tooltips rise behind. */
function Share() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[72] top-[62] w-[68] h-[68] rounded-[20px] bg-white flex-row justify-center items-center animate-m53-share-a">
        <Text class="text-2xl font-bold text-[#777]">X</Text>
      </View>
      <View class="absolute left-[180] top-[62] w-[68] h-[68] rounded-[20px] bg-white flex-row justify-center items-center animate-m53-share-b">
        <Text class="text-xl font-bold text-[#777]">YT</Text>
      </View>
      <View class="absolute left-[61] top-[28] w-[90] h-[30] overflow-hidden">
        <View class="w-full h-full flex-row justify-center items-center animate-m53-share-label-a">
          <Text class="text-sm font-bold text-[#777]">SHARE</Text>
        </View>
      </View>
      <View class="absolute left-[169] top-[28] w-[90] h-[30] overflow-hidden">
        <View class="w-full h-full flex-row justify-center items-center animate-m53-share-label-b">
          <Text class="text-sm font-bold text-[#777]">SHARE</Text>
        </View>
      </View>
    </View>
  );
}

/** Hover: the button lifts while an arrow compartment slides open. */
function HoverButton() {
  return (
    <View class="absolute left-[65] top-[59] w-[190] h-[58] rounded-[16px] bg-white shadow-md overflow-hidden flex-row animate-m53-hover-btn">
      <View class="flex-1 h-full flex-row justify-center items-center">
        <Text class="text-xl font-bold text-[#777] tracking-wide">BUTTON</Text>
      </View>
      <View class="relative h-full w-[46] overflow-hidden animate-m53-hover-arrow">
        <View class="absolute left-0 top-0 w-[3] h-full bg-[#f1f1f1]" />
        <View class="absolute left-[14] top-[21] w-[12] h-[3] rounded-[2px] bg-[#999] rotate-45" />
        <View class="absolute left-[14] top-[32] w-[12] h-[3] rounded-[2px] bg-[#999] rotate-315" />
      </View>
    </View>
  );
}

const RELOAD_DOTS_A = [
  "absolute left-[32] top-[10] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a0",
  "absolute left-[47] top-[16] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a1",
  "absolute left-[54] top-[32] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a2",
  "absolute left-[47] top-[47] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a3",
  "absolute left-[32] top-[54] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a4",
  "absolute left-[17] top-[47] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a5",
  "absolute left-[10] top-[32] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a6",
  "absolute left-[17] top-[16] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-a7",
];

const RELOAD_DOTS_B = [
  "absolute left-[40] top-[13] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b0",
  "absolute left-[59] top-[21] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b1",
  "absolute left-[67] top-[40] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b2",
  "absolute left-[59] top-[59] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b3",
  "absolute left-[40] top-[67] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b4",
  "absolute left-[21] top-[59] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b5",
  "absolute left-[13] top-[40] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b6",
  "absolute left-[21] top-[21] w-[5] h-[5] rounded-[2px] bg-[#777] animate-m53-reload-dot-b7",
];

/** Reload: dot arcs draw on while the whole ring winds 45° -> 220°. */
function Reload() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[86] top-[54] w-[68] h-[68] rounded-full bg-white">
        <View class="absolute inset-0 animate-m53-reload-spin-a">
          {RELOAD_DOTS_A.map((cls) => (
            <View class={cls} />
          ))}
        </View>
      </View>
      <View class="absolute left-[158] top-[46] w-[84] h-[84] rounded-full border-[#777] border-2">
        <View class="absolute inset-0 animate-m53-reload-spin-b">
          {RELOAD_DOTS_B.map((cls) => (
            <View class={cls} />
          ))}
        </View>
      </View>
    </View>
  );
}

/** Keypad: keys squash wide, digits bob, one after another. */
function Keypad() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[52] top-[54] w-[60] h-[60]">
        <View class="absolute left-0 top-0 w-[60] h-[60] rounded-[16px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-1">
          <View class="animate-m53-key-digit-1">
            <Text class="text-2xl font-bold text-[#777]">1</Text>
          </View>
        </View>
      </View>
      <View class="absolute left-[130] top-[54] w-[60] h-[60]">
        <View class="absolute left-0 top-0 w-[60] h-[60] rounded-[16px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-2">
          <View class="animate-m53-key-digit-2">
            <Text class="text-2xl font-bold text-[#777]">2</Text>
          </View>
        </View>
      </View>
      <View class="absolute left-[208] top-[54] w-[60] h-[60]">
        <View class="absolute left-0 top-0 w-[60] h-[60] rounded-[16px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-3">
          <View class="animate-m53-key-digit-3">
            <Text class="text-2xl font-bold text-[#777]">3</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// motions/30 — image mockups rebuilt with primitives
// ---------------------------------------------------------------------------

/** Circular reveal: a white splash grows from (80%, 80%); content pops in. */
function Reveal() {
  return (
    <View class="absolute left-[60] top-[20] w-[200] h-[125] rounded-[12px] bg-[#ccc] overflow-hidden shadow-md">
      <View class="absolute left-[148] top-[88] w-[24] h-[24] rounded-full bg-white animate-m30-reveal" />
      <View class="absolute left-0 top-0 w-full h-[95] flex-col justify-center items-center gap-2 animate-m30-reveal-logo">
        <View class="w-[28] h-[28] rounded-full bg-[#e0e0e0]" />
        <View class="w-[64] h-[8] rounded-[4px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[67] top-[95] w-[66] h-[18] rounded-[999px] bg-[#ccc] animate-m30-reveal-btn" />
    </View>
  );
}

const GRID_CELLS = [
  "absolute left-0 top-0 w-[50] h-[42] bg-white animate-m30-cell-c",
  "absolute left-[50] top-0 w-[50] h-[42] bg-white animate-m30-cell-b",
  "absolute left-[100] top-0 w-[50] h-[42] bg-white animate-m30-cell-a",
  "absolute left-[150] top-0 w-[50] h-[42] bg-white animate-m30-cell-b",
  "absolute left-0 top-[42] w-[50] h-[42] bg-white animate-m30-cell-c",
  "absolute left-[50] top-[42] w-[50] h-[42] bg-white animate-m30-cell-b",
  "absolute left-[100] top-[42] w-[50] h-[42] bg-white animate-m30-cell-c",
  "absolute left-[150] top-[42] w-[50] h-[42] bg-white animate-m30-cell-b",
  "absolute left-0 top-[84] w-[50] h-[42] bg-white animate-m30-cell-a",
  "absolute left-[50] top-[84] w-[50] h-[42] bg-white animate-m30-cell-b",
  "absolute left-[100] top-[84] w-[50] h-[42] bg-white animate-m30-cell-c",
  "absolute left-[150] top-[84] w-[50] h-[42] bg-white animate-m30-cell-b",
];

/** Staggered grid: cells pop in, chrome slides in from both edges. */
function Grid() {
  return (
    <View class="absolute left-[60] top-[20] w-[200] h-[126]">
      {GRID_CELLS.map((cls) => (
        <View class={cls} />
      ))}
      <View class="absolute left-0 top-0 w-full h-[28] overflow-hidden">
        <View class="w-full h-full bg-[#bbb] animate-m30-grid-header" />
      </View>
      <View class="absolute left-0 top-[64] w-full flex-row justify-center animate-m30-grid-text">
        <Text class="text-base font-bold text-[#aaa]">HELLO!</Text>
      </View>
      <View class="absolute left-[67] top-[90] w-[66] h-[24] overflow-hidden">
        <View class="w-full h-full rounded-[999px] bg-[#bbb] animate-m30-grid-button" />
      </View>
    </View>
  );
}

/** Expand: a pill stretches wide, then tall, into a full panel. */
function Expand() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[60] top-[19] w-[200] h-[125] rounded-[10px] bg-white border-[#ccc] border-[5] overflow-hidden flex-col animate-m30-expand">
        <View class="w-full h-[28] bg-[#ccc] flex-row items-center gap-1 pl-2">
          <View class="w-[10] h-[10] rounded-full bg-white" />
          <View class="w-[10] h-[10] rounded-full bg-white" />
        </View>
        <View class="flex-col gap-2 p-3 animate-m30-expand-body">
          <View class="w-[120] h-[8] rounded-[4px] bg-[#e0e0e0]" />
          <View class="w-[90] h-[8] rounded-[4px] bg-[#e0e0e0]" />
          <View class="w-[170] h-[42] rounded-md bg-[#e0e0e0]" />
        </View>
      </View>
    </View>
  );
}

/** Modal pop with jelly button and speed lines. */
function Modal() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[210] top-[30] w-[20] flex-col gap-3 rotate-140">
        <View class="w-[20] h-[7] rounded-[999px] overflow-hidden rotate-28">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-1" />
        </View>
        <View class="w-[20] h-[7] rounded-[999px] overflow-hidden rotate-332">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-2" />
        </View>
      </View>
      <View class="absolute left-[85] top-[105] w-[20] flex-col gap-3 rotate-320">
        <View class="w-[20] h-[7] rounded-[999px] overflow-hidden rotate-28">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-1" />
        </View>
        <View class="w-[20] h-[7] rounded-[999px] overflow-hidden rotate-332">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-2" />
        </View>
      </View>
      <View class="absolute left-[100] top-[43] w-[120] h-[78] rounded-[10px] bg-white shadow-lg flex-col items-center gap-2 pt-3 animate-m30-modal">
        <View class="w-[70] h-[6] rounded-[3px] bg-[#e0e0e0]" />
        <View class="w-[50] h-[6] rounded-[3px] bg-[#e0e0e0]" />
        <View class="w-[90] h-[30] rounded-[6px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[127] top-[130] w-[66] h-[24] rounded-[999px] bg-[#ccc] origin-bottom animate-m30-modal-btn" />
    </View>
  );
}

/** Comment cards spring up from their feet; the reply bubble follows. */
function Comments() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[70] top-[50] w-[70] h-[48] rounded-[8px] bg-white shadow origin-bottom flex-col gap-1 p-2 animate-m30-comment-1">
        <View class="flex-row items-center gap-1">
          <View class="w-[10] h-[10] rounded-full bg-[#e0e0e0]" />
          <View class="w-[28] h-[5] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="w-[52] h-[5] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[40] h-[5] rounded-[2px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[180] top-[80] w-[70] h-[48] rounded-[8px] bg-white shadow origin-bottom flex-col gap-1 p-2 animate-m30-comment-2">
        <View class="flex-row items-center gap-1">
          <View class="w-[10] h-[10] rounded-full bg-[#e0e0e0]" />
          <View class="w-[28] h-[5] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="w-[52] h-[5] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[40] h-[5] rounded-[2px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[132] top-[62] w-[56] h-[40] rounded-[999px] bg-white shadow origin-bottom flex-row justify-center items-center gap-1 animate-m30-bubble">
        <View class="w-[6] h-[6] rounded-full bg-[#bbb]" />
        <View class="w-[6] h-[6] rounded-full bg-[#bbb]" />
        <View class="w-[6] h-[6] rounded-full bg-[#bbb]" />
      </View>
    </View>
  );
}

/** Slide-in stack: two cards fling up from below, the button zooms in. */
function SlideIn() {
  return (
    <View class="absolute inset-0">
      <View class="absolute left-[105] top-[48] w-[130] h-[85] rotate-8">
        <View class="w-full h-full rounded-[8px] bg-[#e0e0e0] animate-m30-slidein-back" />
      </View>
      <View class="absolute left-[95] top-[38] w-[130] h-[85]">
        <View class="w-full h-full rounded-[8px] bg-white shadow-md flex-col gap-1 p-2 animate-m30-slidein-front">
          <View class="w-[80] h-[6] rounded-[3px] bg-[#e0e0e0]" />
          <View class="w-[56] h-[6] rounded-[3px] bg-[#e0e0e0]" />
          <View class="w-[114] h-[46] rounded-[6px] bg-[#f1f1f1]" />
        </View>
      </View>
      <View class="absolute left-[127] top-[135] w-[66] h-[22] rounded-[999px] bg-[#ccc] animate-m30-slidein-btn" />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

interface Scene {
  title: string;
  source: string;
  scene: () => JSX.Element;
}

const SCENES: Scene[] = [
  { title: "APP LAUNCH", source: "yui540 motions/56", scene: AppLaunch },
  { title: "LAYOUT SWAP", source: "yui540 motions/56", scene: LayoutSwap },
  { title: "SHUTTER", source: "yui540 motions/56", scene: Shutter },
  { title: "CARD FAN", source: "yui540 motions/56", scene: CardFan },
  { title: "HEAVE-HO", source: "yui540 motions/56", scene: HeaveHo },
  { title: "FOCUS RING", source: "yui540 motions/56", scene: FocusRing },
  { title: "MENU", source: "yui540 motions/53", scene: Menu },
  { title: "D-PAD", source: "yui540 motions/53", scene: DPad },
  { title: "SHARE", source: "yui540 motions/53", scene: Share },
  { title: "HOVER", source: "yui540 motions/53", scene: HoverButton },
  { title: "RELOAD", source: "yui540 motions/53", scene: Reload },
  { title: "KEYPAD", source: "yui540 motions/53", scene: Keypad },
  { title: "REVEAL", source: "yui540 motions/30", scene: Reveal },
  { title: "GRID", source: "yui540 motions/30", scene: Grid },
  { title: "EXPAND", source: "yui540 motions/30", scene: Expand },
  { title: "MODAL", source: "yui540 motions/30", scene: Modal },
  { title: "COMMENTS", source: "yui540 motions/30", scene: Comments },
  { title: "SLIDE-IN", source: "yui540 motions/30", scene: SlideIn },
];

export default function Motions() {
  const [index, setIndex] = createSignal(0);
  const scene = () => SCENES[index()];
  onButtonPress(BTN.RIGHT | BTN.RTRIGGER, () => setIndex((i) => (i + 1) % SCENES.length));
  onButtonPress(BTN.LEFT | BTN.LTRIGGER, () => setIndex((i) => (i + SCENES.length - 1) % SCENES.length));
  return (
    <View class="w-full h-full flex-col items-center justify-between bg-[#191919] py-2">
      <View class="w-full flex-row items-center justify-between px-6">
        <Text class="text-xs font-bold text-[#888] tracking-wide">MOTION LAB · BAKED KEYFRAME TIMELINES</Text>
        <Text class="text-xs font-bold text-[#666]">{`${index() + 1} / ${SCENES.length}`}</Text>
      </View>
      <View class="relative w-[320] h-[190] rounded-[20px] bg-[#f1f1f1] overflow-hidden">
        <Show when={scene()} keyed>
          {(s) => s.scene()}
        </Show>
        <View class="absolute left-0 bottom-[6] w-full flex-row justify-center gap-2">
          <Text class="text-xs font-bold text-[#888] tracking-wide">{scene().title}</Text>
          <Text class="text-xs text-[#aaa]">{scene().source}</Text>
        </View>
      </View>
      <Text class="text-xs text-[#666]">LEFT / RIGHT — SWITCH SCENE · EVERY SCENE LOOPS</Text>
    </View>
  );
}
