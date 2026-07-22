// VAPOR TODO — TodoMVC for the Game Boy Advance, written as real Vue Vapor.
//
// This file has two executions. Under the oracle it runs unmodified on
// @vue/runtime-vapor (vue 3.6) — ref/computed are the real thing. Under the
// Pocket Vapor compiler it is lowered to C: refs become state-struct slots,
// computeds become cached recompute functions, JSX bindings become paint
// effects with compile-time dependency masks, and the todo list becomes a
// fixed-capacity arena pool. Same semantics, no JavaScript engine.
//
// Controls — list mode: Up/Down cursor, A toggle done, B delete, R cycle
// filter, Select clear completed, Start new todo. Edit mode: Left/Right
// scrub glyph, A put glyph, B backspace, Start save, Select cancel.

import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";

interface Todo {
  text: string;
  done: boolean;
}

const PAL_TEXT = 0;
const PAL_TITLE = 1;
const PAL_ACCENT = 2;
const PAL_DIM = 3;
const PAL_CURSOR = 4;
const PAL_EDIT = 5;

const FILTERS = ["ALL", "ACTIVE", "DONE"];
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789";
const LIST_Y = 3;
const WINDOW = 12;
const TEXT_MAX = 20;

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
  const scroll = computed(() =>
    Math.max(0, Math.min(cursor.value - WINDOW + 1, filtered.value.length - WINDOW)),
  );
  const visible = computed(() => filtered.value.slice(scroll.value, scroll.value + WINDOW));

  function clampCursor() {
    if (cursor.value > filtered.value.length - 1) {
      cursor.value = filtered.value.length < 1 ? 0 : filtered.value.length - 1;
    }
  }

  onButton((b) => {
    if (editing.value) {
      if (b === Button.Left) {
        glyph.value = (glyph.value + GLYPHS.length - 1) % GLYPHS.length;
      } else if (b === Button.Right) {
        glyph.value = (glyph.value + 1) % GLYPHS.length;
      } else if (b === Button.A) {
        if (draft.value.length < TEXT_MAX) {
          draft.value = draft.value + GLYPHS[glyph.value];
        }
      } else if (b === Button.B) {
        draft.value = draft.value.slice(0, draft.value.length - 1);
      } else if (b === Button.Start) {
        if (draft.value.length > 0) {
          todos.value.push({ text: draft.value, done: false });
          draft.value = "";
          editing.value = false;
        }
      } else if (b === Button.Select) {
        draft.value = "";
        editing.value = false;
      }
      return;
    }
    if (b === Button.Up) {
      if (cursor.value > 0) cursor.value = cursor.value - 1;
    } else if (b === Button.Down) {
      if (cursor.value < filtered.value.length - 1) cursor.value = cursor.value + 1;
    } else if (b === Button.A) {
      const t = filtered.value[cursor.value];
      if (t) {
        t.done = !t.done;
        clampCursor();
      }
    } else if (b === Button.B) {
      const t = filtered.value[cursor.value];
      if (t) {
        todos.value.splice(todos.value.indexOf(t), 1);
        clampCursor();
      }
    } else if (b === Button.R) {
      filter.value = (filter.value + 1) % 3;
      clampCursor();
    } else if (b === Button.Select) {
      for (let i = todos.value.length - 1; i >= 0; i--) {
        if (todos.value[i].done) todos.value.splice(i, 1);
      }
      clampCursor();
    } else if (b === Button.Start) {
      editing.value = true;
      glyph.value = 0;
    }
  });

  return (
    <>
      <row y={0} x={0} pal={PAL_TITLE}>
        {" POCKET VAPOR TODO"}
      </row>
      <row y={1} x={1} pal={PAL_ACCENT}>
        {remaining.value}
        {" LEFT / "}
        {FILTERS[filter.value]}
      </row>
      {visible.value.map((t, i) => (
        <row
          y={LIST_Y + i}
          x={1}
          pal={scroll.value + i === cursor.value ? PAL_CURSOR : t.done ? PAL_DIM : PAL_TEXT}
        >
          {scroll.value + i === cursor.value ? ">" : " "}
          {"["}
          {t.done ? "X" : " "}
          {"] "}
          {t.text}
        </row>
      ))}
      {filtered.value.length === 0 ? (
        <row y={LIST_Y} x={1} pal={PAL_DIM}>
          {"NOTHING HERE"}
        </row>
      ) : null}
      {editing.value ? (
        <row y={17} x={1} pal={PAL_EDIT}>
          {"NEW: "}
          {draft.value}
          {"["}
          {GLYPHS[glyph.value]}
          {"]"}
        </row>
      ) : null}
      <row y={19} x={0} pal={PAL_DIM}>
        {editing.value ? " A:PUT B:DEL ST:SAVE SE:QUIT" : " A:DONE B:DEL R:FILT ST:NEW"}
      </row>
    </>
  );
};
