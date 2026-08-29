// apps/3ds-demo/app.tsx — dual-output acceptance demo for the 3ds-dev host.
//
// The primary display keeps only directly observable host facts: its fixed
// 400x240 bounds, one rendered image, and the live circle-pad sample. The
// auxiliary display is a 10,000-row VirtualList. Its viewport mounts only the
// visible window plus overscan, while touch drag/fling changes the canvas
// transform without laying out all rows.
//
// The auxiliary screen is 320 px wide — the classic iPhone width — but its
// 3.02" panel runs ~133 ppi against the phone's ~165, so copying the phone's
// pixel metrics 1:1 would draw everything a fifth larger than the phone drew
// it. The contact list scales them by 0.82 instead, which is the same
// PHYSICAL size and fits 5 rows on a 240 px screen: a 36 px navigation bar, a
// 36 px search field that scrolls away as the table header, 36 px contact
// rows at 16 px, and 18 px section headers that stick to the top of the table
// until the next one pushes them off.

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

// Classic iPhone table metrics at 0.82. SLOT is the section-header height and
// the VirtualList's uniform unit; a contact row and the search header each
// span two slots, which is how an 18 px header and a 36 px row share one list.
const SLOT = 18;
const ROW_SLOTS = 2;
const SEARCH_SLOTS = 2;
const ROW_HEIGHT = SLOT * ROW_SLOTS;
const SEARCH_HEIGHT = SLOT * SEARCH_SLOTS;
const NAV_HEIGHT = 36;
const LIST_TOP = NAV_HEIGHT;
const LIST_HEIGHT = 240 - LIST_TOP;

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
  /** Slot holding this section's 18 px header; contacts follow, two slots each. */
  slotStart: number;
}

const CONTACT_SECTIONS: readonly ContactSection[] = (() => {
  let contactStart = 0;
  let slotStart = SEARCH_SLOTS;
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
    slotStart += 1 + contactCount * ROW_SLOTS;
    return section;
  });
})();

const LIST_SLOTS = SEARCH_SLOTS + LIST_ROWS * ROW_SLOTS + CONTACT_SECTIONS.length;
const MAX_SCROLL = LIST_SLOTS * SLOT - LIST_HEIGHT;

// A-Z index. 26 entries never fit 204 px at a readable size, so the strip
// drops letters the way UITableView does and marks each gap with a dot. The
// touch mapping stays continuous over all 26 sections.
const INDEX_PITCH = 12;
const INDEX_ENTRIES = (() => {
  const fits = Math.floor((LIST_HEIGHT - 8) / INDEX_PITCH);
  const count = fits % 2 === 1 ? fits : fits - 1; // start and end on a letter
  const letters = (count + 1) / 2;
  return Array.from({ length: count }, (_, entry) =>
    entry % 2 === 0
      ? LETTERS[Math.round((entry / 2) * (LETTERS.length - 1) / (letters - 1))]
      : null,
  );
})();
const INDEX_PAD = (LIST_HEIGHT - INDEX_ENTRIES.length * INDEX_PITCH) / 2;

function sectionForSlot(slot: number): number {
  const bounded = Math.max(0, Math.min(LIST_SLOTS - 1, slot));
  for (let index = CONTACT_SECTIONS.length - 1; index >= 0; index--) {
    if (bounded >= CONTACT_SECTIONS[index].slotStart) return index;
  }
  return 0;
}

/** The 18 px gradient bar carrying a section letter — in the table and pinned. */
function SectionHeader(letter: () => string, debugName: string) {
  return (
    <View
      debugName={debugName}
      class="relative w-full h-[18] bg-gradient-to-b from-[#b7bec8] to-[#949ca8]"
    >
      <View class="absolute left-0 right-0 top-0 h-[1] bg-[#d2d7de]" />
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#7b838e]" />
      <Text class="absolute left-[8] top-[1] text-sm text-[#71798599] font-bold">{letter()}</Text>
      <Text class="absolute left-[8] top-0 text-sm text-white font-bold">{letter()}</Text>
    </View>
  );
}

function SearchHeader() {
  return (
    <View
      debugName="ContactsSearch"
      class="relative w-full h-[36] bg-gradient-to-b from-[#cbcfd4] to-[#a6acb4]"
    >
      <View class="absolute left-0 right-0 top-0 h-[1] bg-[#e4e7ea]" />
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#888e97]" />
      <View class="absolute left-[6] top-[6] right-[20] h-[24] flex-row items-center pl-[7] gap-[4] rounded-[12] bg-white border border-[#9aa0a8]">
        <View class="relative w-[9] h-[9]">
          <View class="absolute left-0 top-0 w-[7] h-[7] rounded-full border border-[#8b9199]" />
          <View
            class="absolute left-[5] top-[7] w-[4] h-[1] bg-[#8b9199]"
            style={{ rotate: 45 }}
          />
        </View>
        <Text class="text-sm text-[#8b9199]">Search</Text>
      </View>
    </View>
  );
}

function BottomRow(slot: number) {
  if (slot < SEARCH_SLOTS) return slot === 0 ? SearchHeader() : null;

  const sectionIndex = sectionForSlot(slot);
  const section = CONTACT_SECTIONS[sectionIndex];
  if (slot === section.slotStart) {
    return SectionHeader(() => section.letter, `ContactSection${section.letter}`);
  }

  const withinSection = slot - section.slotStart - 1;
  if (withinSection % ROW_SLOTS !== 0) return null; // the row's second slot

  const contactIndex = section.contactStart + withinSection / ROW_SLOTS;
  const ordinal = String(contactIndex + 1).padStart(5, "0");
  const given = GIVEN_NAMES[(contactIndex * 5 + sectionIndex) % GIVEN_NAMES.length];
  return (
    <View
      debugName={`VirtualContact${ordinal}`}
      class="absolute left-0 right-0 top-0 h-[36] flex-row items-center pl-[8] pb-[4] gap-[4] bg-white"
    >
      <Text class="text-base text-black">{given}</Text>
      <Text class="text-base text-black font-bold">{section.surname}</Text>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#d0d0d3]" />
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

  // The section header of the row at the top of the table stays pinned there
  // until the next section's header reaches it and pushes it off.
  const pinnedSection = () => {
    const offset = listScroller.offset();
    if (offset < SEARCH_HEIGHT) return -1;
    return sectionForSlot(Math.floor(offset / SLOT));
  };
  const pinnedLetter = () => {
    const index = pinnedSection();
    return index < 0 ? "" : CONTACT_SECTIONS[index].letter;
  };
  const pinnedShift = () => {
    const index = pinnedSection();
    if (index < 0 || index >= CONTACT_SECTIONS.length - 1) return 0;
    const nextTop = CONTACT_SECTIONS[index + 1].slotStart * SLOT - listScroller.offset();
    return nextTop < SLOT ? nextTop - SLOT : 0;
  };

  const sectionIndexForY = (y: number) => {
    const fraction = Math.max(0, Math.min(0.999999, (y - LIST_TOP) / LIST_HEIGHT));
    return Math.floor(fraction * CONTACT_SECTIONS.length);
  };
  const jumpToSection = (y: number) => {
    const section = CONTACT_SECTIONS[sectionIndexForY(y)];
    listScroller.scrollTo(section.slotStart * SLOT, { immediate: true });
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
        <View debugName="Contacts" class="relative w-full h-full bg-white overflow-hidden">
          <View debugName="ContactsTable" class="absolute left-0 right-0 top-[36] bottom-0">
            <VirtualList
              surface="auxiliary"
              controller={listScroller}
              count={LIST_SLOTS}
              rowHeight={SLOT}
              height={LIST_HEIGHT}
              overscan={ROW_HEIGHT}
              focusRows={false}
              renderRow={BottomRow}
            />

            <View
              class={pinnedSection() < 0 ? "hidden" : "absolute left-0 right-0 top-0 h-[18]"}
              style={{ translateY: pinnedShift() }}
            >
              {SectionHeader(pinnedLetter, "PinnedSection")}
            </View>
          </View>

          <View
            debugName="ContactsNavigation"
            class="absolute left-0 right-0 top-0 h-[36] bg-[#6d7e99]"
          >
            <View class="absolute left-0 right-0 top-0 h-[18] bg-gradient-to-b from-[#b2becf] to-[#8d9cb4]" />
            <View class="absolute left-0 right-0 top-[18] h-[18] bg-gradient-to-b from-[#7d8ea8] to-[#66778f]" />
            <View class="absolute left-0 right-0 top-0 h-[1] bg-[#ccd4df]" />
            <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />

            <Text class="absolute left-[62] right-[62] top-[7] text-center text-base text-[#3c4d6480] font-bold">All Contacts</Text>
            <Text class="absolute left-[62] right-[62] top-[8] text-center text-base text-white font-bold">All Contacts</Text>

            <View class="absolute left-[4] top-[6] w-[52] h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]">
              <View class="absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]" />
              <Text class="absolute left-0 right-0 top-[3] text-center text-xs text-[#39495f80] font-bold">Groups</Text>
              <Text class="absolute left-0 right-0 top-[4] text-center text-xs text-white font-bold">Groups</Text>
            </View>

            <View
              debugName="ContactsAdd"
              class="absolute right-[4] top-[6] w-[26] h-[24] rounded-[4] border border-[#3f4f66] bg-gradient-to-b from-[#9dabc0] via-[#7b8ca5] to-[#67788f]"
            >
              <View class="absolute left-[2] right-[2] top-[1] h-[1] bg-[#c8d1de80]" />
              <View class="absolute left-[7] top-[10] w-[11] h-[3] bg-white" />
              <View class="absolute left-[11] top-[6] w-[3] h-[11] bg-white" />
            </View>
          </View>

          <View
            debugName="ContactsIndex"
            ref={(node) => (contactIndexNode = node)}
            class={
              indexing()
                ? "absolute right-0 top-[36] bottom-0 w-[20] rounded-[8] bg-[#9aa3ad99]"
                : "absolute right-0 top-[36] bottom-0 w-[20]"
            }
          >
            {INDEX_ENTRIES.map((entry, index) => (
              <View
                class="absolute right-0 w-[15] flex-row items-center justify-center"
                style={{ insetT: INDEX_PAD + index * INDEX_PITCH, height: INDEX_PITCH }}
              >
                {entry === null
                  ? <View class="w-[3] h-[3] rounded-full bg-[#2f5288]" />
                  : <Text class="text-xs text-[#2f5288]">{entry}</Text>}
              </View>
            ))}
          </View>
        </View>
      </AuxiliarySurface>
    </>
  );
}
