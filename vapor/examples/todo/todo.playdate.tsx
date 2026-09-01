// PLAYDATE VAPOR TODO — the native Playdate input variant.
//
// The application remains hardware-neutral at the event boundary: list
// movement consumes RelativeAxis.Primary signed millidegrees. The Playdate
// runtime preserves physical crank motion; this app, not the host, chooses a
// 45-degree list detent. A future ESP32 encoder host can provide the same
// capability without changing this business logic.
//
// Controls — list mode: crank cursor, A toggle done, B delete, Right cycle
// filter, Up new todo, Down clear completed. Edit mode: Left/Right scrub
// glyph, A put glyph, B backspace, Up save, Down cancel.

import { computed, ref } from "vue";
import {
  Button,
  onAxisDelta,
  onButton,
  RelativeAxis,
  RelativeAxisUnits,
} from "../../host/input.ts";
import { SCREEN } from "../../host/screen.ts";

interface Todo {
  text: string;
  done: boolean;
}

type Keymap = Record<number, () => void>;

const FILTERS = ["ALL", "ACTIVE", "DONE"];
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
const LIST_Y = 3;
const WINDOW = SCREEN.height - 8;
const EDIT_Y = SCREEN.height - 3;
const HELP_Y = SCREEN.height - 1;
const TEXT_MAX = 20;
const LIST_CRANK_DEGREES = 45;
const LIST_CRANK_THRESHOLD =
  LIST_CRANK_DEGREES * RelativeAxisUnits.PerDegree;

function TitleBar(props: { line: number; text: string }) {
  return (
    <row y={props.line} class="bg-white text-black align-center">
      {props.text}
    </row>
  );
}

function StatusBar(props: { line: number; count: number; label: string }) {
  return (
    <row y={props.line} x={1} class="text-black">
      {props.count}
      {" LEFT / "}
      {props.label}
    </row>
  );
}

function TodoRow(props: { line: number; todo: Todo; selected: boolean }) {
  return (
    <row
      y={props.line}
      x={1}
      class={props.selected ? "bg-black text-white" : props.todo.done ? "text-slate-500" : ""}
    >
      {props.selected ? ">" : " "}
      {"["}
      {props.todo.done ? "X" : " "}
      {"] "}
      {props.todo.text}
    </row>
  );
}

function Notice(props: { line: number; text: string }) {
  return (
    <row y={props.line} x={1} class="text-slate-500">
      {props.text}
    </row>
  );
}

function EditorBar(props: { line: number; draft: string; glyph: string }) {
  return (
    <row y={props.line} x={1} class="bg-black text-white">
      {"NEW: "}
      {props.draft}
      {"["}
      {props.glyph}
      {"]"}
    </row>
  );
}

function HelpBar(props: { line: number; text: string }) {
  return (
    <row y={props.line} x={1} class="text-slate-500">
      {props.text}
    </row>
  );
}

export default () => {
  const todos = ref<Todo[]>([
    { text: "SHIP POCKET VAPOR", done: false },
    { text: "WRITE THE COMPILER", done: true },
    { text: "RUN ON PLAYDATE", done: false },
  ]);
  const cursor = ref(0);
  const filter = ref(0);
  const editing = ref(false);
  const draft = ref("");
  const glyph = ref(0);
  const crankRemainder = ref(0);

  const filtered = computed(() =>
    filter.value === 0
      ? todos.value
      : filter.value === 1
        ? todos.value.filter((t) => !t.done)
        : todos.value.filter((t) => t.done),
  );
  const remaining = computed(() => todos.value.filter((t) => !t.done).length);
  const current = computed(() => filtered.value[cursor.value]);
  const scroll = computed(() =>
    Math.max(0, Math.min(cursor.value - WINDOW + 1, filtered.value.length - WINDOW)),
  );
  const visible = computed(() => filtered.value.slice(scroll.value, scroll.value + WINDOW));

  function moveCursor(d: number) {
    cursor.value = Math.max(0, Math.min(cursor.value + d, filtered.value.length - 1));
  }
  function scrubGlyph(d: number) {
    glyph.value = (glyph.value + d + GLYPHS.length) % GLYPHS.length;
  }
  function toggleDone() {
    const t = current.value;
    if (t) t.done = !t.done;
    moveCursor(0);
  }
  function deleteCurrent() {
    const t = current.value;
    if (t) todos.value = todos.value.filter((x) => x !== t);
    moveCursor(0);
  }
  function clearDone() {
    todos.value = todos.value.filter((t) => !t.done);
    moveCursor(0);
  }
  function cycleFilter() {
    filter.value = (filter.value + 1) % FILTERS.length;
    moveCursor(0);
  }
  function openEditor() {
    crankRemainder.value = 0;
    editing.value = true;
    glyph.value = 0;
  }
  function closeEditor() {
    crankRemainder.value = 0;
    draft.value = "";
    editing.value = false;
  }
  function putGlyph() {
    if (draft.value.length < TEXT_MAX) draft.value += GLYPHS[glyph.value];
  }
  function saveDraft() {
    if (draft.value.length > 0) {
      todos.value.push({ text: draft.value, done: false });
      closeEditor();
    }
  }

  const listKeys: Keymap = {
    [Button.A]: toggleDone,
    [Button.B]: deleteCurrent,
    [Button.Right]: cycleFilter,
    [Button.Up]: openEditor,
    [Button.Down]: clearDone,
  };

  const editKeys: Keymap = {
    [Button.Left]: () => scrubGlyph(-1),
    [Button.Right]: () => scrubGlyph(1),
    [Button.A]: putGlyph,
    [Button.B]: () => {
      draft.value = draft.value.slice(0, -1);
    },
    [Button.Up]: saveDraft,
    [Button.Down]: closeEditor,
  };

  onButton((button) => (editing.value ? editKeys : listKeys)[button]?.());
  onAxisDelta(RelativeAxis.Primary, (delta) => {
    if (!editing.value) {
      crankRemainder.value += delta;
      const steps = Math.trunc(
        crankRemainder.value / LIST_CRANK_THRESHOLD,
      );
      if (steps !== 0) {
        crankRemainder.value %= LIST_CRANK_THRESHOLD;
        moveCursor(steps);
      }
    }
  });

  return (
    <>
      <TitleBar line={0} text="PLAYDATE VAPOR TODO" />
      <StatusBar line={1} count={remaining.value} label={FILTERS[filter.value]} />
      {visible.value.map((todo, i) => (
        <TodoRow line={LIST_Y + i} todo={todo} selected={todo === current.value} />
      ))}
      {filtered.value.length === 0 ? <Notice line={LIST_Y} text="NOTHING HERE" /> : null}
      {editing.value ? (
        <EditorBar line={EDIT_Y} draft={draft.value} glyph={GLYPHS[glyph.value]} />
      ) : null}
      <HelpBar
        line={HELP_Y}
        text={
          editing.value
            ? "A:PUT B:DEL </>:GLYPH UP:SAVE DOWN:QUIT"
            : "CRANK:MOVE A:DONE B:DEL >:FILT UP:NEW DOWN:CLEAR"
        }
      />
    </>
  );
};
