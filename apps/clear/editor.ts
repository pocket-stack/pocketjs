// In-place row editing: the caret-painted row text, the classic keyboard's
// handler wiring, the 15%-shade over the other rows, and the canvas lift
// that keeps the edited row above the keyboard. The host (app.tsx) supplies
// model/layout access; this module owns the editing state machine.

import { animate } from "@pocketjs/framework/animation";
import type { NodeMirror } from "@pocketjs/framework/components";
import { removeTodo, type Todo, type TodoList } from "./model.ts";
import { ROW_H, SCREEN_H } from "./metrics.ts";
import { KB_H, makeKeyboard, type Keyboard } from "./keyboard.tsx";
import type { RowSlot } from "./rows.tsx";

export interface EditorHost {
  list(): TodoList;
  order(): Todo[];
  slots: RowSlot[];
  slotFor(todoId: number): RowSlot | undefined;
  scrollOffset(): number;
  canvas(): NodeMirror | null;
  layout(animated: boolean): void;
  report(): void;
}

export interface Editor {
  kb: Keyboard;
  editing(): Todo | null;
  open(todo: Todo, wasNew: boolean): void;
  close(commit: boolean): void;
}

export function makeEditor(host: EditorHost): Editor {
  let editing: Todo | null = null;
  let editCaret = 0;
  let editOriginal = "";
  let editWasNew = false;

  function paintEditRow(): void {
    if (!editing) return;
    const slot = host.slotFor(editing.id);
    if (!slot) return;
    const t = editing.text;
    slot.text.value = `${t.slice(0, editCaret)}|${t.slice(editCaret)}`;
  }

  function shadeRows(shaded: boolean): void {
    const keep = editing ? host.slotFor(editing.id) : undefined;
    for (const slot of host.slots) {
      if (slot.todoId === -1 || slot.busy || !slot.front || slot === keep) continue;
      animate(slot.front, "opacity", shaded ? 0.15 : 1, { dur: 200, easing: "out" });
    }
  }

  function open(todo: Todo, wasNew: boolean): void {
    editing = todo;
    editWasNew = wasNew;
    editOriginal = todo.text;
    editCaret = todo.text.length;
    kb.setOpen(true);
    paintEditRow();
    shadeRows(true);
    const index = host.order().indexOf(todo);
    const rowBottom = index * ROW_H - host.scrollOffset() + ROW_H;
    const liftNeeded = Math.max(0, rowBottom - (SCREEN_H - KB_H));
    const canvas = host.canvas();
    if (canvas) {
      animate(canvas, "translateY", -host.scrollOffset() - liftNeeded, { dur: 200, easing: "out" });
    }
  }

  function close(commit: boolean): void {
    const todo = editing;
    if (!todo) return;
    shadeRows(false);
    editing = null;
    kb.setOpen(false);
    const canvas = host.canvas();
    if (canvas) {
      animate(canvas, "translateY", -host.scrollOffset(), { dur: 200, easing: "out" });
    }
    if (commit) {
      todo.text = todo.text.trim();
      if (todo.text === "") removeTodo(host.list(), todo);
      else host.report();
    } else if (editWasNew) {
      removeTodo(host.list(), todo);
    } else {
      todo.text = editOriginal;
    }
    host.layout(true);
  }

  const kb = makeKeyboard({
    onInsert(ch) {
      if (!editing || editing.text.length >= 40) return;
      editing.text = editing.text.slice(0, editCaret) + ch + editing.text.slice(editCaret);
      editCaret += ch.length;
      paintEditRow();
    },
    onBackspace() {
      if (!editing || editCaret === 0) return;
      editing.text = editing.text.slice(0, editCaret - 1) + editing.text.slice(editCaret);
      editCaret -= 1;
      paintEditRow();
    },
    onEnter: () => close(true),
  });

  return { kb, editing: () => editing, open, close };
}
