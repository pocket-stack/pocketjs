// Input: button edge-detection + the focus manager.
//
// Focus model (v1, no layout access from JS [R]):
//   - Default traversal order = DOCUMENT ORDER over the mirror tree, derived
//     lazily (a DFS per navigation press — cheap for UI-sized trees, always
//     correct after <For> reorders).
//   - FocusGrid can override traversal inside a subtree with row/column d-pad
//     semantics; outside a grid, DOWN/RIGHT → next and UP/LEFT → previous.
//   - CIRCLE fires onPress of the focused node, bubbling up to the nearest
//     ancestor with a handler.
//   - Focus loss on removal [R]: next sibling subtree → previous sibling
//     subtree → nearest focusable ancestor → none. Computed BEFORE the mirror
//     unlink (renderer calls notifyDetached first).
//   - Every focus change calls ops.setFocus so the native core applies the
//     `focus:` style variant with zero further JS.

import { BTN } from "../spec/spec.ts";
import { getOps } from "./host.ts";
import type { NodeMirror } from "./native-tree.ts";

let root: NodeMirror | null = null;
let focused: NodeMirror | null = null;
let prevButtons = 0;
const focusScopeStack: NodeMirror[] = [];
const focusGridStack: FocusGridRegistration[] = [];

/** Bind the focus manager to a mirror tree root (index.ts render()). */
export function setInputRoot(r: NodeMirror | null): void {
  root = r;
  focused = null;
  prevButtons = 0;
  focusScopeStack.length = 0;
  focusGridStack.length = 0;
}

/** Tests: forget focus + edge state. */
export function resetInput(): void {
  setInputRoot(null);
}

// ---- registries (renderer setProperty dispatch targets) --------------------

export function registerPress(
  node: NodeMirror,
  fn: (() => void) | undefined | null,
): void {
  node.onPress = fn ?? undefined;
}

export function registerFocusable(node: NodeMirror, on: boolean): void {
  node.focusable = on;
  if (!on && focused === node) {
    focusNode(null);
  }
}

// ---- focus ------------------------------------------------------------------

/** Programmatic focus (also used internally). null clears. */
export function focusNode(node: NodeMirror | null): void {
  focused = node;
  getOps().setFocus(node ? node.id : 0);
}

export function getFocused(): NodeMirror | null {
  return focused;
}

function activeFocusRoot(): NodeMirror | null {
  return focusScopeStack.length > 0 ? focusScopeStack[focusScopeStack.length - 1] : root;
}

function collectFocusables(node: NodeMirror, out: NodeMirror[]): void {
  if (node.focusable) out.push(node);
  for (let i = 0; i < node.children.length; i++) {
    collectFocusables(node.children[i], out);
  }
}

function focusables(): NodeMirror[] {
  const out: NodeMirror[] = [];
  const r = activeFocusRoot();
  if (r) collectFocusables(r, out);
  return out;
}

type FocusDirection = "up" | "down" | "left" | "right";

function linearDirection(direction: FocusDirection): 1 | -1 {
  return direction === "down" || direction === "right" ? 1 : -1;
}

function moveLinearFocus(direction: FocusDirection): void {
  const dir = linearDirection(direction);
  const list = focusables();
  if (list.length === 0) {
    if (focused) focusNode(null);
    return;
  }
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    // Nothing (validly) focused: enter the order from the direction's end.
    focusNode(dir === 1 ? list[0] : list[list.length - 1]);
    return;
  }
  const j = i + dir;
  if (j < 0 || j >= list.length) return; // clamp at the ends
  focusNode(list[j]);
}

export interface FocusGridOptions {
  columns: number;
  wrap?: boolean;
}

interface FocusGridRegistration {
  node: NodeMirror;
  columns: number;
  wrap: boolean;
}

function activeGrid(): FocusGridRegistration | null {
  if (!focused) return null;
  const active = activeFocusRoot();
  if (active && !isWithin(focused, active)) return null;
  for (let i = focusGridStack.length - 1; i >= 0; i--) {
    const grid = focusGridStack[i];
    if (active && !isWithin(grid.node, active) && !isWithin(active, grid.node)) continue;
    if (isWithin(focused, grid.node)) return grid;
  }
  return null;
}

function moveGridFocus(direction: FocusDirection): boolean {
  const grid = activeGrid();
  if (!grid) return false;

  const list: NodeMirror[] = [];
  collectFocusables(grid.node, list);
  if (list.length === 0) {
    if (focused) focusNode(null);
    return true;
  }

  const columns = grid.columns;
  const i = focused ? list.indexOf(focused) : -1;
  if (i < 0) {
    focusNode(linearDirection(direction) === 1 ? list[0] : list[list.length - 1]);
    return true;
  }

  let j = i;
  switch (direction) {
    case "right":
      if (i + 1 < list.length && i % columns < columns - 1) j = i + 1;
      else if (grid.wrap) j = Math.floor(i / columns) * columns;
      break;
    case "left":
      if (i % columns > 0) j = i - 1;
      else if (grid.wrap) j = Math.min(list.length - 1, Math.floor(i / columns) * columns + columns - 1);
      break;
    case "down":
      if (i + columns < list.length) j = i + columns;
      else if (grid.wrap) j = i % columns;
      break;
    case "up":
      if (i - columns >= 0) j = i - columns;
      else if (grid.wrap) {
        const col = i % columns;
        j = col;
        while (j + columns < list.length) j += columns;
      }
      break;
  }

  if (j !== i) focusNode(list[j]);
  return true;
}

function moveFocus(direction: FocusDirection): void {
  if (moveGridFocus(direction)) return;
  moveLinearFocus(direction);
}

function firePress(): void {
  let n: NodeMirror | null = focused;
  while (n) {
    if (n.onPress) {
      n.onPress();
      return;
    }
    n = n.parent;
  }
}

// ---- removal repair [R] ------------------------------------------------------

function isWithin(node: NodeMirror, ancestor: NodeMirror): boolean {
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

export interface FocusScopeOptions {
  autoFocus?: boolean;
  restoreFocus?: boolean;
}

function firstFocusable(node: NodeMirror): NodeMirror | null {
  if (node.focusable) return node;
  for (let i = 0; i < node.children.length; i++) {
    const f = firstFocusable(node.children[i]);
    if (f) return f;
  }
  return null;
}

/** Temporarily restrict d-pad traversal and CIRCLE press to a subtree. */
export function pushFocusScope(node: NodeMirror, opts: FocusScopeOptions = {}): () => void {
  const previous = focused;
  focusScopeStack.push(node);
  if (opts.autoFocus !== false && (!focused || !isWithin(focused, node))) {
    focusNode(firstFocusable(node));
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusScopeStack.lastIndexOf(node);
    if (i >= 0) focusScopeStack.splice(i, 1);

    const active = activeFocusRoot();
    if (opts.restoreFocus !== false && previous && (!active || isWithin(previous, active))) {
      focusNode(previous);
      return;
    }
    if (active && (!focused || !isWithin(focused, active))) {
      focusNode(firstFocusable(active));
    } else if (!active && focused) {
      focusNode(null);
    }
  };
}

/** Temporarily give a subtree row/column d-pad traversal semantics. */
export function pushFocusGrid(node: NodeMirror, opts: FocusGridOptions): () => void {
  const registration: FocusGridRegistration = {
    node,
    columns: Math.max(1, Math.floor(opts.columns)),
    wrap: opts.wrap ?? false,
  };
  focusGridStack.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const i = focusGridStack.lastIndexOf(registration);
    if (i >= 0) focusGridStack.splice(i, 1);
  };
}

/**
 * Called by the renderer's removeNode BEFORE the mirror unlink. If the focused
 * node is inside the removed subtree, refocus: next sibling subtree → previous
 * sibling subtree → nearest focusable ancestor → none.
 */
export function notifyDetached(node: NodeMirror): void {
  if (!focused || !isWithin(focused, node)) return;
  const parent = node.parent;
  if (parent) {
    const idx = parent.children.indexOf(node);
    for (let i = idx + 1; i < parent.children.length; i++) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    for (let i = idx - 1; i >= 0; i--) {
      const f = firstFocusable(parent.children[i]);
      if (f) {
        focusNode(f);
        return;
      }
    }
    let a: NodeMirror | null = parent;
    while (a) {
      if (a.focusable) {
        focusNode(a);
        return;
      }
      a = a.parent;
    }
  }
  focusNode(null);
}

// ---- per-frame entry ----------------------------------------------------------

/**
 * Edge-detect the button bitmask (spec BTN) and run navigation/press. Called
 * once per frame from globalThis.frame (index.ts) before the renderer sweep.
 */
export function handleFrame(buttons: number): void {
  const pressed = buttons & ~prevButtons;
  prevButtons = buttons;
  if (pressed === 0) return;
  if (pressed & BTN.DOWN) moveFocus("down");
  if (pressed & BTN.RIGHT) moveFocus("right");
  if (pressed & BTN.UP) moveFocus("up");
  if (pressed & BTN.LEFT) moveFocus("left");
  if (pressed & BTN.CIRCLE) firePress();
}
