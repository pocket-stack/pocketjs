import {
  ActionHandler,
  Match,
  Modal,
  Screen,
  Show,
  Switch,
  Text,
  View,
  type NodeMirror,
} from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { BTN } from "@pocketjs/framework/input";
import { createEffect, createSignal } from "@pocketjs/framework/reactivity";

import Cards from "../cards/app.tsx";
import Hero from "../hero/app.tsx";
import Library from "../library/app.tsx";
import Music from "../music/app.tsx";
import Notifications from "../notifications/app.tsx";
import Settings from "../settings/app.tsx";
import Stats from "../stats/app.tsx";

interface DemoRoute {
  title: string;
}

type CursorDirection = "up" | "down" | "left" | "right";

const DEMOS: DemoRoute[] = [
  {
    title: "Hero",
  },
  {
    title: "Feature Cards",
  },
  {
    title: "Game Library",
  },
  {
    title: "Now Playing",
  },
  {
    title: "Notifications",
  },
  {
    title: "Settings",
  },
  {
    title: "Mission Control",
  },
];

const DEMO_ROWS = DEMOS.reduce<Array<Array<{ demo: DemoRoute; index: number }>>>(
  (rows, demo, index) => {
    if (index % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ demo, index });
    return rows;
  },
  [],
);

const DEMO_COLUMNS = 2;
const CELL_W = 202;
const CELL_H = 32;
const CELL_GAP = 4;
const NAV_BUTTONS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;
const PICKER_BUTTONS = NAV_BUTTONS | BTN.CIRCLE;

function moveCursor(index: number, direction: CursorDirection): number {
  switch (direction) {
    case "right":
      return index + 1 < DEMOS.length && index % DEMO_COLUMNS < DEMO_COLUMNS - 1 ? index + 1 : index;
    case "left":
      return index % DEMO_COLUMNS > 0 ? index - 1 : index;
    case "down":
      return index + DEMO_COLUMNS < DEMOS.length ? index + DEMO_COLUMNS : index;
    case "up":
      return index - DEMO_COLUMNS >= 0 ? index - DEMO_COLUMNS : index;
  }
}

function applyPressedDirections(index: number, pressed: number): number {
  let next = index;
  if (pressed & BTN.DOWN) next = moveCursor(next, "down");
  if (pressed & BTN.RIGHT) next = moveCursor(next, "right");
  if (pressed & BTN.UP) next = moveCursor(next, "up");
  if (pressed & BTN.LEFT) next = moveCursor(next, "left");
  return next;
}

function cursorX(index: number): number {
  return (index % DEMO_COLUMNS) * (CELL_W + CELL_GAP);
}

function cursorY(index: number): number {
  return Math.floor(index / DEMO_COLUMNS) * (CELL_H + CELL_GAP);
}

function ActiveDemo(props: { index: number | null }) {
  return (
    <Switch>
      <Match when={props.index === null}>
        <View class="w-full h-full bg-slate-950" />
      </Match>
      <Match when={props.index === 0}>
        <Hero />
      </Match>
      <Match when={props.index === 1}>
        <Cards />
      </Match>
      <Match when={props.index === 2}>
        <Library />
      </Match>
      <Match when={props.index === 3}>
        <Music />
      </Match>
      <Match when={props.index === 4}>
        <Notifications />
      </Match>
      <Match when={props.index === 5}>
        <Settings />
      </Match>
      <Match when={props.index === 6}>
        <Stats />
      </Match>
    </Switch>
  );
}

function DemoPicker(props: {
  open: boolean;
  current: number | null;
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const initialCursor = props.current ?? 0;
  const [cursor, setCursor] = createSignal(initialCursor);
  let ring: NodeMirror | undefined;
  let previousCursor = initialCursor;

  const pick = (index: number) => {
    props.onPick(index);
    props.onClose();
  };

  const handlePickerPress = (pressed: number) => {
    const next = applyPressedDirections(cursor(), pressed);
    if (next !== cursor()) setCursor(next);
    if (pressed & BTN.CIRCLE) queueMicrotask(() => pick(next));
  };

  createEffect(() => {
    if (props.open) setCursor(props.current ?? 0);
  });

  createEffect(() => {
    const next = cursor();
    if (!ring || next === previousCursor) return;
    previousCursor = next;
    animate(ring, "translateX", cursorX(next), { dur: 90, easing: "out" });
    animate(ring, "translateY", cursorY(next), { dur: 90, easing: "out" });
  });

  return (
    <Modal
      open={() => props.open}
      panelClass="flex-col gap-2 w-[424] h-[240] p-2 rounded-xl shadow-lg bg-white border-slate-200"
    >
      <ActionHandler
        button={PICKER_BUTTONS}
        active={() => props.open}
        allowWhenBlocked
        onPress={handlePickerPress}
      />

      <View class="flex-row items-start justify-between">
        <View class="flex-col gap-1">
          <Text class="text-xs text-blue-600 tracking-wide">DEMO SWITCHER</Text>
          <Text class="text-xl text-slate-950 font-bold">Choose Demo</Text>
        </View>
        <Text class="text-xs text-slate-500">
          {props.current === null ? "CIRCLE opens" : "SELECT closes"}
        </Text>
      </View>

      <View class="relative flex-col gap-1">
        <View
          ref={ring}
          class="absolute top-0 left-0 z-5 w-[202] h-8 rounded-lg border-blue-500 shadow-md bg-transparent"
          style={{ translateX: cursorX(initialCursor), translateY: cursorY(initialCursor) }}
        />
        {DEMO_ROWS.map((row) => (
          <View class="flex-row gap-1">
            {row.map(({ demo, index }) => (
              <View
                class="h-8 w-[202] flex-row items-center justify-between px-2 rounded-lg shadow bg-white border-slate-200"
              >
                <Text class="text-sm text-slate-950 font-bold">{demo.title}</Text>
                <Show when={props.current === index}>
                  <View class="w-2 h-2 rounded-full bg-blue-600 shadow" />
                </Show>
              </View>
            ))}
            <Show when={row.length === 1}>
              <View class="h-8 w-[202]" />
            </Show>
          </View>
        ))}
      </View>

      <View class="px-1">
        <Text class="text-xs text-slate-500">
          D-pad moves by row and column. Circle opens the focused demo.
        </Text>
      </View>
    </Modal>
  );
}

export default function Launcher() {
  const [active, setActive] = createSignal<number | null>(null);
  const [pickerOpen, setPickerOpen] = createSignal(true);

  const togglePicker = () => {
    if (active() === null) {
      setPickerOpen(true);
      return;
    }
    setPickerOpen(!pickerOpen());
  };

  return (
    <Screen class="relative w-full h-full bg-slate-950 overflow-hidden">
      <ActionHandler
        button={BTN.SELECT}
        allowWhenBlocked
        onPress={togglePicker}
      />

      <ActiveDemo index={active()} />

      <DemoPicker
        open={pickerOpen()}
        current={active()}
        onPick={setActive}
        onClose={() => setPickerOpen(false)}
      />
    </Screen>
  );
}
