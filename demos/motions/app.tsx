// demos/motions — yui540 motion studies on baked keyframe timelines.
//
// Four pages mirror the original portfolio pages — motions/53, /56, /30 and
// /64 — each a grid of SIX tiles playing together (3x2 here for the PSP's
// landscape screen; the originals are 2x3 portrait). Every animation is a
// `theme.keyframes` + `theme.animation` entry in ./pocket.config.ts applied
// through static `animate-<name>` utilities; a page-wide `loop` period
// replays all six tiles in sync, like the original page remount. The /64
// page runs on the 3D pipeline (`perspective-[N]` roots + rotate-x/y +
// translate-z), and the reload tile strokes the new arc primitive.
// ZERO per-frame JS runs while a page plays.
//
// Left/Right on the d-pad switch pages.

import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

// ---------------------------------------------------------------------------
// Tile chrome: 3x2 grid of 150x116 rounded cards
// ---------------------------------------------------------------------------

const TILE_POS = [
  "absolute left-[9] top-[18] w-[150] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[165] top-[18] w-[150] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[321] top-[18] w-[150] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[9] top-[140] w-[150] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[165] top-[140] w-[150] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
  "absolute left-[321] top-[140] w-[150] h-[116] rounded-[14px] bg-[#f1f1f1] overflow-hidden",
];

function Caption(props: { label: string; light?: boolean }) {
  return (
    <View class="absolute left-0 bottom-[3] w-full flex-row justify-center">
      <Show
        when={props.light}
        fallback={<Text class="text-xs font-bold text-[#888] tracking-wide">{props.label}</Text>}
      >
        <Text class="text-xs font-bold text-[#f1f1f1] tracking-wide">{props.label}</Text>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// PAGE 1 — motions/53 (functional micro-interactions)
// ---------------------------------------------------------------------------

/** Menu: the pill stretches open; dots morph into an X; T/B/I items rise. */
function Menu53() {
  return (
    <>
      <View class="absolute left-[12] top-[34] w-[30] h-[30] rounded-[15px] bg-white overflow-hidden animate-m53-menu-pill">
        <View class="absolute left-[27] top-0 w-[30] h-[30]">
          <View class="absolute left-[3] top-[3] w-[24] h-[24] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-1">
            <Image class="w-[14] h-[14]" src="icon-text.svg" />
          </View>
        </View>
        <View class="absolute left-[54] top-0 w-[30] h-[30]">
          <View class="absolute left-[3] top-[3] w-[24] h-[24] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-2">
            <Image class="w-[14] h-[14]" src="icon-bold.svg" />
          </View>
        </View>
        <View class="absolute left-[81] top-0 w-[30] h-[30]">
          <View class="absolute left-[3] top-[3] w-[24] h-[24] rounded-full bg-[#f1f1f1] flex-row justify-center items-center animate-m53-menu-item-3">
            <Image class="w-[14] h-[14]" src="icon-italic.svg" />
          </View>
        </View>
        <View class="absolute left-0 top-0 w-[30] h-[30]">
          <View class="absolute left-[5] top-[13] w-[4] h-[4] rounded-[2px] bg-[#777] animate-m53-menu-x-left" />
          <View class="absolute left-[13] top-[13] w-[4] h-[4] rounded-[2px] bg-[#777]" />
          <View class="absolute left-[21] top-[13] w-[4] h-[4] rounded-[2px] bg-[#777] animate-m53-menu-x-right" />
        </View>
      </View>
      <Caption label="MENU" />
    </>
  );
}

/** D-pad: four SEPARATED caps around trapezoid bases; caps stretch outward. */
function DPad53() {
  return (
    <>
      {/* trapezoid bases (baked from the original bottom.svg) */}
      <Image class="absolute left-[58] top-[35] w-[34] h-[17]" src="icon-base-down.svg" />
      <Image class="absolute left-[71] top-[29] w-[17] h-[34]" src="icon-base-left.svg" />
      <Image class="absolute left-[58] top-[40] w-[34] h-[17]" src="icon-base-up.svg" />
      <Image class="absolute left-[62] top-[29] w-[17] h-[34]" src="icon-base-right.svg" />
      {/* caps + baked arrow icons */}
      <View class="absolute left-[64] top-[20] w-[21] h-[19] rounded-[4px] bg-[#888] animate-m53-dpad-up">
        <Image class="absolute left-[4] top-[3] w-[13] h-[13]" src="icon-arrow-up.svg" />
      </View>
      <View class="absolute left-[82] top-[36] w-[19] h-[21] rounded-[4px] bg-[#888] animate-m53-dpad-right">
        <Image class="absolute left-[3] top-[4] w-[13] h-[13]" src="icon-arrow-right.svg" />
      </View>
      <View class="absolute left-[64] top-[53] w-[21] h-[19] rounded-[4px] bg-[#888] animate-m53-dpad-down">
        <Image class="absolute left-[4] top-[3] w-[13] h-[13]" src="icon-arrow-down.svg" />
      </View>
      <View class="absolute left-[49] top-[36] w-[19] h-[21] rounded-[4px] bg-[#888] animate-m53-dpad-left">
        <Image class="absolute left-[3] top-[4] w-[13] h-[13]" src="icon-arrow-left.svg" />
      </View>
      <Caption label="D-PAD" />
    </>
  );
}

/** Share: the white card inflates behind a FIXED, pinned logo. */
function Share53() {
  return (
    <>
      <View class="absolute left-[34] top-[30] w-[32] h-[32] rounded-[9px] bg-white animate-m53-share-a" />
      <View class="absolute left-[84] top-[30] w-[32] h-[32] rounded-[9px] bg-white animate-m53-share-b" />
      <View class="absolute left-[34] top-[30] w-[32] h-[32] flex-row justify-center items-center">
        <Image class="w-[20] h-[20]" src="icon-x.svg" />
      </View>
      <View class="absolute left-[84] top-[30] w-[32] h-[32] flex-row justify-center items-center">
        <Image class="w-[22] h-[22]" src="icon-youtube.svg" />
      </View>
      <View class="absolute left-[28] top-[10] w-[44] h-[16] overflow-hidden">
        <View class="w-full h-full flex-row justify-center items-center animate-m53-share-label-a">
          <Text class="text-xs font-bold text-[#777]">SHARE</Text>
        </View>
      </View>
      <View class="absolute left-[78] top-[10] w-[44] h-[16] overflow-hidden">
        <View class="w-full h-full flex-row justify-center items-center animate-m53-share-label-b">
          <Text class="text-xs font-bold text-[#777]">SHARE</Text>
        </View>
      </View>
      <Caption label="SHARE" />
    </>
  );
}

/** Hover: the button lifts while an arrow compartment slides open. */
function Hover53() {
  return (
    <>
      <View class="absolute left-[30] top-[30] w-[90] h-[27] rounded-[8px] bg-white shadow overflow-hidden flex-row animate-m53-hover-btn">
        <View class="flex-1 h-full flex-row justify-center items-center">
          <Text class="text-xs font-bold text-[#777] tracking-wide">BUTTON</Text>
        </View>
        <View class="relative h-full w-[22] overflow-hidden animate-m53-hover-arrow">
          <View class="absolute left-0 top-0 w-[2] h-full bg-[#f1f1f1]" />
          <Image class="absolute left-[5] top-[7] w-[12] h-[12]" src="icon-chevron.svg" />
        </View>
      </View>
      <Caption label="HOVER" />
    </>
  );
}

/** Reload: stroke arcs (the new arc primitive) wind while drawing on. */
function Reload53() {
  return (
    <>
      <View class="absolute left-[34] top-[28] w-[32] h-[32] bg-white arc-width-[5] animate-m53-arc-a" />
      <View class="absolute left-[42] top-[36] w-[16] h-[16] flex-row justify-center items-center">
        <Image class="w-[16] h-[16]" src="icon-reload.svg" />
      </View>
      <View class="absolute left-[80] top-[24] w-[40] h-[40] rounded-full bg-white" />
      <View class="absolute left-[80] top-[24] w-[40] h-[40] bg-[#777] arc-width-[2] animate-m53-arc-b" />
      <View class="absolute left-[91] top-[35] w-[18] h-[18] flex-row justify-center items-center">
        <Image class="w-[18] h-[18]" src="icon-reload.svg" />
      </View>
      <Caption label="RELOAD" />
    </>
  );
}

/** Keypad: keys squash wide, digits bob, one after another. */
function Keypad53() {
  return (
    <>
      <View class="absolute left-[25] top-[30] w-[28] h-[28]">
        <View class="absolute left-0 top-0 w-[28] h-[28] rounded-[8px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-1">
          <View class="animate-m53-key-digit-1">
            <Text class="text-base font-bold text-[#777]">1</Text>
          </View>
        </View>
      </View>
      <View class="absolute left-[61] top-[30] w-[28] h-[28]">
        <View class="absolute left-0 top-0 w-[28] h-[28] rounded-[8px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-2">
          <View class="animate-m53-key-digit-2">
            <Text class="text-base font-bold text-[#777]">2</Text>
          </View>
        </View>
      </View>
      <View class="absolute left-[97] top-[30] w-[28] h-[28]">
        <View class="absolute left-0 top-0 w-[28] h-[28] rounded-[8px] bg-[#e0e0e0] flex-row justify-center items-center animate-m53-key-3">
          <View class="animate-m53-key-digit-3">
            <Text class="text-base font-bold text-[#777]">3</Text>
          </View>
        </View>
      </View>
      <Caption label="KEYPAD" />
    </>
  );
}

// ---------------------------------------------------------------------------
// PAGE 2 — motions/56
// ---------------------------------------------------------------------------

function Launch56() {
  return (
    <>
      <View class="absolute left-[62] top-[28] w-[26] h-[26] overflow-hidden animate-m56-applaunch-box">
        <View class="absolute inset-0 rounded-[9px] bg-[#888] animate-m56-applaunch-press" />
      </View>
      <Caption label="LAUNCH" />
    </>
  );
}

function Layout56() {
  return (
    <>
      <View class="absolute left-[28] top-[14] w-[94] h-[61]">
        <View class="absolute inset-0 animate-m56-layout-p1">
          <View class="absolute left-0 top-0 h-full w-[48] rounded-[8px] bg-white animate-m56-layout-left" />
          <View class="absolute left-[46] top-0 h-full w-[48] animate-m56-layout-right">
            <View class="absolute left-0 top-0 w-full h-[31] bg-white animate-m56-layout-half-top" />
            <View class="absolute left-0 top-[30] w-full h-[31] bg-white animate-m56-layout-half-bottom" />
          </View>
        </View>
        <View class="absolute inset-0 animate-m56-layout-p2">
          <View class="absolute left-0 top-0 w-full h-[21] bg-white animate-m56-layout-row-top" />
          <View class="absolute left-0 top-[20] w-full h-[21] bg-white animate-m56-layout-row-mid" />
          <View class="absolute left-0 top-[40] w-full h-[21] bg-white animate-m56-layout-row-bottom" />
        </View>
      </View>
      <Caption label="LAYOUT" />
    </>
  );
}

function Shutter56() {
  return (
    <>
      <View class="absolute left-[28] top-0 w-[94] flex-col">
        <View class="w-full h-[4] bg-[#bbb] animate-m56-shutter-1" />
        <View class="w-full h-[4] bg-[#ccc] animate-m56-shutter-2" />
        <View class="w-full h-[4] bg-[#bbb] animate-m56-shutter-3" />
        <View class="w-full h-[4] bg-[#ccc] animate-m56-shutter-4" />
        <View class="w-full h-[8] bg-[#aaa]">
          <View class="absolute left-[38] top-[2] w-[18] h-[4] rounded-[999px] bg-[#f1f1f1]" />
        </View>
      </View>
      <Caption label="SHUTTER" />
    </>
  );
}

function Cards56() {
  return (
    <>
      <View class="absolute left-[58] top-[5] w-[35] h-[80]">
        <View class="absolute inset-0 origin-bottom animate-m56-fan-l2">
          <View class="absolute left-[3] top-0 w-[29] h-[45] rounded-[6px] bg-[#e0e0e0]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-r2">
          <View class="absolute left-[3] top-0 w-[29] h-[45] rounded-[6px] bg-[#e0e0e0]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-l1">
          <View class="absolute left-[3] top-0 w-[29] h-[45] rounded-[6px] bg-[#bbb]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-r1">
          <View class="absolute left-[3] top-0 w-[29] h-[45] rounded-[6px] bg-[#bbb]" />
        </View>
        <View class="absolute inset-0 origin-bottom animate-m56-fan-pulse">
          <View class="absolute left-[3] top-0 w-[29] h-[45] rounded-[6px] bg-[#999]" />
        </View>
      </View>
      <Caption label="CARDS" />
    </>
  );
}

function Heave56() {
  return (
    <>
      <View class="absolute left-[33] top-[30] w-[90] h-[24]">
        <View class="absolute left-0 top-0 w-[28] h-[24] rounded-[999px] bg-[#bbb] animate-m56-heave" />
      </View>
      <Caption label="HEAVE-HO" />
    </>
  );
}

function RingCorner(props: { cls1: string; cls2: string }) {
  return (
    <>
      <View class={props.cls1} />
      <View class={props.cls2} />
    </>
  );
}

function Focus56() {
  return (
    <>
      <View class="absolute left-[19] top-[28] w-[28] h-[28] flex-row justify-center items-center">
        <Text class="text-lg font-bold text-[#888]">A</Text>
      </View>
      <View class="absolute left-[61] top-[28] w-[28] h-[28] flex-row justify-center items-center">
        <Text class="text-lg font-bold text-[#888]">B</Text>
      </View>
      <View class="absolute left-[103] top-[28] w-[28] h-[28] flex-row justify-center items-center">
        <Text class="text-lg font-bold text-[#888]">C</Text>
      </View>
      <View class="absolute left-[61] top-[28] w-[28] h-[28]">
        <View class="absolute left-0 top-0 w-[28] h-[28] animate-m56-focus-ring">
          <View class="absolute inset-[-5] animate-m56-focus-pulse">
            <RingCorner
              cls1="absolute left-0 top-0 w-[9] h-[5] bg-[#ccc]"
              cls2="absolute left-0 top-0 w-[5] h-[9] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute right-0 top-0 w-[9] h-[5] bg-[#ccc]"
              cls2="absolute right-0 top-0 w-[5] h-[9] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute right-0 bottom-0 w-[9] h-[5] bg-[#ccc]"
              cls2="absolute right-0 bottom-0 w-[5] h-[9] bg-[#ccc]"
            />
            <RingCorner
              cls1="absolute left-0 bottom-0 w-[9] h-[5] bg-[#ccc]"
              cls2="absolute left-0 bottom-0 w-[5] h-[9] bg-[#ccc]"
            />
          </View>
        </View>
      </View>
      <Caption label="FOCUS" />
    </>
  );
}

// ---------------------------------------------------------------------------
// PAGE 3 — motions/30
// ---------------------------------------------------------------------------

function Reveal30() {
  return (
    <>
      <View class="absolute left-[28] top-[14] w-[94] h-[59] rounded-[6px] bg-[#ccc] overflow-hidden shadow">
        <View class="absolute left-[69] top-[41] w-[12] h-[12] rounded-full bg-white animate-m30-reveal" />
        <View class="absolute inset-0 rounded-[6px] bg-white animate-m30-reveal-cap" />
        <View class="absolute left-0 top-0 w-full h-[42] flex-col justify-center items-center gap-1 animate-m30-reveal-logo">
          <View class="w-[13] h-[13] rounded-full bg-[#e0e0e0]" />
          <View class="w-[30] h-[4] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="absolute left-[32] top-[45] w-[31] h-[9] rounded-[999px] bg-[#ccc] animate-m30-reveal-btn" />
      </View>
      <Caption label="REVEAL" />
    </>
  );
}

const GRID30_CELLS = [
  "absolute left-0 top-0 w-[23.5] h-[19.7] bg-white animate-m30-cell-c",
  "absolute left-[23.5] top-0 w-[23.5] h-[19.7] bg-white animate-m30-cell-b",
  "absolute left-[47] top-0 w-[23.5] h-[19.7] bg-white animate-m30-cell-a",
  "absolute left-[70.5] top-0 w-[23.5] h-[19.7] bg-white animate-m30-cell-b",
  "absolute left-0 top-[19.7] w-[23.5] h-[19.7] bg-white animate-m30-cell-c",
  "absolute left-[23.5] top-[19.7] w-[23.5] h-[19.7] bg-white animate-m30-cell-b",
  "absolute left-[47] top-[19.7] w-[23.5] h-[19.7] bg-white animate-m30-cell-c",
  "absolute left-[70.5] top-[19.7] w-[23.5] h-[19.7] bg-white animate-m30-cell-b",
  "absolute left-0 top-[39.4] w-[23.5] h-[19.7] bg-white animate-m30-cell-a",
  "absolute left-[23.5] top-[39.4] w-[23.5] h-[19.7] bg-white animate-m30-cell-b",
  "absolute left-[47] top-[39.4] w-[23.5] h-[19.7] bg-white animate-m30-cell-c",
  "absolute left-[70.5] top-[39.4] w-[23.5] h-[19.7] bg-white animate-m30-cell-b",
];

function Grid30() {
  return (
    <>
      <View class="absolute left-[28] top-[14] w-[94] h-[59]">
        {GRID30_CELLS.map((cls) => (
          <View class={cls} />
        ))}
        <View class="absolute left-0 top-0 w-full h-[13] overflow-hidden">
          <View class="w-full h-full bg-[#bbb] animate-m30-grid-header" />
        </View>
        <View class="absolute left-0 top-[26] w-full flex-row justify-center animate-m30-grid-text">
          <Text class="text-xs font-bold text-[#aaa]">HELLO!</Text>
        </View>
        <View class="absolute left-[32] top-[44] w-[31] h-[11] overflow-hidden">
          <View class="w-full h-full rounded-[999px] bg-[#bbb] animate-m30-grid-button" />
        </View>
      </View>
      <Caption label="GRID" />
    </>
  );
}

function Expand30() {
  return (
    <>
      <View class="absolute left-[28] top-[14] w-[94] h-[59] rounded-[5px] bg-white border-[#ccc] border-2 overflow-hidden flex-col animate-m30-expand">
        <View class="w-full h-[13] bg-[#ccc] flex-row items-center gap-1 pl-1">
          <View class="w-[5] h-[5] rounded-full bg-white" />
          <View class="w-[5] h-[5] rounded-full bg-white" />
        </View>
        <View class="flex-col gap-1 p-2 animate-m30-expand-body">
          <View class="w-[56] h-[4] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[42] h-[4] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[80] h-[20] rounded-[3px] bg-[#e0e0e0]" />
        </View>
      </View>
      <Caption label="EXPAND" />
    </>
  );
}

function Modal30() {
  return (
    <>
      <View class="absolute left-[99] top-[14] w-[9] flex-col gap-2 rotate-140">
        <View class="w-[9] h-[3] rounded-[999px] overflow-hidden rotate-28">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-1" />
        </View>
        <View class="w-[9] h-[3] rounded-[999px] overflow-hidden rotate-332">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-2" />
        </View>
      </View>
      <View class="absolute left-[40] top-[49] w-[9] flex-col gap-2 rotate-320">
        <View class="w-[9] h-[3] rounded-[999px] overflow-hidden rotate-28">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-1" />
        </View>
        <View class="w-[9] h-[3] rounded-[999px] overflow-hidden rotate-332">
          <View class="w-full h-full rounded-[999px] bg-[#ccc] animate-m30-line-2" />
        </View>
      </View>
      <View class="absolute left-[47] top-[20] w-[56] h-[37] rounded-[5px] bg-white shadow-md flex-col items-center gap-1 pt-2 animate-m30-modal">
        <View class="w-[33] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[23] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[42] h-[14] rounded-[3px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[60] top-[61] w-[31] h-[11] rounded-[999px] bg-[#ccc] origin-bottom animate-m30-modal-btn" />
      <Caption label="MODAL" />
    </>
  );
}

function Comments30() {
  return (
    <>
      <View class="absolute left-[33] top-[23] w-[33] h-[23] rounded-[4px] bg-white shadow origin-bottom flex-col gap-1 p-1 animate-m30-comment-1">
        <View class="flex-row items-center gap-1">
          <View class="w-[5] h-[5] rounded-full bg-[#e0e0e0]" />
          <View class="w-[13] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="w-[24] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[18] h-[3] rounded-[2px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[84] top-[38] w-[33] h-[23] rounded-[4px] bg-white shadow origin-bottom flex-col gap-1 p-1 animate-m30-comment-2">
        <View class="flex-row items-center gap-1">
          <View class="w-[5] h-[5] rounded-full bg-[#e0e0e0]" />
          <View class="w-[13] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        </View>
        <View class="w-[24] h-[3] rounded-[2px] bg-[#e0e0e0]" />
        <View class="w-[18] h-[3] rounded-[2px] bg-[#e0e0e0]" />
      </View>
      <View class="absolute left-[62] top-[29] w-[26] h-[19] rounded-[999px] bg-white shadow origin-bottom flex-row justify-center items-center gap-1 animate-m30-bubble">
        <View class="w-[3] h-[3] rounded-full bg-[#bbb]" />
        <View class="w-[3] h-[3] rounded-full bg-[#bbb]" />
        <View class="w-[3] h-[3] rounded-full bg-[#bbb]" />
      </View>
      <Caption label="COMMENTS" />
    </>
  );
}

function SlideIn30() {
  return (
    <>
      <View class="absolute left-[50] top-[24] w-[61] h-[40] rotate-8">
        <View class="w-full h-full rounded-[4px] bg-[#e0e0e0] animate-m30-slidein-back" />
      </View>
      <View class="absolute left-[45] top-[18] w-[61] h-[40]">
        <View class="w-full h-full rounded-[4px] bg-white shadow flex-col gap-1 p-1 animate-m30-slidein-front">
          <View class="w-[37] h-[3] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[26] h-[3] rounded-[2px] bg-[#e0e0e0]" />
          <View class="w-[53] h-[22] rounded-[3px] bg-[#f1f1f1]" />
        </View>
      </View>
      <View class="absolute left-[60] top-[63] w-[31] h-[10] rounded-[999px] bg-[#ccc] animate-m30-slidein-btn" />
      <Caption label="SLIDE-IN" />
    </>
  );
}

// ---------------------------------------------------------------------------
// PAGE 4 — motions/64 (3D transforms)
// ---------------------------------------------------------------------------

/** Door (扉): swings 110° open about its right edge inside a framed wall. */
function Door64() {
  return (
    <>
      <View class="absolute left-[40] top-[16] w-[70] h-[52] bg-[#e0e0e0]">
        <View class="absolute left-[13] top-[9] w-[45] h-[34] bg-[#999]" />
        <View class="absolute left-[13] top-[9] w-[45] h-[34] perspective-[380]">
          <View class="absolute inset-0 bg-[#aaa] translate-z-[-7]" />
          <View class="absolute left-[-4] top-0 w-[7] h-[34] bg-[#bbb] rotate-y-[90] translate-z-[-4]" />
          <View class="absolute inset-0 origin-right animate-m64-door">
            <View class="absolute inset-0 bg-[#ccc]" />
            <View class="absolute left-[4] top-[13] w-[8] h-[8] rounded-full bg-[#aaa]" />
            <View class="absolute left-[7] top-[15] w-[13] h-[5] rounded-[3px] bg-[#888] origin-left animate-m64-knob" />
          </View>
        </View>
      </View>
      <Caption label="DOOR" />
    </>
  );
}

/** The six faces of a 24px cube (front/back z ±12, sides folded 90°). */
function CubeFaces() {
  return (
    <>
      <View class="absolute inset-0 bg-[#888] translate-z-[-12]" />
      <View class="absolute inset-0 bg-[#999] translate-y-[-12] rotate-x-[90]" />
      <View class="absolute inset-0 bg-[#bbb] translate-y-[12] rotate-x-[90]" />
      <View class="absolute inset-0 bg-[#aaa] translate-x-[12] rotate-y-[90]" />
      <View class="absolute inset-0 bg-[#ccc] translate-x-[-12] rotate-y-[90]" />
      <View class="absolute inset-0 bg-[#888] translate-z-[12]" />
    </>
  );
}

/** Spin (まわる): one cube turns forever; the other somersaults and back. */
function Spin64() {
  return (
    <>
      <View class="absolute inset-0 opacity-70 perspective-[190]">
        <View class="absolute left-[33] top-[32] w-[24] h-[24] rotate-x-[-40] translate-z-[-12] animate-m64-spin">
          <CubeFaces />
        </View>
        <View class="absolute left-[93] top-[32] w-[24] h-[24] rotate-y-[40] translate-z-[-12] animate-m64-tumble">
          <CubeFaces />
        </View>
      </View>
      <Caption label="SPIN" />
    </>
  );
}

/** Pop-out (飛び出す・引っ込む): a slab rises out of a tilted floor plane. */
function PopOut64() {
  return (
    <>
      <View class="absolute inset-0 opacity-70 perspective-[190]">
        <View class="absolute left-[47] top-[14] w-[56] h-[56] rotate-x-[-45]">
          <View class="absolute left-[8] top-[22] w-[40] h-[40] rotate-x-[90] bg-[#ccc]" />
          <View class="absolute left-[14] top-[40] w-[28] h-[0] bg-[#aaa] animate-m64-rise" />
          <View class="absolute left-[14] top-[33] w-[28] h-[28] rotate-x-[90] bg-[#ccc] animate-m64-cap" />
        </View>
      </View>
      <Caption label="POP-OUT" />
    </>
  );
}

/** Stretch (伸び縮み): the cube's width stretches while it yaws 30°. */
function Stretch64() {
  return (
    <>
      <View class="absolute inset-0 opacity-70 perspective-[190]">
        <View class="absolute left-[47] top-[30] w-[28] h-[28] rotate-x-[-30] translate-z-[-14] animate-m64-stretch">
          <View class="absolute inset-0 bg-[#888] translate-z-[-14]" />
          <View class="absolute inset-0 bg-[#bbb] translate-y-[-14] rotate-x-[90]" />
          <View class="absolute inset-0 bg-[#bbb] translate-y-[14] rotate-x-[90]" />
          <View class="absolute right-0 top-0 w-[28] h-[28] bg-[#aaa] translate-x-[14] rotate-y-[90]" />
          <View class="absolute left-0 top-0 w-[28] h-[28] bg-[#aaa] translate-x-[-14] rotate-y-[90]" />
          <View class="absolute inset-0 bg-[#888] translate-z-[14]" />
        </View>
      </View>
      <Caption label="STRETCH" />
    </>
  );
}

/** Page flip (パラパラ): three cards swing in about their right hinges. */
function Flip64() {
  return (
    <>
      <View class="absolute left-[56] top-[14] w-[38] h-[47] perspective-[190]">
        <View class="absolute inset-0 bg-[#ccc] origin-right animate-m64-flip-1" />
        <View class="absolute inset-0 bg-[#aaa] origin-right animate-m64-flip-2" />
        <View class="absolute inset-0 bg-[#888] origin-right animate-m64-flip-3" />
      </View>
      <Caption label="FLIP" />
    </>
  );
}

/** Room (トランジション): the camera sits inside a box that turns A -> B -> A. */
function Room64() {
  return (
    <>
      <View class="absolute inset-0 perspective-[235]">
        <View class="absolute inset-0 translate-z-[-67] animate-m64-room">
          <View class="absolute inset-0 bg-[#ccc] translate-z-[70] flex-row justify-center items-center">
            <Text class="text-4xl font-bold text-[#f1f1f1]">A</Text>
          </View>
          <View class="absolute inset-0 bg-[#aaa] translate-x-[75] rotate-y-[90] flex-row justify-center items-center">
            <Text class="text-4xl font-bold text-[#f1f1f1]">B</Text>
          </View>
        </View>
      </View>
      <Caption label="ROOM" light />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

interface PageDef {
  title: string;
  source: string;
  tiles: Array<() => JSX.Element>;
}

const PAGES: PageDef[] = [
  {
    title: "MOTIONS/53",
    source: "yui540.com/motions/53",
    tiles: [Menu53, DPad53, Share53, Hover53, Reload53, Keypad53],
  },
  {
    title: "MOTIONS/56",
    source: "yui540.com/motions/56",
    tiles: [Launch56, Layout56, Shutter56, Cards56, Heave56, Focus56],
  },
  {
    title: "MOTIONS/30",
    source: "yui540.com/motions/30",
    tiles: [Reveal30, Grid30, Expand30, Modal30, Comments30, SlideIn30],
  },
  {
    title: "MOTIONS/64 · 3D",
    source: "yui540.com/motions/64",
    tiles: [Door64, Spin64, PopOut64, Stretch64, Flip64, Room64],
  },
];

export default function Motions() {
  const [index, setIndex] = createSignal(0);
  const page = () => PAGES[index()];
  onButtonPress(BTN.RIGHT | BTN.RTRIGGER, () => setIndex((i) => (i + 1) % PAGES.length));
  onButtonPress(BTN.LEFT | BTN.LTRIGGER, () => setIndex((i) => (i + PAGES.length - 1) % PAGES.length));
  return (
    <View class="w-full h-full bg-[#191919]">
      <View class="absolute left-0 top-[3] w-full flex-row justify-between px-[10]">
        <Text class="text-xs font-bold text-[#888] tracking-wide">{`${page().title} — BAKED TIMELINES`}</Text>
        <Text class="text-xs font-bold text-[#666]">{`${index() + 1}/4 · L/R`}</Text>
      </View>
      <Show when={page()} keyed>
        {(p) => (
          <>
            {p.tiles.map((Tile, i) => (
              <View class={TILE_POS[i]}>
                <Tile />
              </View>
            ))}
          </>
        )}
      </Show>
      <View class="absolute left-0 bottom-[2] w-full flex-row justify-center">
        <Text class="text-xs text-[#666]">{page().source}</Text>
      </View>
    </View>
  );
}
