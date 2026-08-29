// Pocket Clear — the classic gesture-driven todo list, rebuilt on the
// PocketJS gesture layer in Vue Vapor JSX. Every interaction is a gesture:
// swipe right to complete, swipe left to delete, tap to edit, long-press to
// reorder, pull down to create (further to go back), pull up past the end to
// clear the done pile, pinch two rows apart to insert between them.
//
// Rendering strategy: a fixed pool of row nodes mounted once. Data lives in
// plain arrays (model.ts); after every mutation layout() re-assigns todos to
// slots. Text and the done/lift looks ride per-slot refs; ALL motion
// (translate/opacity/gradient colors/height) goes through jump()/animate()
// on captured NodeMirrors — never through :style objects, whose reactive
// re-application would clobber in-flight tweens.

import { onMounted, shallowRef } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { reportAppAction } from "@pocketjs/framework/host";
import { after } from "@pocketjs/framework/clock";
import {
  clearDone,
  insertTodo,
  MAX_TODOS,
  movePending,
  ordered,
  pendingCount,
  removeTodo,
  seedLists,
  setDone,
  type Todo,
} from "./model.ts";
import {
  DONE_FROM,
  DONE_TO,
  pendingRowColors,
} from "./palette.ts";
import { KB_H, makeKeyboard } from "./keyboard.tsx";

const SCREEN_W = 320;
const SCREEN_H = 480;
const HEADER_H = 48;
const ROW_H = 44;
const VIEW_H = SCREEN_H - HEADER_H;
const LISTS_TOP = HEADER_H + 1;
const LIST_ROW_STRIDE = 57; // 56 px row + 1 px seam

/** Off-canvas parking spot for unassigned row slots. */
const PARKED_Y = 4000;

/** Swipe travel that commits a complete/delete. */
const SWIPE_COMMIT = 110;
/** Rubber-band DISPLAY thresholds for the pull gestures (px of overscroll). */
const PULL_CREATE = 44;
const PULL_BACK = 78;
const PULL_CLEAR = 36;
const OVERSCROLL = 90;
/** Pinch gap that commits an insert. */
const PINCH_COMMIT = 30;

interface RowSlot {
  node: NodeMirror | null;
  front: NodeMirror | null;
  hint: NodeMirror | null;
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
}

export default () => {
  const lists = seedLists();
  let activeIndex = 0;
  let screenName: "lists" | "todos" = "lists";
  let order: Todo[] = [];
  let contentH = 0;
  let actions = 0;

  const list = () => lists[activeIndex];

  let listsNode: NodeMirror | null = null;
  let todosNode: NodeMirror | null = null;
  let viewportNode: NodeMirror | null = null;
  let canvasNode: NodeMirror | null = null;
  let previewNode: NodeMirror | null = null;
  let footerNode: NodeMirror | null = null;

  const titleText = shallowRef("");
  const countText = shallowRef("");
  const flapText = shallowRef("Pull down to add");
  const listCounts = lists.map((l) => shallowRef(`${pendingCount(l)} to do`));

  const slots: RowSlot[] = Array.from({ length: MAX_TODOS }, () => ({
    node: null,
    front: null,
    hint: null,
    text: shallowRef(""),
    done: shallowRef(false),
    lift: shallowRef(0),
    todoId: -1,
    y: PARKED_Y,
    busy: false,
    gradFrom: "",
    gradTo: "",
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
  let paintedOffset = 0;

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
        if (slot.front) {
          jump(slot.front, "translateX", 0);
          jump(slot.front, "opacity", 1);
        }
        slotByTodo.set(todo.id, slot);
        return slot;
      }
    }
    throw new Error("clear: row pool exhausted");
  }

  function slotLabel(todo: Todo): string {
    return todo.done ? `✓ ${todo.text}` : todo.text;
  }

  /** Re-derive every slot from the model. Structural motion (row y, colors)
   *  animates when `animated`; text and looks snap. */
  function layout(animated: boolean): void {
    const current = list();
    order = ordered(current);
    contentH = order.length * ROW_H;
    const pending = pendingCount(current);
    countText.value = `${pending} to do`;
    if (canvasNode) jump(canvasNode, "height", Math.max(contentH, VIEW_H));
    // The clear-done hint hides below the fold until an overscroll reveals it.
    if (footerNode) jump(footerNode, "translateY", Math.max(contentH, VIEW_H));

    const seen = new Set<RowSlot>();
    for (let index = 0; index < order.length; index += 1) {
      const todo = order[index];
      const slot = slotByTodo.get(todo.id) ?? allocSlot(todo);
      seen.add(slot);
      slot.done.value = todo.done;
      if (editing !== todo) slot.text.value = slotLabel(todo);

      const y = index * ROW_H;
      if (slot.node) {
        if (animated && slot.y !== y && slot.y !== PARKED_Y) {
          animate(slot.node, "translateY", y, { dur: 220, easing: "out" });
        } else {
          jump(slot.node, "translateY", y);
        }
      }
      slot.y = y;

      const [from, to] = todo.done ? [DONE_FROM, DONE_TO] : pendingRowColors(index);
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
    if (slot.node) jump(slot.node, "translateY", PARKED_Y);
    if (slot.front) {
      jump(slot.front, "translateX", 0);
      jump(slot.front, "opacity", 1);
    }
  }

  /** Display index under a screen y, or -1 outside the rows. */
  function rowIndexAt(screenY: number): number {
    const index = Math.floor((screenY - HEADER_H + scroller.offset()) / ROW_H);
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

  function openEditor(todo: Todo, wasNew: boolean): void {
    editing = todo;
    editWasNew = wasNew;
    editOriginal = todo.text;
    editCaret = todo.text.length;
    kb.setOpen(true);
    paintEditRow();
    const index = order.indexOf(todo);
    const rowBottom = HEADER_H + index * ROW_H - scroller.offset() + ROW_H;
    const liftNeeded = Math.max(0, rowBottom - (SCREEN_H - KB_H));
    if (viewportNode) animate(viewportNode, "translateY", -liftNeeded, { dur: 200, easing: "out" });
  }

  function closeEditor(commit: boolean): void {
    const todo = editing;
    if (!todo) return;
    editing = null;
    kb.setOpen(false);
    if (viewportNode) animate(viewportNode, "translateY", 0, { dur: 200, easing: "out" });
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
    onHide: () => closeEditor(false),
    onCaret(delta) {
      if (!editing) return;
      editCaret = Math.max(0, Math.min(editing.text.length, editCaret + delta));
      paintEditRow();
    },
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
  function openList(index: number): void {
    activeIndex = index;
    titleText.value = list().title;
    screenName = "todos";
    scroller.scrollTo(0, { immediate: true });
    layout(false);
    if (listsNode) animate(listsNode, "translateX", -96, { dur: 240, easing: "out" });
    if (todosNode) animate(todosNode, "translateX", 0, { dur: 240, easing: "out" });
    report();
  }

  function goBack(): void {
    if (editing) closeEditor(false);
    screenName = "lists";
    for (let i = 0; i < lists.length; i += 1) {
      listCounts[i].value = `${pendingCount(lists[i])} to do`;
    }
    if (listsNode) animate(listsNode, "translateX", 0, { dur: 240, easing: "out" });
    if (todosNode) animate(todosNode, "translateX", SCREEN_W + 20, { dur: 240, easing: "out" });
    report();
  }

  // ------------------------------------------------------------- gestures
  const inTodoList = () =>
    screenName === "todos" && !editing
      ? { x: 0, y: HEADER_H, w: SCREEN_W, h: VIEW_H }
      : null;

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
        scroller.endDrag(0);
        goBack();
        return;
      }
      if (overTop >= PULL_CREATE) {
        scroller.endDrag(0);
        createAt(0);
        return;
      }
      if (overBottom >= PULL_CLEAR && order.some((todo) => todo.done)) {
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
  createGesture({
    axis: "x",
    region: { rect: inTodoList },
    onPanStart: (c) => {
      const index = rowIndexAt(c.startY);
      swipeTodo = index >= 0 ? order[index] : null;
      swipeSlot = swipeTodo ? (slotByTodo.get(swipeTodo.id) ?? null) : null;
    },
    onPanMove: (c) => {
      if (!swipeSlot?.front || !swipeSlot.hint) return;
      const dx = Math.max(-SCREEN_W, Math.min(SCREEN_W, c.dx));
      jump(swipeSlot.front, "translateX", dx);
      const armed = dx >= SWIPE_COMMIT || dx <= -SWIPE_COMMIT;
      jump(
        swipeSlot.hint,
        "bgColor",
        dx > 0 ? (armed ? "#2f9e44" : "#25432c") : armed ? "#d13438" : "#452a2e",
      );
    },
    onPanEnd: (c) => {
      const slot = swipeSlot;
      const todo = swipeTodo;
      swipeSlot = null;
      swipeTodo = null;
      if (!slot?.front || !todo) return;
      if (c.dx >= SWIPE_COMMIT) {
        animate(slot.front, "translateX", 0, { dur: 180, easing: "out" });
        setDone(list(), todo, !todo.done);
        layout(true);
        report();
        return;
      }
      if (c.dx <= -SWIPE_COMMIT) {
        slot.busy = true;
        parkAfterExit(slot);
        animate(slot.front, "translateX", -SCREEN_W - 40, { dur: 180, easing: "out" });
        animate(slot.front, "opacity", 0, { dur: 180, easing: "out" });
        removeTodo(list(), todo);
        slotByTodo.delete(todo.id);
        slot.todoId = -1;
        layout(true);
        report();
        return;
      }
      animate(slot.front, "translateX", 0, { dur: 160, easing: "out" });
    },
    onCancel: () => {
      if (swipeSlot?.front) animate(swipeSlot.front, "translateX", 0, { dur: 160, easing: "out" });
      swipeSlot = null;
      swipeTodo = null;
    },
  });

  function parkAfterExit(slot: RowSlot): void {
    after(0.22, () => {
      slot.busy = false;
      slot.y = PARKED_Y;
      slot.text.value = "";
      if (slot.node) jump(slot.node, "translateY", PARKED_Y);
      if (slot.front) {
        jump(slot.front, "translateX", 0);
        jump(slot.front, "opacity", 1);
      }
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
        animate(dragSlot.node, "scale", 1.04, { dur: 120, easing: "out" });
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

  // Tap: edit the row under the finger, or create at the end below the rows.
  createGesture({
    region: { rect: inTodoList },
    onTap: (c) => {
      const index = rowIndexAt(c.y);
      if (index >= 0) {
        openEditor(order[index], false);
        return;
      }
      if (c.y - HEADER_H + scroller.offset() >= contentH) createAt(pendingCount(list()));
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
        Math.min(pendingCount(list()), Math.round((p.cy - HEADER_H + scroller.offset()) / ROW_H)),
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

  // Lists screen: tap a list to open it.
  createGesture({
    region: {
      rect: () =>
        screenName === "lists"
          ? { x: 0, y: LISTS_TOP, w: SCREEN_W, h: lists.length * LIST_ROW_STRIDE }
          : null,
    },
    onTap: (c) => {
      const index = Math.floor((c.y - LISTS_TOP) / LIST_ROW_STRIDE);
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
  createGesture({
    region: { rect: () => kb.rect() },
    onDown: (c) => kb.pressAt(c.x, c.y, SCREEN_H),
  });

  // ------------------------------------------------------------ frame pump
  onFrame(() => {
    scroller.step();
    const off = scroller.offset();
    if (off !== paintedOffset && canvasNode) {
      paintedOffset = off;
      jump(canvasNode, "translateY", -off);
    }
    const pull = -off;
    flapText.value =
      pull >= PULL_BACK
        ? "Release to go back"
        : pull >= PULL_CREATE
          ? "Release to add"
          : "Pull down to add";
  });

  onMounted(() => {
    for (const slot of slots) {
      if (slot.node) jump(slot.node, "translateY", PARKED_Y);
    }
    if (previewNode) {
      jump(previewNode, "height", 0);
      jump(previewNode, "opacity", 0);
    }
    if (footerNode) jump(footerNode, "translateY", 0);
  });

  // -------------------------------------------------------------- render
  function renderRow(slot: RowSlot) {
    return (
      <View
        nodeRef={(node) => {
          slot.node = node ?? null;
        }}
        class="absolute left-0 right-0 top-0 h-11 overflow-hidden"
        style={{ zIndex: slot.lift.value }}
      >
        <View
          nodeRef={(node) => {
            slot.hint = node ?? null;
          }}
          class="absolute inset-0 flex-row items-center justify-between px-5 bg-[#20242c]"
        >
          <Text class="text-base text-white font-bold">✓</Text>
          <Text class="text-base text-white font-bold">✕</Text>
        </View>
        <View
          nodeRef={(node) => {
            slot.front = node ?? null;
          }}
          class="absolute inset-0 flex-row items-center px-4 bg-gradient-to-b from-[#d32b3a] to-[#d5432f]"
        >
          <Text class={slot.done.value ? "text-base text-[#5b6472]" : "text-base text-white"}>
            {slot.text.value}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View class="w-full h-full bg-[#0b0e13]">
      <View
        nodeRef={(node) => {
          listsNode = node ?? null;
        }}
        class="absolute inset-0 flex-col bg-[#0b0e13]"
      >
        <View class="h-12 justify-center items-center bg-[#11151d]">
          <Text class="text-lg text-white font-bold">Pocket Clear</Text>
        </View>
        {lists.map((l, i) => (
          <View class="h-14 flex-row items-center justify-between px-4 bg-gradient-to-b from-[#2c3547] to-[#222a39]" style={{ marginT: 1 }}>
            <Text class="text-base text-white">{l.title}</Text>
            <Text class="text-sm text-[#8b96a8]">{listCounts[i].value}</Text>
          </View>
        ))}
        <Text class="text-xs text-[#5b6472] text-center" style={{ marginT: 16 }}>
          Tap a list to open it
        </Text>
      </View>

      <View
        nodeRef={(node) => {
          todosNode = node ?? null;
        }}
        class="absolute inset-0 flex-col bg-[#0b0e13]"
        style={{ translateX: SCREEN_W + 20 }}
      >
        <View class="h-12 flex-row items-center justify-between px-4 bg-[#11151d]">
          <Text class="text-lg text-white font-bold">{titleText.value}</Text>
          <Text class="text-xs text-[#8b96a8]">{countText.value}</Text>
        </View>
        <View
          nodeRef={(node) => {
            viewportNode = node ?? null;
          }}
          class="flex-1 overflow-hidden"
        >
          <View
            nodeRef={(node) => {
              canvasNode = node ?? null;
            }}
            class="absolute left-0 right-0 top-0"
            style={{ height: VIEW_H }}
          >
            <View
              class="absolute left-0 right-0 h-11 flex-row items-center justify-center bg-gradient-to-b from-[#b8202f] to-[#d32b3a]"
              style={{ translateY: -ROW_H }}
            >
              <Text class="text-sm text-white">{flapText.value}</Text>
            </View>
            <View
              nodeRef={(node) => {
                previewNode = node ?? null;
              }}
              class="absolute left-0 right-0 top-0 bg-gradient-to-b from-[#d32b3a] to-[#d94b32]"
            />
            <View
              nodeRef={(node) => {
                footerNode = node ?? null;
              }}
              class="absolute left-0 right-0 h-10 justify-center items-center"
            >
              <Text class="text-xs text-[#5b6472]">Pull up to clear the done pile</Text>
            </View>
            {slots.map((slot) => renderRow(slot))}
          </View>
        </View>
      </View>

      {kb.view}
    </View>
  );
};
