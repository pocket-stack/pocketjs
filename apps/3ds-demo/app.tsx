// apps/3ds-demo/app.tsx — dual-output acceptance demo for the 3ds-dev host.
//
// The primary display keeps only directly observable host facts: its fixed
// 400x240 bounds, one rendered image, and the live circle-pad sample. The
// auxiliary display is a 10,000-row VirtualList. Its viewport mounts only the
// visible window plus overscan, while touch drag/fling changes the canvas
// transform without laying out all rows.

import { createSignal } from "solid-js";
import {
  AuxiliarySurface,
  Image,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { analogRaw, analogX, analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { VirtualList } from "@pocketjs/framework/virtual-list";

const PAD_TRAVEL = 26;
const LIST_ROWS = 10_000;
const NAV_HEIGHT = 36;
const SECTION_HEIGHT = 20;
const LIST_TOP = NAV_HEIGHT + SECTION_HEIGHT;
const LIST_HEIGHT = 240 - LIST_TOP;
const ROW_HEIGHT = 38;
const MAX_SCROLL = LIST_ROWS * ROW_HEIGHT - LIST_HEIGHT;
const SCROLLBAR_PADDING = 6;
const SCROLLBAR_THUMB_HEIGHT = 32;
const SCROLLBAR_TRAVEL = LIST_HEIGHT - SCROLLBAR_PADDING * 2 - SCROLLBAR_THUMB_HEIGHT;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GIVEN_NAMES = [
  "Avery",
  "Chloe",
  "Elliot",
  "Harper",
  "Jamie",
  "Morgan",
  "Riley",
  "Taylor",
] as const;
const SURNAMES = [
  "Adams",
  "Bennett",
  "Carter",
  "Dawson",
  "Ellis",
  "Foster",
  "Garcia",
  "Hayes",
  "Irwin",
  "Jordan",
  "Keller",
  "Lewis",
  "Morris",
  "Nelson",
  "Owens",
  "Parker",
  "Quinn",
  "Reed",
  "Sullivan",
  "Turner",
  "Underwood",
  "Vaughn",
  "Walker",
  "Xavier",
  "Young",
  "Zimmerman",
] as const;
const PLACES = ["CUPERTINO", "BROOKLYN", "PORTLAND", "AUSTIN"] as const;

function sectionForIndex(index: number): number {
  return Math.max(
    0,
    Math.min(LETTERS.length - 1, Math.floor((index * LETTERS.length) / LIST_ROWS)),
  );
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function BottomRow(index: number) {
  const ordinal = String(index + 1).padStart(5, "0");
  const section = sectionForIndex(index);
  const name = `${GIVEN_NAMES[(index * 5 + section) % GIVEN_NAMES.length]} ${SURNAMES[section]}`;
  return (
    <View
      debugName={`VirtualContact${ordinal}`}
      class="relative flex-col justify-center w-full h-full pl-3 pr-6 bg-white"
    >
      <Text class="text-sm text-slate-900 font-bold">{name}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">
        MOBILE · {PLACES[index % PLACES.length]}
      </Text>
      <View class="absolute left-3 right-0 bottom-0 h-[1] bg-slate-200" />
    </View>
  );
}

export default function ThreeDsDemo() {
  const [padX, setPadX] = createSignal(0);
  const [padY, setPadY] = createSignal(0);
  const [padRaw, setPadRaw] = createSignal(analogRaw());
  const [scrubbing, setScrubbing] = createSignal(false);
  let scrollbarNode: NodeMirror | undefined;

  const listScroller = createScroller({
    max: () => MAX_SCROLL,
    extent: () => LIST_HEIGHT,
  });

  const scrollFraction = () => clampFraction(listScroller.offset() / MAX_SCROLL);
  const currentSection = () =>
    LETTERS[sectionForIndex(Math.floor(listScroller.offset() / ROW_HEIGHT))];
  const thumbY = () => SCROLLBAR_PADDING + scrollFraction() * SCROLLBAR_TRAVEL;
  const scrubTo = (y: number) => {
    const fraction = clampFraction(
      (y - LIST_TOP - SCROLLBAR_PADDING - SCROLLBAR_THUMB_HEIGHT / 2) /
        SCROLLBAR_TRAVEL,
    );
    listScroller.scrollTo(fraction * MAX_SCROLL, { immediate: true });
  };

  createGesture({
    surface: "auxiliary",
    region: { node: () => scrollbarNode },
    axis: "y",
    panSlop: 1,
    onDown: (contact) => {
      setScrubbing(true);
      listScroller.stop();
      scrubTo(contact.y);
    },
    onPanMove: (contact) => scrubTo(contact.y),
    onUp: () => setScrubbing(false),
    onCancel: () => setScrubbing(false),
  });

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
              <Text class="text-xs text-cyan-300 tracking-wide">VIRTUAL WINDOW · 38 PX ROWS</Text>
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
              DRAG TO FLING · SCRUB RIGHT EDGE TO SEEK
            </Text>
          </View>
        </View>
      </View>

      <AuxiliarySurface>
        <View debugName="Contacts" class="relative flex-col w-full h-full bg-white overflow-hidden">
          <View
            debugName="ContactsNavigation"
            class="h-[36] flex-row items-center justify-between px-2 bg-gradient-to-b from-[#68b5ed] to-[#1475c4] border border-blue-800"
          >
            <View class="w-14">
              <Text class="text-xs text-white font-bold">Groups</Text>
            </View>
            <Text class="text-base text-white font-bold">All Contacts</Text>
            <View class="w-14 items-end">
              <Text class="text-base text-white font-bold">+</Text>
            </View>
          </View>

          <View
            debugName="ContactsSection"
            class="h-[20] flex-row items-center justify-between px-3 bg-[#dce6f1] border border-slate-300"
          >
            <Text class="text-xs text-blue-700 font-bold">{currentSection()}</Text>
            <Text class="text-xs text-slate-500">10,000 CONTACTS</Text>
          </View>

          <VirtualList
            surface="auxiliary"
            controller={listScroller}
            count={LIST_ROWS}
            rowHeight={ROW_HEIGHT}
            height={LIST_HEIGHT}
            overscan={ROW_HEIGHT}
            focusRows={false}
            renderRow={BottomRow}
          />

          <View
            debugName="ContactsScrollbar"
            ref={(node) => (scrollbarNode = node)}
            class="absolute right-0 top-[56] w-5 h-[184]"
          >
            <View class="absolute left-2 top-[6] w-1 h-[172] rounded-full bg-slate-300" />
            <View
              debugName="ContactsScrollbarThumb"
              class={
                scrubbing()
                  ? "absolute left-[7] top-0 w-[6] h-8 rounded-full bg-blue-600 shadow"
                  : "absolute left-[7] top-0 w-[6] h-8 rounded-full bg-slate-500 shadow"
              }
              style={{ translateY: thumbY() }}
            />
          </View>
        </View>
      </AuxiliarySurface>
    </>
  );
}
