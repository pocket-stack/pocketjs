import { For, Show, createMemo, createSignal, type Accessor } from "solid-js";
import { animate } from "@pocketjs/framework/animation";
import {
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import {
  createScroller,
  type Scroller,
} from "@pocketjs/framework/kinetics";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import {
  CONTACT_LIST_HEIGHT,
  CONTACT_ROW_HEIGHT,
  CONTACT_SPRING_DAMPING,
  CONTACT_SPRING_OVERSHOOT,
  CONTACT_SPRING_STIFFNESS,
  contactSelectionY,
  contactScrollTarget,
  contactVisibleIndex,
  wheelMultiplier,
} from "./contact-motion.ts";

const CONTACT_COUNT = 10_000;
const CONTACT_WINDOW_ROWS = Math.ceil(CONTACT_LIST_HEIGHT / CONTACT_ROW_HEIGHT) + 2;
const CONTACT_ROW_SLOTS = Array.from(
  { length: CONTACT_WINDOW_ROWS },
  (_, index) => index,
);
const WHEEL_ACCEL_RESET_FRAMES = 6;
const SURNAMES = [
  "Adams", "Bennett", "Carter", "Dawson", "Ellis", "Foster", "Garcia",
  "Hayes", "Irwin", "Jordan", "Keller", "Lewis", "Morris", "Nelson",
  "Owens", "Parker", "Quinn", "Reed", "Sullivan", "Turner", "Underwood",
  "Vaughn", "Walker", "Xavier", "Young", "Zimmerman",
] as const;
const GIVEN_NAMES = [
  "Avery", "Chloe", "Elliot", "Harper", "Jamie", "Morgan", "Riley", "Taylor",
] as const;

function contact(index: number) {
  const surname = SURNAMES[Math.floor(index * SURNAMES.length / CONTACT_COUNT)];
  const given = GIVEN_NAMES[(index * 5 + surname.length) % GIVEN_NAMES.length];
  const line = String((index * 17 + 31) % 100).padStart(2, "0");
  return {
    given,
    surname,
    ordinal: String(index + 1).padStart(5, "0"),
    phone: `(415) 555-01${line}`,
    email: `${given}@${surname}.com`.toLowerCase(),
  };
}

function NavigationBar(props: { title: string; back?: boolean }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#aebbcf] via-[#7d8ea8] to-[#62738b]">
      <Show when={!props.back}>
        <Text class="text-base text-white font-bold">{props.title}</Text>
      </Show>
      <Show when={props.back}>
        <View class="absolute left-[5] top-[6] h-[24] px-[8] flex-row items-center rounded-[4] bg-[#71839e] border border-[#40516a]">
          <Text class="text-xs text-white font-bold">MENU: Back</Text>
        </View>
      </Show>
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#3d4d64]" />
    </View>
  );
}

function ContactRow(props: { index: Accessor<number> }) {
  const item = createMemo(() => contact(props.index()));
  return (
    <View class="relative w-[320] h-[30] flex-row items-center pl-[10] pr-[8]">
      <Text class="w-[62] h-[18] text-sm text-[#1c222b]">{item().given}</Text>
      <Text class="w-[174] h-[18] text-sm text-[#1c222b] font-bold">
        {item().surname}
      </Text>
      <Text class="absolute right-[8] top-[7] w-[50] h-[15] text-xs text-[#8b95a3]">
        {item().ordinal}
      </Text>
    </View>
  );
}

function ContactSeparator() {
  return (
    <View class="relative w-[320] h-[30]">
      <View class="absolute left-[10] right-0 bottom-0 h-[1] bg-[#d5d8dc]" />
    </View>
  );
}

function RecycledContactList(props: {
  scroller: Scroller;
  selectionY: Accessor<number>;
  afterStep: () => void;
}) {
  const [firstIndex, setFirstIndex] = createSignal(0);

  onFrame(() => {
    props.scroller.step();
    const first = Math.max(
      0,
      Math.min(
        CONTACT_COUNT - CONTACT_WINDOW_ROWS,
        Math.floor(props.scroller.offset() / CONTACT_ROW_HEIGHT) - 1,
      ),
    );
    setFirstIndex(first);
    props.afterStep();
  });

  return (
    <View class="relative w-[320] h-[204] overflow-hidden">
      <View
        class="absolute left-0 top-0 w-[320] flex-col"
        style={{
          height: CONTACT_WINDOW_ROWS * CONTACT_ROW_HEIGHT,
          translateY: firstIndex() * CONTACT_ROW_HEIGHT - props.scroller.offset(),
        }}
      >
        <For each={CONTACT_ROW_SLOTS}>{() => <ContactSeparator />}</For>
      </View>
      <View
        class="absolute left-0 top-0 w-[320] h-[30] bg-[#2378d4]"
        style={{ translateY: props.selectionY() }}
      />
      <View
        class="absolute left-0 top-0 w-[320] flex-col"
        style={{
          height: CONTACT_WINDOW_ROWS * CONTACT_ROW_HEIGHT,
          translateY: firstIndex() * CONTACT_ROW_HEIGHT - props.scroller.offset(),
        }}
      >
        <For each={CONTACT_ROW_SLOTS}>
          {(slot) => <ContactRow index={() => firstIndex() + slot} />}
        </For>
      </View>
    </View>
  );
}

export default function ContactsPage() {
  const [destinationIndex, setDestinationIndex] = createSignal(0);
  const [selectionY, setSelectionY] = createSignal(0);
  const [detailIndex, setDetailIndex] = createSignal(0);
  const [detailOpen, setDetailOpen] = createSignal(false);
  let listPanel: NodeMirror | undefined;
  let detailPanel: NodeMirror | undefined;
  let wheelDirection = 0;
  let wheelBurst = 0;
  let wheelTargetIndex = 0;
  let wheelIdleFrames = WHEEL_ACCEL_RESET_FRAMES;
  const listScroller = createScroller({
    max: () => CONTACT_COUNT * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT,
    extent: () => CONTACT_LIST_HEIGHT,
  });
  const detail = createMemo(() => contact(detailIndex()));

  const resetWheelAcceleration = () => {
    wheelDirection = 0;
    wheelBurst = 0;
    wheelTargetIndex = destinationIndex();
    wheelIdleFrames = WHEEL_ACCEL_RESET_FRAMES;
  };

  const moveSelection = (delta: number) => {
    const nextTarget = Math.max(
      0,
      Math.min(CONTACT_COUNT - 1, wheelTargetIndex + delta),
    );
    if (nextTarget === wheelTargetIndex) return;
    wheelTargetIndex = nextTarget;
    const nextSelected = contactVisibleIndex(
      wheelTargetIndex,
      listScroller.offset(),
      CONTACT_COUNT,
    );
    setDestinationIndex(nextSelected);
    setSelectionY(contactSelectionY(nextSelected, listScroller.offset()));
    const maxOffset = CONTACT_COUNT * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT;
    const target = contactScrollTarget(
      wheelTargetIndex,
      listScroller.intent(),
      maxOffset,
    );
    if (target !== null) {
      listScroller.springTo(target, {
        overshootPx: CONTACT_SPRING_OVERSHOOT,
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  };

  const updateVisualSelection = () => {
    const nextSelected = contactVisibleIndex(
      wheelTargetIndex,
      listScroller.offset(),
      CONTACT_COUNT,
    );
    setDestinationIndex(nextSelected);
    setSelectionY(contactSelectionY(
      nextSelected,
      listScroller.offset(),
    ));
  };

  const settleReleasedSelection = () => {
    const selectedIndex = contactVisibleIndex(
      wheelTargetIndex,
      listScroller.offset(),
      CONTACT_COUNT,
    );
    wheelTargetIndex = selectedIndex;
    setDestinationIndex(selectedIndex);
    const maxOffset = CONTACT_COUNT * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT;
    const target = contactScrollTarget(
      selectedIndex,
      listScroller.offset(),
      maxOffset,
    );
    // Freeze the accumulated wheel velocity first. A fresh zero-velocity
    // spring may then pull the selected row from the half-row clip limit to
    // the +3/-3 resting anchor; no pre-release momentum survives.
    listScroller.stop();
    if (target !== null) {
      listScroller.springTo(target, {
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  };

  const acceleratedWheelDelta = (direction: -1 | 1) => {
    if (wheelDirection !== direction || wheelIdleFrames >= WHEEL_ACCEL_RESET_FRAMES) {
      wheelDirection = direction;
      wheelBurst = 0;
      wheelTargetIndex = destinationIndex();
    } else {
      wheelBurst += 1;
    }
    wheelIdleFrames = 0;
    return direction * wheelMultiplier(wheelBurst);
  };

  onFrame((buttons) => {
    if (detailOpen()) return;
    if ((buttons & BTN.UP) !== 0) {
      moveSelection(acceleratedWheelDelta(-1));
    } else if ((buttons & BTN.DOWN) !== 0) {
      moveSelection(acceleratedWheelDelta(1));
    } else {
      wheelIdleFrames = Math.min(WHEEL_ACCEL_RESET_FRAMES, wheelIdleFrames + 1);
      if (wheelDirection !== 0 && wheelIdleFrames === 1) {
        settleReleasedSelection();
      }
      if (wheelDirection !== 0 && wheelIdleFrames === WHEEL_ACCEL_RESET_FRAMES) {
        resetWheelAcceleration();
      }
    }
  });

  onButtonPress(BTN.CIRCLE, () => {
    if (detailOpen()) return;
    resetWheelAcceleration();
    setDetailIndex(destinationIndex());
    setDetailOpen(true);
    if (listPanel) animate(listPanel, "translateX", -64, { dur: 110, easing: "out" });
    if (detailPanel) animate(detailPanel, "translateX", 0, { dur: 110, easing: "out" });
  }, { latched: true });
  onButtonPress(BTN.TRIANGLE, () => {
    if (!detailOpen()) return;
    resetWheelAcceleration();
    setDetailOpen(false);
    if (listPanel) animate(listPanel, "translateX", 0, { dur: 110, easing: "out" });
    if (detailPanel) animate(detailPanel, "translateX", 320, { dur: 110, easing: "out" });
  }, { latched: true });

  return (
    <View class="relative w-[320] h-[240] bg-white overflow-hidden">
      <View
        ref={(node) => (listPanel = node)}
        class="absolute left-0 top-0 w-[320] h-[240] bg-white overflow-hidden"
      >
        <View class="absolute left-0 top-[36] w-[320] h-[204] bg-white overflow-hidden">
          <RecycledContactList
            scroller={listScroller}
            selectionY={selectionY}
            afterStep={updateVisualSelection}
          />
        </View>
        <NavigationBar title="All Contacts" />
      </View>

      <View
        ref={(node) => (detailPanel = node)}
        class="absolute left-0 top-0 w-[320] h-[240] bg-[#c5ccd3] overflow-hidden"
        style={{ translateX: 320 }}
      >
        <View class="absolute left-0 top-[36] w-[320] h-[204] flex-col px-[14] pt-[14] bg-[#c5ccd3] overflow-hidden">
          <View class="h-[56] flex-col justify-center px-[12] rounded-[8] bg-white border border-[#a4abb3]">
            <Text class="text-lg text-[#15181c] font-bold">{detail().given} {detail().surname}</Text>
            <Text class="text-xs text-[#6a727b]">Contact {detail().ordinal} of 10,000</Text>
          </View>
          <View class="h-[10]" />
          <View class="h-[72] flex-col rounded-[8] bg-white border border-[#a4abb3] overflow-hidden">
            <View class="h-[35] flex-row items-center px-[10]">
              <Text class="w-[55] text-xs text-[#55677d] font-bold">mobile</Text>
              <Text class="text-sm text-[#15181c]">{detail().phone}</Text>
            </View>
            <View class="h-[1] bg-[#c9ced4]" />
            <View class="h-[35] flex-row items-center px-[10]">
              <Text class="w-[55] text-xs text-[#55677d] font-bold">email</Text>
              <Text class="text-sm text-[#1b4fa8]">{detail().email}</Text>
            </View>
          </View>
          <View class="flex-1" />
        </View>
        <NavigationBar title="Contact Info" back />
      </View>
    </View>
  );
}
