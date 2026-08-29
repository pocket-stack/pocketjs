// Pocket Clear — the classic gesture-driven todo list, rebuilt on the
// PocketJS gesture layer in Vue Vapor JSX. Every interaction is a gesture:
// swipe right to complete, swipe left to delete, tap to edit, long-press to
// reorder, pull down to create (twice as far to go back to the lists), pull
// up past the end to clear the done pile, pinch two rows apart to insert.
//
// Layout model, straight from the reference demo: the screen root clips, and
// each screen is a full-content-height CANVAS translated inside it — the
// scroller drives the canvas, absolute 62px rows ride the canvas, and screen
// switches are vertical canvas moves. The pull-to-create flap folds in real
// 3D (rotateX under a perspective root); the swipe check/cross are drawn from
// rotated bars, not glyphs.
//
// Rendering strategy: a fixed pool of row nodes mounted once. Data lives in
// plain arrays (model.ts); after every mutation layout() re-assigns todos to
// slots. Text and the done look ride per-slot refs; ALL motion (translate/
// opacity/rotation/gradient colors/height) goes through jump()/animate() on
// captured NodeMirrors — never through :style objects, whose reactive
// re-application would clobber in-flight tweens.

import { onMounted, shallowRef } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { getOps, reportAppAction } from "@pocketjs/framework/host";
import { after } from "@pocketjs/framework/clock";
import {
  clearDone,
  insertTodo,
  movePending,
  ordered,
  pendingCount,
  removeTodo,
  seedLists,
  setDone,
  MAX_TODOS,
  type Todo,
} from "./model.ts";
import {
  DONE_FROM,
  DONE_TEXT,
  DONE_TO,
  GREEN_FROM,
  GREEN_TO,
  listRowColors,
  todoRowColors,
} from "./palette.ts";
import {
  OVERSCROLL,
  PINCH_COMMIT,
  PULL_BACK,
  PULL_CLEAR,
  PULL_CREATE,
  ROW_H,
  SCREEN_H,
  SCREEN_W,
  SWIPE_COMMIT,
  SWITCH_MS,
  TITLE_FONT_SLOT,
} from "./metrics.ts";
import { KB_H, makeKeyboard } from "./keyboard.tsx";

const VIEW_H = SCREEN_H;

/** Off-canvas parking spot for unassigned row slots. */
const PARKED_Y = 4000;
/** Where the todos canvas rests while the lists screen owns the display. */
const TODOS_PARKED_Y = SCREEN_H + 2 * ROW_H;

interface RowSlot {
  node: NodeMirror | null;
  front: NodeMirror | null;
  check: NodeMirror | null;
  cross: NodeMirror | null;
  strike: NodeMirror | null;
  text: ReturnType<typeof shallowRef<string>>;
  done: ReturnType<typeof shallowRef<boolean>>;
  lift: ReturnType<typeof shallowRef<number>>;
  todoId: number;
  /** Current resting y (display index * ROW_H). */
  y: number;
  /** Mid-exit animation: layout() must not repark or reuse it yet. */
  busy: boolean;
  gradFrom: string;
  gradTo: string;
  /** Measured title width (strike-through line length). */
  textW: number;
  textFor: string;
}

export default () => {
  const lists = seedLists();
  const LISTS_H = lists.length * ROW_H;
  let activeIndex = 0;
  let screenName: "lists" | "todos" | "switching" = "lists";
  let order: Todo[] = [];
  let contentH = 0;
  let actions = 0;

  const list = () => lists[activeIndex];

  let listsCanvas: NodeMirror | null = null;
  let todosCanvas: NodeMirror | null = null;
  let flapNode: NodeMirror | null = null;
  let topSwitchNode: NodeMirror | null = null;
  let previewNode: NodeMirror | null = null;
  let footerNode: NodeMirror | null = null;
  const listRowNodes: (NodeMirror | null)[] = lists.map(() => null);

  const flapText = shallowRef("Pull to Create Item");
  const hasDone = shallowRef(false);
  const listCounts = lists.map((l) => shallowRef(String(pendingCount(l))));
  const listEmpty = lists.map((l) => shallowRef(pendingCount(l) === 0));

  const slots: RowSlot[] = Array.from({ length: MAX_TODOS }, () => ({
    node: null,
    front: null,
    check: null,
    cross: null,
    strike: null,
    text: shallowRef(""),
    done: shallowRef(false),
    lift: shallowRef(0),
    todoId: -1,
    y: PARKED_Y,
    busy: false,
    gradFrom: "",
    gradTo: "",
    textW: 0,
    textFor: "",
  }));
  const slotByTodo = new Map<number, RowSlot>();

  // -------------------------------------------------------------- editing
  let editing: Todo | null = null;
  let editCaret = 0;
  let editOriginal = "";
  let editWasNew = false;

  // -------------------------------------------------------------- scrolling
  const scroller = createScroller({
    max: () => Math.max(0, contentH - VIEW_H),
    extent: () => VIEW_H,
    overscroll: OVERSCROLL,
  });
  const listsScroller = createScroller({
    max: () => Math.max(0, LISTS_H - VIEW_H),
    extent: () => VIEW_H,
    overscroll: OVERSCROLL,
  });
  let paintedOffset = 0;
  let paintedListsOffset = 0;
  let paintedPull = 0;
  /** Whether the lists canvas sits at its above-the-todos parking spot. */
  let listsParked = false;

  function report(): void {
    actions += 1;
    reportAppAction("clear_gesture", actions);
  }

  // ---------------------------------------------------------------- layout
  function allocSlot(todo: Todo): RowSlot {
    for (const slot of slots) {
      if (slot.todoId === -1 && !slot.busy) {
        slot.todoId = todo.id;
        slot.done.value = todo.done;
        slot.lift.value = 0;
        if (slot.node) jump(slot.node, "translateX", 0);
        if (slot.front) jump(slot.front, "translateX", 0);
        slotByTodo.set(todo.id, slot);
        return slot;
      }
    }
    throw new Error("clear: row pool exhausted");
  }

  function measureTitle(slot: RowSlot, text: string): number {
    if (slot.textFor !== text) {
      slot.textFor = text;
      slot.textW = text === "" ? 0 : getOps().measureText(text, TITLE_FONT_SLOT);
    }
    return slot.textW;
  }

  /** Re-derive every slot from the model. Structural motion (row y, colors)
   *  animates when `animated`; text and looks snap. */
  function layout(animated: boolean): void {
    const current = list();
    order = ordered(current);
    contentH = order.length * ROW_H;
    const pending = pendingCount(current);
    listCounts[activeIndex].value = String(pending);
    listEmpty[activeIndex].value = pending === 0;
    hasDone.value = order.length > pending;
    if (todosCanvas) jump(todosCanvas, "height", Math.max(contentH, VIEW_H));
    // The pull-to-clear hint hides below the fold until an overscroll reveals it.
    if (footerNode) jump(footerNode, "translateY", Math.max(contentH, VIEW_H));

    const seen = new Set<RowSlot>();
    for (let index = 0; index < order.length; index += 1) {
      const todo = order[index];
      const slot = slotByTodo.get(todo.id) ?? allocSlot(todo);
      seen.add(slot);
      slot.done.value = todo.done;
      if (editing !== todo) slot.text.value = todo.text;

      const y = index * ROW_H;
      if (slot.node) {
        if (animated && slot.y !== y && slot.y !== PARKED_Y) {
          animate(slot.node, "translateY", y, { dur: 220, easing: "out" });
        } else {
          jump(slot.node, "translateY", y);
        }
      }
      slot.y = y;

      if (slot.strike && editing !== todo) {
        jump(slot.strike, "width", measureTitle(slot, todo.text));
        jump(slot.strike, "scaleX", todo.done ? 1 : 0);
        jump(slot.strike, "bgColor", todo.done ? DONE_TEXT : "#ffffff");
      }

      const [from, to] = todo.done ? [DONE_FROM, DONE_TO] : todoRowColors(index, pending);
      if (slot.front && (from !== slot.gradFrom || to !== slot.gradTo)) {
        if (animated && slot.gradFrom !== "") {
          animate(slot.front, "gradFrom", from, { dur: 220, easing: "out" });
          animate(slot.front, "gradTo", to, { dur: 220, easing: "out" });
        } else {
          jump(slot.front, "gradFrom", from);
          jump(slot.front, "gradTo", to);
        }
        slot.gradFrom = from;
        slot.gradTo = to;
      }
    }

    for (const slot of slots) {
      if (slot.todoId !== -1 && !seen.has(slot) && !slot.busy) parkSlot(slot);
    }
  }

  function parkSlot(slot: RowSlot): void {
    slotByTodo.delete(slot.todoId);
    slot.todoId = -1;
    slot.y = PARKED_Y;
    slot.gradFrom = "";
    slot.gradTo = "";
    slot.lift.value = 0;
    slot.text.value = "";
    if (slot.node) {
      jump(slot.node, "translateY", PARKED_Y);
      jump(slot.node, "translateX", 0);
    }
    if (slot.front) {
      jump(slot.front, "translateX", 0);
      jump(slot.front, "opacity", 1);
    }
    if (slot.check) jump(slot.check, "opacity", 0);
    if (slot.cross) jump(slot.cross, "opacity", 0);
    if (slot.strike) jump(slot.strike, "scaleX", 0);
  }

  /** Display index under a screen y, or -1 outside the rows. */
  function rowIndexAt(screenY: number): number {
    const index = Math.floor((screenY + scroller.offset()) / ROW_H);
    return index >= 0 && index < order.length ? index : -1;
  }

  // ---------------------------------------------------------------- editor
  function paintEditRow(): void {
    if (!editing) return;
    const slot = slotByTodo.get(editing.id);
    if (!slot) return;
    const t = editing.text;
    slot.text.value = `${t.slice(0, editCaret)}|${t.slice(editCaret)}`;
  }

  function shadeRows(shaded: boolean): void {
    const keep = editing ? slotByTodo.get(editing.id) : null;
    for (const slot of slots) {
      if (slot.todoId === -1 || slot.busy || !slot.front || slot === keep) continue;
      animate(slot.front, "opacity", shaded ? 0.15 : 1, { dur: 200, easing: "out" });
    }
  }

  function openEditor(todo: Todo, wasNew: boolean): void {
    editing = todo;
    editWasNew = wasNew;
    editOriginal = todo.text;
    editCaret = todo.text.length;
    kb.setOpen(true);
    paintEditRow();
    shadeRows(true);
    const index = order.indexOf(todo);
    const rowBottom = index * ROW_H - scroller.offset() + ROW_H;
    const liftNeeded = Math.max(0, rowBottom - (SCREEN_H - KB_H));
    if (todosCanvas) {
      animate(todosCanvas, "translateY", -scroller.offset() - liftNeeded, { dur: 200, easing: "out" });
    }
  }

  function closeEditor(commit: boolean): void {
    const todo = editing;
    if (!todo) return;
    shadeRows(false);
    editing = null;
    kb.setOpen(false);
    if (todosCanvas) {
      animate(todosCanvas, "translateY", -scroller.offset(), { dur: 200, easing: "out" });
    }
    if (commit) {
      todo.text = todo.text.trim();
      if (todo.text === "") removeTodo(list(), todo);
      else report();
    } else if (editWasNew) {
      removeTodo(list(), todo);
    } else {
      todo.text = editOriginal;
    }
    layout(true);
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
    onEnter: () => closeEditor(true),
  });

  // ------------------------------------------------------------- creation
  function createAt(index: number): void {
    const todo = insertTodo(list(), index, "");
    if (!todo) return;
    layout(false);
    report();
    openEditor(todo, true);
  }

  // ------------------------------------------------------------ navigation
  /** Park the lists canvas above the todos so a long pull drags it back in. */
  function parkListsForPulldown(): void {
    listsParked = true;
    if (listsCanvas) jump(listsCanvas, "translateY", -(LISTS_H + ROW_H));
    for (let i = 0; i < lists.length; i += 1) {
      const node = listRowNodes[i];
      if (node) {
        jump(node, "translateY", i * ROW_H);
        jump(node, "opacity", 1);
      }
    }
    listsScroller.scrollTo(0, { immediate: true });
    paintedListsOffset = 0;
  }

  function openList(index: number): void {
    activeIndex = index;
    screenName = "switching";
    const loff = listsScroller.offset();
    // The lists clear away vertically: the tapped row rides to the top edge
    // and fades, rows above stack off the top, rows below drop off the bottom.
    for (let i = 0; i < lists.length; i += 1) {
      const node = listRowNodes[i];
      if (!node) continue;
      const screenTarget = i <= index ? (i - index) * ROW_H : SCREEN_H + (i - index) * ROW_H;
      animate(node, "translateY", screenTarget + loff, { dur: SWITCH_MS, easing: "out" });
    }
    const tapped = listRowNodes[index];
    if (tapped) animate(tapped, "opacity", 0, { dur: SWITCH_MS, easing: "out" });
    // The todo stack starts squeezed at the tapped row's screen position and
    // unfolds downward while the canvas rides to the top.
    scroller.scrollTo(0, { immediate: true });
    paintedOffset = 0;
    paintedPull = 0;
    layout(false);
    for (const slot of slots) {
      if (slot.todoId !== -1 && slot.node) jump(slot.node, "translateY", 0);
    }
    if (todosCanvas) {
      jump(todosCanvas, "translateY", index * ROW_H - loff);
      animate(todosCanvas, "translateY", 0, { dur: SWITCH_MS, easing: "out" });
    }
    for (const slot of slots) {
      if (slot.todoId !== -1 && slot.node) {
        animate(slot.node, "translateY", slot.y, { dur: SWITCH_MS, easing: "out" });
      }
    }
    if (flapNode) jump(flapNode, "opacity", 0);
    after(SWITCH_MS / 1000, () => {
      screenName = "todos";
      parkListsForPulldown();
    });
    report();
  }

  function goBack(): void {
    if (editing) closeEditor(false);
    screenName = "switching";
    for (let i = 0; i < lists.length; i += 1) {
      const pending = pendingCount(lists[i]);
      listCounts[i].value = String(pending);
      listEmpty[i].value = pending === 0;
    }
    // Both canvases travel DOWN: the lists land from above, the todos drop
    // off the bottom.
    listsParked = false;
    if (listsCanvas) animate(listsCanvas, "translateY", 0, { dur: SWITCH_MS, easing: "out" });
    if (todosCanvas) animate(todosCanvas, "translateY", TODOS_PARKED_Y, { dur: SWITCH_MS, easing: "out" });
    scroller.scrollTo(0, { immediate: true });
    paintedOffset = 0;
    paintedPull = 0;
    if (flapNode) jump(flapNode, "opacity", 0);
    if (topSwitchNode) jump(topSwitchNode, "opacity", 0);
    listsScroller.scrollTo(0, { immediate: true });
    paintedListsOffset = 0;
    after(SWITCH_MS / 1000, () => {
      screenName = "lists";
    });
    report();
  }

  // ------------------------------------------------------------- gestures
  const inTodoList = () =>
    screenName === "todos" && !editing
      ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
      : null;
  const inLists = () =>
    screenName === "lists" ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H } : null;

  // Vertical pan: kinetic scroll + the three pull affordances.
  createGesture({
    axis: "y",
    region: { rect: inTodoList },
    onPanStart: () => scroller.beginDrag(),
    onPanMove: (c) => scroller.drag(-c.fdy),
    onPanEnd: (c) => {
      const off = scroller.offset();
      const overTop = -off;
      const overBottom = off - Math.max(0, contentH - VIEW_H);
      if (overTop >= PULL_BACK) {
        goBack();
        return;
      }
      if (overTop >= PULL_CREATE) {
        // Snap home (the reference shifts the canvas instantly too), then
        // open the editor on the fresh top row.
        scroller.scrollTo(0, { immediate: true });
        paintedOffset = 0;
        paintedPull = 0;
        if (todosCanvas) jump(todosCanvas, "translateY", 0);
        if (flapNode) jump(flapNode, "opacity", 0);
        createAt(0);
        return;
      }
      if (overBottom >= PULL_CLEAR && hasDone.value) {
        scroller.endDrag(0);
        const removed = clearDone(list());
        if (removed > 0) {
          layout(true);
          report();
        }
        return;
      }
      scroller.endDrag(-c.vy);
    },
    onCancel: () => scroller.endDrag(0),
  });

  // Horizontal pan on a row: complete (right) / delete (left).
  let swipeSlot: RowSlot | null = null;
  let swipeTodo: Todo | null = null;
  let swipeIndex = -1;
  let swipeArmed = false;

  /** 1:1 up to the commit bound, then damped to a third — the reference feel. */
  function swipeDisplay(dx: number): number {
    if (dx > SWIPE_COMMIT) return SWIPE_COMMIT + (dx - SWIPE_COMMIT) / 3;
    if (dx < -SWIPE_COMMIT) return -SWIPE_COMMIT + (dx + SWIPE_COMMIT) / 3;
    return dx;
  }

  /** Past the rightward bound the slider changes its mind: a pending row goes
   *  green, a done row previews its restored position tint. */
  function paintArmed(slot: RowSlot, todo: Todo, index: number, armed: boolean): void {
    if (!slot.front) return;
    if (armed) {
      if (todo.done) {
        slot.done.value = false;
        const [from, to] = todoRowColors(Math.min(index, 7), 1);
        jump(slot.front, "gradFrom", from);
        jump(slot.front, "gradTo", to);
      } else {
        jump(slot.front, "gradFrom", GREEN_FROM);
        jump(slot.front, "gradTo", GREEN_TO);
      }
    } else if (todo.done) {
      slot.done.value = true;
      jump(slot.front, "gradFrom", DONE_FROM);
      jump(slot.front, "gradTo", DONE_TO);
    } else {
      jump(slot.front, "gradFrom", slot.gradFrom);
      jump(slot.front, "gradTo", slot.gradTo);
    }
  }

  createGesture({
    axis: "x",
    region: { rect: inTodoList },
    onPanStart: (c) => {
      swipeIndex = rowIndexAt(c.startY);
      swipeTodo = swipeIndex >= 0 ? order[swipeIndex] : null;
      swipeSlot = swipeTodo ? (slotByTodo.get(swipeTodo.id) ?? null) : null;
      swipeArmed = false;
    },
    onPanMove: (c) => {
      const slot = swipeSlot;
      const todo = swipeTodo;
      if (!slot?.front || !todo) return;
      const raw = Math.max(-SCREEN_W, Math.min(SCREEN_W, c.dx));
      const disp = swipeDisplay(raw);
      jump(slot.front, "translateX", disp);
      const rightO = Math.max(0, Math.min(1, raw / SWIPE_COMMIT));
      const leftO = Math.max(0, Math.min(1, -raw / SWIPE_COMMIT));
      if (slot.check) {
        jump(slot.check, "opacity", raw > 0 ? (todo.done ? 1 - rightO : rightO) : 0);
        jump(slot.check, "translateX", Math.max(0, disp - SWIPE_COMMIT));
      }
      if (slot.cross) {
        jump(slot.cross, "opacity", leftO);
        jump(slot.cross, "translateX", Math.min(0, disp + SWIPE_COMMIT));
      }
      if (slot.strike) {
        jump(slot.strike, "scaleX", todo.done ? 1 - rightO : rightO);
      }
      const armed = raw >= SWIPE_COMMIT;
      if (armed !== swipeArmed) {
        swipeArmed = armed;
        paintArmed(slot, todo, swipeIndex, armed);
      }
    },
    onPanEnd: (c) => {
      const slot = swipeSlot;
      const todo = swipeTodo;
      swipeSlot = null;
      swipeTodo = null;
      if (!slot?.front || !todo) return;
      if (slot.check) animate(slot.check, "opacity", 0, { dur: 160, easing: "out" });
      if (slot.cross) animate(slot.cross, "opacity", 0, { dur: 160, easing: "out" });
      if (c.dx >= SWIPE_COMMIT) {
        animate(slot.front, "translateX", 0, { dur: 180, easing: "out" });
        swipeArmed = false;
        setDone(list(), todo, !todo.done);
        layout(true);
        report();
        return;
      }
      if (c.dx <= -SWIPE_COMMIT) {
        slot.busy = true;
        parkAfterExit(slot);
        if (slot.node) {
          animate(slot.node, "translateX", -(SCREEN_W + ROW_H), { dur: SWITCH_MS, easing: "out" });
        }
        removeTodo(list(), todo);
        slotByTodo.delete(todo.id);
        slot.todoId = -1;
        layout(true);
        report();
        return;
      }
      animate(slot.front, "translateX", 0, { dur: 160, easing: "out" });
      if (slot.strike) jump(slot.strike, "scaleX", todo.done ? 1 : 0);
      if (swipeArmed) {
        swipeArmed = false;
        paintArmed(slot, todo, swipeIndex, false);
      }
    },
    onCancel: () => {
      const slot = swipeSlot;
      const todo = swipeTodo;
      swipeSlot = null;
      swipeTodo = null;
      if (!slot?.front || !todo) return;
      animate(slot.front, "translateX", 0, { dur: 160, easing: "out" });
      if (slot.check) animate(slot.check, "opacity", 0, { dur: 160, easing: "out" });
      if (slot.cross) animate(slot.cross, "opacity", 0, { dur: 160, easing: "out" });
      if (slot.strike) jump(slot.strike, "scaleX", todo.done ? 1 : 0);
      if (swipeArmed) {
        swipeArmed = false;
        paintArmed(slot, todo, swipeIndex, false);
      }
    },
  });

  function parkAfterExit(slot: RowSlot): void {
    after(SWITCH_MS / 1000 + 0.02, () => {
      slot.busy = false;
      slot.y = PARKED_Y;
      slot.text.value = "";
      if (slot.node) {
        jump(slot.node, "translateY", PARKED_Y);
        jump(slot.node, "translateX", 0);
      }
      if (slot.front) {
        jump(slot.front, "translateX", 0);
        jump(slot.front, "opacity", 1);
      }
      if (slot.check) jump(slot.check, "opacity", 0);
      if (slot.cross) jump(slot.cross, "opacity", 0);
      if (slot.strike) jump(slot.strike, "scaleX", 0);
    });
  }

  // Long-press: pick a pending row up and reorder it.
  let dragSlot: RowSlot | null = null;
  let dragFrom = -1;
  let dragTo = -1;
  let dragBaseDy = 0;
  function previewShift(): void {
    for (let i = 0; i < order.length; i += 1) {
      const todo = order[i];
      if (todo.done) break;
      const slot = slotByTodo.get(todo.id);
      if (!slot?.node || slot === dragSlot) continue;
      const without = i - (i > dragFrom ? 1 : 0);
      const target = (without >= dragTo ? without + 1 : without) * ROW_H;
      if (slot.y !== target) {
        animate(slot.node, "translateY", target, { dur: 160, easing: "out" });
        slot.y = target;
      }
    }
  }
  createGesture({
    region: { rect: inTodoList },
    longPressSeconds: 0.45,
    onLongPress: (c) => {
      const index = rowIndexAt(c.startY);
      if (index < 0 || index >= pendingCount(list())) return;
      dragFrom = index;
      dragTo = index;
      dragBaseDy = c.dy;
      dragSlot = slotByTodo.get(order[index].id) ?? null;
      if (dragSlot?.node) {
        dragSlot.lift.value = 30;
        animate(dragSlot.node, "scale", 1.05, { dur: 120, easing: "out" });
      }
    },
    onMove: (c) => {
      if (!dragSlot?.node) return;
      const y = dragFrom * ROW_H + (c.dy - dragBaseDy);
      jump(dragSlot.node, "translateY", y);
      const pending = pendingCount(list());
      const hover = Math.max(0, Math.min(pending - 1, Math.round(y / ROW_H)));
      if (hover !== dragTo) {
        dragTo = hover;
        previewShift();
      }
    },
    onUp: () => {
      const slot = dragSlot;
      dragSlot = null;
      if (!slot?.node || dragFrom < 0) return;
      if (dragTo !== dragFrom) {
        movePending(list(), dragFrom, dragTo);
        report();
      }
      slot.lift.value = 0;
      animate(slot.node, "scale", 1, { dur: 120, easing: "out" });
      layout(true);
      dragFrom = -1;
    },
    onCancel: () => {
      const slot = dragSlot;
      dragSlot = null;
      if (slot?.node) {
        slot.lift.value = 0;
        animate(slot.node, "scale", 1, { dur: 120, easing: "out" });
      }
      dragFrom = -1;
      layout(true);
    },
  });

  // Tap: edit the pending row under the finger; a done row or the empty
  // space below creates at the end of the pending stack (the reference's
  // collection tap).
  createGesture({
    region: { rect: inTodoList },
    onTap: (c) => {
      const index = rowIndexAt(c.y);
      if (index >= 0 && !order[index].done) {
        openEditor(order[index], false);
        return;
      }
      createAt(pendingCount(list()));
    },
  });

  // Pinch two rows apart: insert between them.
  let pinchGap = -1;
  let pinchOpen = 0;
  function pinchRows(open: number): void {
    pinchOpen = open;
    for (let i = 0; i < order.length; i += 1) {
      const slot = slotByTodo.get(order[i].id);
      if (!slot?.node) continue;
      jump(slot.node, "translateY", i * ROW_H + (i >= pinchGap ? open : 0));
    }
    if (previewNode) {
      jump(previewNode, "translateY", pinchGap * ROW_H);
      jump(previewNode, "height", open);
      jump(previewNode, "opacity", Math.min(1, open / ROW_H));
    }
  }
  createGesture({
    axis: "y",
    region: { rect: inTodoList },
    onPinchStart: (p) => {
      pinchGap = Math.max(
        0,
        Math.min(pendingCount(list()), Math.round((p.cy + scroller.offset()) / ROW_H)),
      );
      pinchRows(0);
    },
    onPinchMove: (p) => {
      if (pinchGap < 0) return;
      pinchRows(Math.max(0, Math.min(ROW_H, p.dspan)));
    },
    onPinchEnd: () => {
      if (pinchGap < 0) return;
      const gap = pinchGap;
      const open = pinchOpen;
      pinchGap = -1;
      pinchOpen = 0;
      if (previewNode) {
        jump(previewNode, "height", 0);
        jump(previewNode, "opacity", 0);
      }
      if (open >= PINCH_COMMIT) {
        createAt(gap);
      } else {
        layout(true);
      }
    },
  });

  // Lists screen: kinetic scroll.
  createGesture({
    axis: "y",
    region: { rect: inLists },
    onPanStart: () => listsScroller.beginDrag(),
    onPanMove: (c) => listsScroller.drag(-c.fdy),
    onPanEnd: (c) => listsScroller.endDrag(-c.vy),
    onCancel: () => listsScroller.endDrag(0),
  });

  // Lists screen: tap a list to open it.
  createGesture({
    region: { rect: inLists },
    onTap: (c) => {
      const index = Math.floor((c.y + listsScroller.offset()) / ROW_H);
      if (index >= 0 && index < lists.length) openList(index);
    },
  });

  // While editing, a tap anywhere above the keyboard commits.
  createGesture({
    region: {
      rect: () =>
        screenName === "todos" && editing
          ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H - KB_H }
          : null,
    },
    onTap: () => closeEditor(true),
  });

  // The keyboard claims its panel outright (registered last = top priority).
  // Keys commit on the down edge; the key-cap popup lives until the lift.
  createGesture({
    region: { rect: () => kb.rect() },
    onDown: (c) => kb.pressAt(c.x, c.y, SCREEN_H),
    onUp: () => kb.release(),
    onCancel: () => kb.release(),
  });

  // ------------------------------------------------------------ frame pump
  /** The pull-down affordances: fold the flap through its first row height,
   *  then hold it flat, then swap to the switch hint while the lists canvas
   *  rides down into view. */
  function paintPull(pull: number): void {
    if (!flapNode) return;
    if (pull <= 0) {
      jump(flapNode, "opacity", 0);
      if (topSwitchNode) jump(topSwitchNode, "opacity", 0);
      if (!listsParked) parkListsForPulldown();
      return;
    }
    if (pull >= PULL_BACK) {
      jump(flapNode, "opacity", 0);
      if (topSwitchNode) jump(topSwitchNode, "opacity", 1);
      listsParked = false;
      if (listsCanvas) jump(listsCanvas, "translateY", pull - PULL_BACK - LISTS_H);
      return;
    }
    if (topSwitchNode) jump(topSwitchNode, "opacity", 0);
    if (!listsParked) parkListsForPulldown();
    const pct = Math.min(1, pull / PULL_CREATE);
    // NEGATIVE rotateX folds the top edge AWAY from the viewer (the engine's
    // positive angle tips it toward the camera and the taper clips away).
    jump(flapNode, "rotateX", (pct - 1) * 90);
    jump(flapNode, "opacity", pct / 2 + 0.5);
    flapText.value = pull >= PULL_CREATE ? "Release to Create Item" : "Pull to Create Item";
  }

  onFrame(() => {
    if (screenName === "todos") {
      scroller.step();
      const off = scroller.offset();
      if (off !== paintedOffset && todosCanvas && !editing) {
        paintedOffset = off;
        jump(todosCanvas, "translateY", -off);
      }
      const pull = -off;
      if (pull !== paintedPull) {
        paintedPull = pull;
        paintPull(pull);
      }
    } else if (screenName === "lists") {
      listsScroller.step();
      const loff = listsScroller.offset();
      if (loff !== paintedListsOffset && listsCanvas) {
        paintedListsOffset = loff;
        jump(listsCanvas, "translateY", -loff);
      }
    }
  });

  onMounted(() => {
    for (const slot of slots) {
      if (slot.node) jump(slot.node, "translateY", PARKED_Y);
    }
    if (previewNode) {
      jump(previewNode, "height", 0);
      jump(previewNode, "opacity", 0);
    }
    if (footerNode) jump(footerNode, "translateY", VIEW_H);
  });

  // -------------------------------------------------------------- render
  function renderRow(slot: RowSlot) {
    return (
      <View
        nodeRef={(node) => {
          slot.node = node ?? null;
        }}
        class="absolute left-0 right-0 top-0 h-[62]"
        style={{ zIndex: slot.lift.value, shadow: slot.lift.value ? 3 : 0 }}
      >
        <View
          nodeRef={(node) => {
            slot.check = node ?? null;
          }}
          class="absolute left-0 top-0"
          style={{ width: ROW_H, height: ROW_H, opacity: 0 }}
        >
          <View class="absolute bg-[#ffffff]" style={{ insetL: 12, insetT: 32, width: 14, height: 7, rotate: 45 }} />
          <View class="absolute bg-[#ffffff]" style={{ insetL: 20, insetT: 27, width: 28, height: 7, rotate: -45 }} />
        </View>
        <View
          nodeRef={(node) => {
            slot.cross = node ?? null;
          }}
          class="absolute right-0 top-0"
          style={{ width: ROW_H, height: ROW_H, opacity: 0 }}
        >
          <View class="absolute bg-[#eb0017]" style={{ insetL: 15, insetT: 28, width: 32, height: 7, rotate: 45 }} />
          <View class="absolute bg-[#eb0017]" style={{ insetL: 15, insetT: 28, width: 32, height: 7, rotate: -45 }} />
        </View>
        <View
          nodeRef={(node) => {
            slot.front = node ?? null;
          }}
          class="absolute inset-0 bg-gradient-to-b from-[#f50018] to-[#e00016]"
        >
          <View class="absolute left-0 right-0 top-0 bg-[#ffffff12]" style={{ height: 1 }} />
          <View class="absolute left-0 right-0 bottom-0 bg-[#0000001a]" style={{ height: 1 }} />
          <View class="absolute inset-0 flex-row items-center pl-3">
            <Text class={slot.done.value ? "text-xl font-bold text-[#666666]" : "text-xl font-bold text-white"}>
              {slot.text.value}
            </Text>
          </View>
          <View
            nodeRef={(node) => {
              slot.strike = node ?? null;
            }}
            class="absolute bg-[#ffffff]"
            style={{ insetL: 12, insetT: 30, height: 2, width: 0, originX: -0.5, scaleX: 0 }}
          />
        </View>
      </View>
    );
  }

  function renderListRow(title: string, i: number) {
    const [from, to] = listRowColors(i, lists.length);
    return (
      <View
        nodeRef={(node) => {
          listRowNodes[i] = node ?? null;
        }}
        class="absolute left-0 right-0 top-0 h-[62]"
        style={{ translateY: i * ROW_H }}
      >
        <View
          class="absolute inset-0 bg-gradient-to-b from-[#1780f7] to-[#1780f7]"
          style={{ gradFrom: from, gradTo: to }}
        >
          <View class="absolute left-0 right-0 top-0 bg-[#ffffff12]" style={{ height: 1 }} />
          <View class="absolute left-0 right-0 bottom-0 bg-[#0000001a]" style={{ height: 1 }} />
          <View class="absolute inset-0 flex-row items-center pl-3">
            <Text class={listEmpty[i].value ? "text-xl font-bold text-[#ffffff80]" : "text-xl font-bold text-white"}>
              {title}
            </Text>
          </View>
          <View class="absolute right-0 top-0 bottom-0 items-center justify-center bg-[#ffffff26]" style={{ width: ROW_H }}>
            <Text class={listEmpty[i].value ? "text-xl font-bold text-[#ffffff80]" : "text-xl font-bold text-white"}>
              {listCounts[i].value}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View class="w-full h-full bg-[#000000] overflow-hidden">
      <View
        nodeRef={(node) => {
          todosCanvas = node ?? null;
        }}
        class="absolute left-0 right-0 top-0"
        style={{ height: VIEW_H, translateY: TODOS_PARKED_Y }}
      >
        <View
          nodeRef={(node) => {
            topSwitchNode = node ?? null;
          }}
          class="absolute left-0 right-0 items-center justify-center"
          style={{ translateY: -2 * ROW_H, height: ROW_H, opacity: 0 }}
        >
          <Text class="text-xl font-bold text-white">Switch to Lists</Text>
        </View>
        <View
          class="absolute left-0 right-0"
          style={{ translateY: -ROW_H, height: ROW_H, perspective: 400 }}
        >
          <View
            nodeRef={(node) => {
              flapNode = node ?? null;
            }}
            class="absolute inset-0 flex-row items-center pl-3 bg-gradient-to-b from-[#f50018] to-[#e00016]"
            style={{ originY: 0.5, rotateX: -90, opacity: 0 }}
          >
            <Text class="text-xl font-bold text-white">{flapText.value}</Text>
          </View>
        </View>
        <View
          nodeRef={(node) => {
            previewNode = node ?? null;
          }}
          class="absolute left-0 right-0 top-0 bg-gradient-to-b from-[#f50018] to-[#e00016]"
        />
        <View
          nodeRef={(node) => {
            footerNode = node ?? null;
          }}
          class="absolute left-0 right-0 items-center justify-center"
          style={{ height: 2 * ROW_H }}
        >
          <Text class={hasDone.value ? "text-xl font-bold text-white" : "text-xl font-bold text-[#333333]"}>
            Pull to Clear
          </Text>
        </View>
        {slots.map((slot) => renderRow(slot))}
      </View>

      <View
        nodeRef={(node) => {
          listsCanvas = node ?? null;
        }}
        class="absolute left-0 right-0 top-0"
        style={{ height: LISTS_H, zIndex: 1 }}
      >
        <View
          class="absolute left-0 right-0 flex-col items-center justify-center"
          style={{ translateY: -2.5 * ROW_H, height: ROW_H }}
        >
          <Text class="text-sm text-[#ffffff40] text-center">Made with PocketJS + Vue Vapor</Text>
          <Text class="text-sm text-[#ffffff40] text-center">Original by Evan You, iOS app by Realmac</Text>
        </View>
        {lists.map((l, i) => renderListRow(l.title, i))}
      </View>

      {kb.view}
    </View>
  );
};
