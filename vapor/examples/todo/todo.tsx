// VAPOR TODO — TodoMVC for the Game Boy Advance, written as real Vue Vapor.
//
// This file has two executions. Under the oracle it runs unmodified on
// @vue/runtime-vapor (vue 3.6) — ref/computed are the real thing and the
// UI components below are genuine vapor functional components. Under the
// Pocket Vapor compiler it is lowered to C: refs become state-struct slots,
// computeds become cached recompute functions, JSX bindings become paint
// effects with compile-time dependency masks, keymaps become ROM function-
// pointer tables, components inline to zero-cost paint code, and the todo
// list becomes a fixed-capacity arena pool. Same semantics, no JavaScript
// engine.
//
// Controls — list mode: Up/Down cursor, A toggle done, B delete, R cycle
// filter, Select clear completed, Start new todo. Edit mode: Left/Right
// scrub glyph, A put glyph, B backspace, Start save, Select cancel.

import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
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
const NARROW = SCREEN.width < 30;

// ---- UI components ----------------------------------------------------------
// Presentational, pure functions of props: they own their palette and
// indentation; the app owns state and layout (which row each one lives on).

function TitleBar(props: { line: number; text: string }) {
  return (
    <row y={props.line} class="bg-emerald-500 text-slate-950 align-center">
      {props.text}
    </row>
  );
}

function StatusBar(props: { line: number; count: number; label: string }) {
  return (
    <row y={props.line} x={1} class="text-emerald-400">
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
      class={props.selected ? "bg-slate-100 text-slate-950" : props.todo.done ? "text-slate-500" : ""}
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
    <row y={props.line} x={1} class="bg-amber-300 text-slate-950">
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

// ---- app --------------------------------------------------------------------

export default () => {
  const todos = ref<Todo[]>([
    { text: "SHIP POCKET VAPOR", done: false },
    { text: "WRITE THE COMPILER", done: true },
    { text: "RUN ON A REAL GBA", done: false },
  ]);
  const cursor = ref(0);
  const filter = ref(0);
  const editing = ref(false);
  const draft = ref("");
  const glyph = ref(0);

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
    editing.value = true;
    glyph.value = 0;
  }
  function closeEditor() {
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
    [Button.Up]: () => moveCursor(-1),
    [Button.Down]: () => moveCursor(1),
    [Button.A]: toggleDone,
    [Button.B]: deleteCurrent,
    [Button.R]: cycleFilter,
    [Button.Right]: cycleFilter,
    [Button.Select]: clearDone,
    [Button.Start]: openEditor,
  };

  const editKeys: Keymap = {
    [Button.Left]: () => scrubGlyph(-1),
    [Button.Right]: () => scrubGlyph(1),
    [Button.A]: putGlyph,
    [Button.B]: () => {
      draft.value = draft.value.slice(0, -1);
    },
    [Button.Start]: saveDraft,
    [Button.Select]: closeEditor,
  };

  onButton((b) => (editing.value ? editKeys : listKeys)[b]?.());

  return (
    <>
      <TitleBar line={0} text="POCKET VAPOR TODO" />
      <StatusBar line={1} count={remaining.value} label={FILTERS[filter.value]} />
      {visible.value.map((t, i) => (
        <TodoRow line={LIST_Y + i} todo={t} selected={t === current.value} />
      ))}
      {filtered.value.length === 0 ? <Notice line={LIST_Y} text="NOTHING HERE" /> : null}
      {editing.value ? (
        <EditorBar line={EDIT_Y} draft={draft.value} glyph={GLYPHS[glyph.value]} />
      ) : null}
      <HelpBar
        line={HELP_Y}
        text={
          editing.value
            ? NARROW
              ? "A:+ B:- ST:OK SE:Q"
              : "A:PUT B:DEL ST:SAVE SE:QUIT"
            : NARROW
              ? "A:OK B:X >:F ST:NEW"
              : "A:DONE B:DEL R:FILT ST:NEW"
        }
      />
    </>
  );
};
