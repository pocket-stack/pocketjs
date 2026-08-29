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
const SEARCH_HEIGHT = 36;
const LIST_TOP = NAV_HEIGHT + SEARCH_HEIGHT;
const LIST_HEIGHT = 240 - LIST_TOP;
const INDEX_TOP = NAV_HEIGHT;
const INDEX_HEIGHT = 240 - INDEX_TOP;
const ROW_HEIGHT = 32;
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
interface ContactSection {
  letter: string;
  surname: string;
  contactStart: number;
  contactCount: number;
  slotStart: number;
}

const CONTACT_SECTIONS: readonly ContactSection[] = (() => {
  let contactStart = 0;
  let slotStart = 0;
  return SURNAMES.map((surname, index) => {
    const contactCount = Math.floor(LIST_ROWS / LETTERS.length) +
      (index < LIST_ROWS % LETTERS.length ? 1 : 0);
    const section = {
      letter: LETTERS[index],
      surname,
      contactStart,
      contactCount,
      slotStart,
    };
    contactStart += contactCount;
    slotStart += contactCount + 1;
    return section;
  });
})();

const LIST_SLOTS = LIST_ROWS + CONTACT_SECTIONS.length;
const MAX_SCROLL = LIST_SLOTS * ROW_HEIGHT - LIST_HEIGHT;
const INDEX_STEP = INDEX_HEIGHT / CONTACT_SECTIONS.length;

function sectionForSlot(slot: number): number {
  const bounded = Math.max(0, Math.min(LIST_SLOTS - 1, slot));
  for (let index = CONTACT_SECTIONS.length - 1; index >= 0; index--) {
    if (bounded >= CONTACT_SECTIONS[index].slotStart) return index;
  }
  return 0;
}

function BottomRow(slot: number) {
  const sectionIndex = sectionForSlot(slot);
  const section = CONTACT_SECTIONS[sectionIndex];
  if (slot === section.slotStart) {
    return (
      <View
        debugName={`ContactSection${section.letter}`}
        class="flex-row items-center w-full h-full pl-3 pr-6 bg-gradient-to-b from-[#d8dee3] to-[#aab5bd] border border-[#98a4ad]"
      >
        <Text class="text-base text-white font-bold">{section.letter}</Text>
      </View>
    );
  }

  const contactIndex = section.contactStart + slot - section.slotStart - 1;
  const ordinal = String(contactIndex + 1).padStart(5, "0");
  const name = `${GIVEN_NAMES[(contactIndex * 5 + sectionIndex) % GIVEN_NAMES.length]} ${section.surname}`;
  return (
    <View
      debugName={`VirtualContact${ordinal}`}
      class="relative flex-row items-center w-full h-full pl-3 pr-6 bg-white"
    >
      <Text class="text-base text-slate-950 font-bold">{name}</Text>
      <View class="absolute left-3 right-0 bottom-0 h-[1] bg-slate-200" />
    </View>
  );
}

export default function ThreeDsDemo() {
  const [padX, setPadX] = createSignal(0);
  const [padY, setPadY] = createSignal(0);
  const [padRaw, setPadRaw] = createSignal(analogRaw());
  const [indexing, setIndexing] = createSignal(false);
  let contactIndexNode: NodeMirror | undefined;

  const listScroller = createScroller({
    max: () => MAX_SCROLL,
    extent: () => LIST_HEIGHT,
  });

  const currentSectionIndex = () =>
    sectionForSlot(Math.floor(listScroller.offset() / ROW_HEIGHT));
  const sectionIndexForY = (y: number) => {
    const fraction = Math.max(0, Math.min(0.999999, (y - INDEX_TOP) / INDEX_HEIGHT));
    return Math.floor(fraction * CONTACT_SECTIONS.length);
  };
  const jumpToSection = (y: number) => {
    const section = CONTACT_SECTIONS[sectionIndexForY(y)];
    listScroller.scrollTo(section.slotStart * ROW_HEIGHT, { immediate: true });
  };

  createGesture({
    surface: "auxiliary",
    region: { node: () => contactIndexNode },
    axis: "y",
    panSlop: 1,
    onDown: (contact) => {
      setIndexing(true);
      listScroller.stop();
      jumpToSection(contact.y);
    },
    onPanMove: (contact) => jumpToSection(contact.y),
    onUp: () => setIndexing(false),
    onCancel: () => setIndexing(false),
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
              <Text class="text-2xl text-slate-50 font-bold">10,000 CONTACTS</Text>
              <Text class="text-xs text-cyan-300 tracking-wide">VIRTUAL CONTACTS · A-Z INDEX</Text>
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
              DRAG LIST · SCRUB A-Z INDEX
            </Text>
          </View>
        </View>
      </View>

      <AuxiliarySurface>
        <View debugName="Contacts" class="relative flex-col w-full h-full bg-white overflow-hidden">
          <View
            debugName="ContactsNavigation"
            class="relative h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#c7d3df] to-[#58728d] border border-[#4a6077]"
          >
            <Text class="text-base text-white font-bold">All Contacts</Text>
            <View class="absolute right-1 top-1 w-7 h-7 items-center justify-center rounded-md bg-gradient-to-b from-[#8299b0] to-[#435f7b] border border-[#354c63] shadow">
              <Text class="text-base text-white font-bold">+</Text>
            </View>
          </View>

          <View debugName="ContactsSearch" class="h-[36] pl-1 pr-6 py-1 bg-[#d1d6db]">
            <View class="relative flex-row items-center w-full h-full px-2 gap-1 rounded-[14px] bg-white border border-slate-400 shadow">
              <View class="relative w-4 h-4">
                <View class="absolute left-0 top-0 w-3 h-3 rounded-full border border-slate-400" />
                <View
                  class="absolute left-[9] top-[10] w-[6] h-[1] bg-slate-400"
                  style={{ rotate: 45 }}
                />
              </View>
              <Text class="text-sm text-slate-400">Search</Text>
            </View>
          </View>

          <VirtualList
            surface="auxiliary"
            controller={listScroller}
            count={LIST_SLOTS}
            rowHeight={ROW_HEIGHT}
            height={LIST_HEIGHT}
            overscan={ROW_HEIGHT}
            focusRows={false}
            renderRow={BottomRow}
          />

          <View
            debugName="ContactsIndex"
            ref={(node) => (contactIndexNode = node)}
            class={
              indexing()
                ? "absolute right-0 top-[36] w-5 h-[204] bg-[#cbd5e180]"
                : "absolute right-0 top-[36] w-5 h-[204]"
            }
          >
            {CONTACT_SECTIONS.map((section, index) => (
              <View
                class="absolute right-0 w-5 items-center justify-center"
                style={{ insetT: index * INDEX_STEP, height: INDEX_STEP }}
              >
                <Text
                  class={
                    currentSectionIndex() === index
                      ? "text-xs text-blue-800 font-bold"
                      : "text-xs text-slate-600 font-bold"
                  }
                  style={{ scaleX: 0.5, scaleY: 0.5 }}
                >
                  {section.letter}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </AuxiliarySurface>
    </>
  );
}
