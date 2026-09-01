// apps/pocket-shell/wm.ts — the window manager as pure state and geometry.
//
// No Solid, no framework imports: every rule about where a window goes lives
// here and is unit-tested directly (tests/pocket-shell-wm.test.ts). The store
// (store.ts) owns signals, animation and input; this module owns the tree.
//
// Two layouts, per workspace, the way Omarchy configures Hyprland:
//
//   dwindle    A binary split tree. A new window splits the focused leaf along
//              its longer side and takes the right/bottom half (Hyprland's
//              `force_split = 2`); a split keeps its orientation when a child
//              closes (`preserve_split = true`).
//   scrolling  Columns on a horizontal strip that is wider than the screen.
//              A new window opens as a column after the focused one, at 0.49
//              of the workspace width so two columns fit; the strip scrolls
//              so the focused column is always fully visible.
//
// Geometry is in top-screen pixels (400x240). The bar takes BAR_H from the
// top, GAP_OUT frames the workspace, and every tiled window is inset GAP_IN
// so neighbours sit 2*GAP_IN apart — Omarchy's gaps_out/gaps_in, scaled to a
// 3.5" panel.

export const STAGE_W = 400;
export const STAGE_H = 240;
export const BAR_H = 14;
export const GAP_OUT = 4;
export const GAP_IN = 3;
export const BORDER = 2;
export const WORKSPACES = 5;
export const DEFAULT_COLUMN_WIDTH = 0.49;
export const COLUMN_WIDTHS: readonly number[] = [0.33, 0.49, 0.66, 1];
const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;
const MIN_COLUMN = 0.2;
const REOPEN_DEPTH = 8;

export type Dir = "left" | "right" | "up" | "down";
export type Axis = "x" | "y";
export type LayoutKind = "dwindle" | "scrolling";
export type FullscreenMode = "full" | "max";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Leaf {
  kind: "leaf";
  win: number;
  rect?: Rect;
}

export interface Split {
  kind: "split";
  axis: Axis;
  /** Share of the split's extent given to `a` (left or top). */
  ratio: number;
  a: Node;
  b: Node;
  rect?: Rect;
}

export type Node = Leaf | Split;

export interface Column {
  wins: number[];
  /** Fraction of the workspace width. */
  width: number;
}

export interface Workspace {
  id: number;
  layout: LayoutKind;
  root: Node | null;
  columns: Column[];
  /** Scrolling layout: strip pixels hidden to the left of the workspace. */
  scroll: number;
  focus: number | null;
  fullscreen: number | null;
  fullscreenMode: FullscreenMode;
}

export interface Win<TApp extends string = string> {
  id: number;
  app: TApp;
  title: string;
  ws: number;
}

export interface Placement {
  id: number;
  rect: Rect;
  /** Covered by a fullscreen window: laid out, not shown. */
  hidden: boolean;
}

/** A draggable split boundary under a touch point (dwindle). */
export interface SplitHandle {
  split: Split;
  axis: Axis;
}

/** A draggable column edge under a touch point (scrolling). */
export interface ColumnHandle {
  column: Column;
}

export interface Point {
  x: number;
  y: number;
}

export const inset = (r: Rect, by: number): Rect => ({
  x: r.x + by,
  y: r.y + by,
  w: Math.max(0, r.w - 2 * by),
  h: Math.max(0, r.h - 2 * by),
});

export const contains = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const lastOf = <T>(list: readonly T[]): T | undefined => list[list.length - 1];

export function leaves(node: Node | null, out: Leaf[] = []): Leaf[] {
  if (!node) return out;
  if (node.kind === "leaf") out.push(node);
  else {
    leaves(node.a, out);
    leaves(node.b, out);
  }
  return out;
}

function findLeaf(node: Node | null, win: number): Leaf | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.win === win ? node : null;
  return findLeaf(node.a, win) ?? findLeaf(node.b, win);
}

/** Root-first chain of splits above `target` (empty when target is the root). */
function pathTo(node: Node | null, target: Node, chain: Split[] = []): Split[] | null {
  if (!node) return null;
  if (node === target) return chain;
  if (node.kind === "leaf") return null;
  chain.push(node);
  const found = pathTo(node.a, target, chain) ?? pathTo(node.b, target, chain);
  if (found) return found;
  chain.pop();
  return null;
}

function isUnder(node: Node, target: Node): boolean {
  if (node === target) return true;
  if (node.kind === "leaf") return false;
  return isUnder(node.a, target) || isUnder(node.b, target);
}

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

export class WindowManager<TApp extends string = string> {
  readonly workspaces: Workspace[] = [];
  readonly windows = new Map<number, Win<TApp>>();
  active = 1;
  barVisible = true;
  private nextId = 1;
  private readonly closedApps: TApp[] = [];

  constructor() {
    for (let id = 1; id <= WORKSPACES; id++) {
      this.workspaces.push({
        id,
        layout: "dwindle",
        root: null,
        columns: [],
        scroll: 0,
        focus: null,
        fullscreen: null,
        fullscreenMode: "full",
      });
    }
  }

  // ---- queries ---------------------------------------------------------------

  workspace(id: number = this.active): Workspace {
    return this.workspaces[clamp(id, 1, WORKSPACES) - 1];
  }

  /** The tiled area: the stage below the bar, framed by GAP_OUT. */
  area(): Rect {
    const top = this.barVisible ? BAR_H : 0;
    return { x: GAP_OUT, y: top + GAP_OUT, w: STAGE_W - 2 * GAP_OUT, h: STAGE_H - top - 2 * GAP_OUT };
  }

  focused(ws: Workspace = this.workspace()): Win<TApp> | null {
    return ws.focus === null ? null : this.windows.get(ws.focus) ?? null;
  }

  /** Window ids of a workspace in layout order. */
  order(ws: Workspace = this.workspace()): number[] {
    return ws.layout === "dwindle"
      ? leaves(ws.root).map((leaf) => leaf.win)
      : ws.columns.flatMap((column) => column.wins);
  }

  count(ws: Workspace = this.workspace()): number {
    return this.order(ws).length;
  }

  /** Where every window of the workspace sits this instant. */
  placements(ws: Workspace = this.workspace()): Placement[] {
    const out: Placement[] = [];
    const area = this.area();
    if (ws.layout === "dwindle") {
      if (ws.root) this.placeNode(ws.root, area, out);
    } else {
      this.placeColumns(ws, area, out);
    }
    if (ws.fullscreen !== null && this.windows.has(ws.fullscreen)) {
      const full: Rect = ws.fullscreenMode === "full" ? { x: 0, y: 0, w: STAGE_W, h: STAGE_H } : area;
      for (const placement of out) {
        if (placement.id === ws.fullscreen) placement.rect = full;
        else placement.hidden = true;
      }
    }
    return out;
  }

  placement(id: number): Placement | null {
    const win = this.windows.get(id);
    if (!win) return null;
    return this.placements(this.workspace(win.ws)).find((p) => p.id === id) ?? null;
  }

  windowAt(point: Point, ws: Workspace = this.workspace()): number | null {
    for (const placement of this.placements(ws)) {
      if (!placement.hidden && contains(placement.rect, point)) return placement.id;
    }
    return null;
  }

  // ---- windows ---------------------------------------------------------------

  open(app: TApp, wsId: number = this.active): number {
    const ws = this.workspace(wsId);
    const id = this.nextId++;
    const siblings = [...this.windows.values()].filter((w) => w.app === app).length;
    const title = siblings === 0 ? app : `${app} ${siblings + 1}`;
    this.windows.set(id, { id, app, title, ws: ws.id });
    this.insert(ws, id);
    ws.fullscreen = null;
    ws.focus = id;
    if (ws.layout === "scrolling") this.fitScroll(ws);
    return id;
  }

  /** Close a window; returns false when there is nothing to close. */
  close(id: number | null = this.workspace().focus): boolean {
    if (id === null) return false;
    const win = this.windows.get(id);
    if (!win) return false;
    const ws = this.workspace(win.ws);
    const rect = this.placement(id)?.rect ?? this.area();
    this.detach(ws, id, rect);
    this.windows.delete(id);
    this.closedApps.push(win.app);
    if (this.closedApps.length > REOPEN_DEPTH) this.closedApps.shift();
    return true;
  }

  /** The app closed most recently, or null when nothing was closed. */
  reopen(): number | null {
    const app = this.closedApps.pop();
    return app === undefined ? null : this.open(app);
  }

  focusWin(id: number): void {
    const win = this.windows.get(id);
    if (!win) return;
    const ws = this.workspace(win.ws);
    this.active = ws.id;
    ws.focus = id;
    if (ws.fullscreen !== null && ws.fullscreen !== id) ws.fullscreen = null;
    if (ws.layout === "scrolling") this.fitScroll(ws);
  }

  /** Nearest window in a direction, or null. Works across offscreen columns. */
  neighbor(dir: Dir, ws: Workspace = this.workspace()): number | null {
    if (ws.focus === null) return this.order(ws)[0] ?? null;
    const placements = this.placements(ws);
    const current = placements.find((p) => p.id === ws.focus);
    if (!current) return null;
    const cur = current.rect;
    const cc = center(cur);
    let best: number | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const p of placements) {
      if (p.id === ws.focus) continue;
      const r = p.rect;
      let distance: number;
      let lateral: number;
      let across: number;
      switch (dir) {
        case "right":
          if (r.x < cur.x + cur.w - 1) continue;
          distance = r.x - (cur.x + cur.w);
          lateral = overlap(r.y, r.y + r.h, cur.y, cur.y + cur.h);
          across = Math.abs(center(r).y - cc.y);
          break;
        case "left":
          if (r.x + r.w > cur.x + 1) continue;
          distance = cur.x - (r.x + r.w);
          lateral = overlap(r.y, r.y + r.h, cur.y, cur.y + cur.h);
          across = Math.abs(center(r).y - cc.y);
          break;
        case "down":
          if (r.y < cur.y + cur.h - 1) continue;
          distance = r.y - (cur.y + cur.h);
          lateral = overlap(r.x, r.x + r.w, cur.x, cur.x + cur.w);
          across = Math.abs(center(r).x - cc.x);
          break;
        case "up":
          if (r.y + r.h > cur.y + 1) continue;
          distance = cur.y - (r.y + r.h);
          lateral = overlap(r.x, r.x + r.w, cur.x, cur.x + cur.w);
          across = Math.abs(center(r).x - cc.x);
          break;
      }
      const score = Math.max(0, distance) + (lateral > 0 ? 0 : 1000) + across * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = p.id;
      }
    }
    return best;
  }

  focusDir(dir: Dir): boolean {
    const target = this.neighbor(dir);
    if (target === null) return false;
    this.focusWin(target);
    return true;
  }

  /** Exchange the focused window with its neighbour in a direction. */
  swapDir(dir: Dir): boolean {
    const ws = this.workspace();
    if (ws.focus === null) return false;
    const target = this.neighbor(dir, ws);
    if (target === null) return false;
    this.swap(ws, ws.focus, target);
    if (ws.layout === "scrolling") this.fitScroll(ws);
    return true;
  }

  swap(ws: Workspace, a: number, b: number): void {
    if (a === b) return;
    if (ws.layout === "dwindle") {
      const la = findLeaf(ws.root, a);
      const lb = findLeaf(ws.root, b);
      if (!la || !lb) return;
      la.win = b;
      lb.win = a;
    } else {
      const sa = this.slotOf(ws, a);
      const sb = this.slotOf(ws, b);
      if (!sa || !sb) return;
      sa.column.wins[sa.index] = b;
      sb.column.wins[sb.index] = a;
    }
  }

  /** Grow the focused window by pushing the split boundary in the pad's
   *  direction: positive dx moves a vertical boundary right, positive dy a
   *  horizontal one down. In the scrolling layout dx widens the column. */
  resize(dx: number, dy: number): void {
    const ws = this.workspace();
    if (ws.focus === null || ws.fullscreen !== null) return;
    if (ws.layout === "scrolling") {
      if (dx === 0) return;
      const slot = this.slotOf(ws, ws.focus);
      if (!slot) return;
      slot.column.width = clamp(slot.column.width + dx / this.area().w, MIN_COLUMN, 1);
      this.fitScroll(ws);
      return;
    }
    const leaf = findLeaf(ws.root, ws.focus);
    if (!leaf) return;
    this.placements(ws); // refresh node rects
    const chain = pathTo(ws.root, leaf) ?? [];
    const push = (axis: Axis, d: number) => {
      if (d === 0) return;
      let chosen: Split | null = null;
      for (let i = chain.length - 1; i >= 0; i--) {
        const split = chain[i];
        if (split.axis !== axis) continue;
        const onA = isUnder(split.a, leaf);
        // The boundary sits on the pushed side of the window.
        if (onA === d > 0) {
          chosen = split;
          break;
        }
        if (!chosen) chosen = split;
      }
      if (!chosen?.rect) return;
      const extent = axis === "x" ? chosen.rect.w : chosen.rect.h;
      if (extent <= 0) return;
      chosen.ratio = clamp(chosen.ratio + d / extent, MIN_RATIO, MAX_RATIO);
    };
    push("x", dx);
    push("y", dy);
  }

  /** Dwindle: flip the orientation of the split holding the focused window. */
  toggleSplit(): boolean {
    const ws = this.workspace();
    if (ws.layout !== "dwindle" || ws.focus === null) return false;
    const leaf = findLeaf(ws.root, ws.focus);
    const parent = leaf ? lastOf(pathTo(ws.root, leaf) ?? []) : undefined;
    if (!parent) return false;
    parent.axis = parent.axis === "x" ? "y" : "x";
    return true;
  }

  /** Dwindle: exchange the two halves of the focused window's split. */
  swapSplit(): boolean {
    const ws = this.workspace();
    if (ws.layout !== "dwindle" || ws.focus === null) return false;
    const leaf = findLeaf(ws.root, ws.focus);
    const parent = leaf ? lastOf(pathTo(ws.root, leaf) ?? []) : undefined;
    if (!parent) return false;
    [parent.a, parent.b] = [parent.b, parent.a];
    return true;
  }

  /** Scrolling: step the focused column through the preset widths. */
  cycleColumnWidth(): boolean {
    const ws = this.workspace();
    if (ws.layout !== "scrolling" || ws.focus === null) return false;
    const slot = this.slotOf(ws, ws.focus);
    if (!slot) return false;
    let index = 0;
    let nearest = Number.POSITIVE_INFINITY;
    COLUMN_WIDTHS.forEach((w, i) => {
      const d = Math.abs(w - slot.column.width);
      if (d < nearest) {
        nearest = d;
        index = i;
      }
    });
    slot.column.width = COLUMN_WIDTHS[(index + 1) % COLUMN_WIDTHS.length];
    this.fitScroll(ws);
    return true;
  }

  /** Scrolling: a window alone in its column joins the column to its left;
   *  a window sharing a column leaves into a new column on its right. */
  consumeOrExpel(): boolean {
    const ws = this.workspace();
    if (ws.layout !== "scrolling" || ws.focus === null) return false;
    const slot = this.slotOf(ws, ws.focus);
    if (!slot) return false;
    const columnIndex = ws.columns.indexOf(slot.column);
    if (slot.column.wins.length === 1) {
      if (columnIndex === 0) return false;
      ws.columns.splice(columnIndex, 1);
      ws.columns[columnIndex - 1].wins.push(ws.focus);
    } else {
      slot.column.wins.splice(slot.index, 1);
      ws.columns.splice(columnIndex + 1, 0, { wins: [ws.focus], width: DEFAULT_COLUMN_WIDTH });
    }
    this.fitScroll(ws);
    return true;
  }

  toggleFullscreen(mode: FullscreenMode): boolean {
    const ws = this.workspace();
    if (ws.focus === null) return false;
    if (ws.fullscreen === ws.focus && ws.fullscreenMode === mode) {
      ws.fullscreen = null;
    } else {
      ws.fullscreen = ws.focus;
      ws.fullscreenMode = mode;
    }
    return true;
  }

  toggleBar(): void {
    this.barVisible = !this.barVisible;
  }

  // ---- layouts ---------------------------------------------------------------

  /** Re-tile the workspace in the other layout, keeping window order and focus. */
  toggleLayout(ws: Workspace = this.workspace()): LayoutKind {
    const order = this.order(ws);
    const focus = ws.focus;
    if (ws.layout === "dwindle") {
      ws.columns = order.map((id) => ({ wins: [id], width: DEFAULT_COLUMN_WIDTH }));
      ws.root = null;
      ws.scroll = 0;
      ws.layout = "scrolling";
      this.fitScroll(ws);
    } else {
      ws.columns = [];
      ws.root = null;
      ws.layout = "dwindle";
      // Insert in strip order, each splitting the one before it: the spiral a
      // dwindle user built by opening windows in that order.
      ws.focus = null;
      for (const id of order) {
        this.insert(ws, id);
        ws.focus = id;
      }
      ws.focus = focus;
    }
    return ws.layout;
  }

  /** Scrolling: pan the strip by `dx` pixels (positive reveals the right). */
  scrollBy(dx: number, ws: Workspace = this.workspace()): void {
    if (ws.layout !== "scrolling") return;
    const area = this.area();
    ws.scroll = clamp(ws.scroll + dx, 0, Math.max(0, this.stripWidth(ws, area) - area.w));
  }

  // ---- workspaces ------------------------------------------------------------

  switchWs(id: number): void {
    this.active = clamp(id, 1, WORKSPACES);
  }

  /** Step workspaces; returns false at either end. */
  stepWs(delta: number): boolean {
    const next = this.active + delta;
    if (next < 1 || next > WORKSPACES) return false;
    this.active = next;
    return true;
  }

  /** Move a window to another workspace. Focus there lands on it; focus here
   *  falls to the neighbour that took its place. */
  moveToWs(id: number, wsId: number): boolean {
    const win = this.windows.get(id);
    const target = this.workspace(wsId);
    if (!win || win.ws === target.id) return false;
    const source = this.workspace(win.ws);
    const rect = this.placement(id)?.rect ?? this.area();
    this.detach(source, id, rect);
    win.ws = target.id;
    this.insert(target, id);
    target.focus = id;
    target.fullscreen = null;
    if (target.layout === "scrolling") this.fitScroll(target);
    return true;
  }

  /** Move the focused window to the neighbouring workspace and follow it. */
  carryWs(delta: number): boolean {
    const ws = this.workspace();
    const next = this.active + delta;
    if (ws.focus === null || next < 1 || next > WORKSPACES) return false;
    this.moveToWs(ws.focus, next);
    this.active = next;
    return true;
  }

  // ---- touch handles ---------------------------------------------------------

  /** The dwindle split boundary within `tolerance` px of a point. */
  splitAt(point: Point, tolerance: number, ws: Workspace = this.workspace()): SplitHandle | null {
    if (ws.layout !== "dwindle" || !ws.root || ws.fullscreen !== null) return null;
    this.placements(ws);
    let best: SplitHandle | null = null;
    let bestDistance = tolerance + 1;
    const visit = (node: Node) => {
      if (node.kind === "leaf" || !node.rect) return;
      const r = node.rect;
      if (node.axis === "x") {
        const bx = r.x + Math.round(r.w * node.ratio);
        const d = Math.abs(point.x - bx);
        if (d < bestDistance && point.y >= r.y && point.y < r.y + r.h) {
          bestDistance = d;
          best = { split: node, axis: "x" };
        }
      } else {
        const by = r.y + Math.round(r.h * node.ratio);
        const d = Math.abs(point.y - by);
        if (d < bestDistance && point.x >= r.x && point.x < r.x + r.w) {
          bestDistance = d;
          best = { split: node, axis: "y" };
        }
      }
      visit(node.a);
      visit(node.b);
    };
    visit(ws.root);
    return best;
  }

  /** Put a split boundary under the point. */
  dragSplit(handle: SplitHandle, point: Point): void {
    const r = handle.split.rect;
    if (!r) return;
    const share = handle.axis === "x" ? (point.x - r.x) / r.w : (point.y - r.y) / r.h;
    handle.split.ratio = clamp(share, MIN_RATIO, MAX_RATIO);
  }

  /** The scrolling column whose right edge is within `tolerance` px of x. */
  columnEdgeAt(point: Point, tolerance: number, ws: Workspace = this.workspace()): ColumnHandle | null {
    if (ws.layout !== "scrolling" || ws.fullscreen !== null) return null;
    const area = this.area();
    let x = area.x - ws.scroll;
    for (const column of ws.columns) {
      x += Math.round(area.w * column.width);
      if (Math.abs(point.x - x) <= tolerance) return { column };
    }
    return null;
  }

  /** Put a column's right edge under the point. */
  dragColumnEdge(handle: ColumnHandle, point: Point, ws: Workspace = this.workspace()): void {
    const area = this.area();
    let left = area.x - ws.scroll;
    for (const column of ws.columns) {
      if (column === handle.column) break;
      left += Math.round(area.w * column.width);
    }
    handle.column.width = clamp((point.x - left) / area.w, MIN_COLUMN, 1);
  }

  // ---- internals -------------------------------------------------------------

  private insert(ws: Workspace, id: number): void {
    if (ws.layout === "dwindle") this.insertDwindle(ws, id);
    else this.insertColumn(ws, id);
  }

  private insertDwindle(ws: Workspace, id: number): void {
    const leaf: Leaf = { kind: "leaf", win: id };
    if (!ws.root) {
      ws.root = leaf;
      return;
    }
    const all = leaves(ws.root);
    const target = (ws.focus !== null ? findLeaf(ws.root, ws.focus) : null) ?? all[all.length - 1];
    this.placements(ws); // refresh rects so the split follows the longer side
    const rect = target.rect ?? this.area();
    const split: Split = {
      kind: "split",
      axis: rect.w >= rect.h ? "x" : "y",
      ratio: 0.5,
      a: { kind: "leaf", win: target.win },
      b: leaf,
    };
    this.replace(ws, target, split);
  }

  private insertColumn(ws: Workspace, id: number): void {
    const column: Column = { wins: [id], width: DEFAULT_COLUMN_WIDTH };
    const slot = ws.focus !== null ? this.slotOf(ws, ws.focus) : null;
    const at = slot ? ws.columns.indexOf(slot.column) + 1 : ws.columns.length;
    ws.columns.splice(at, 0, column);
  }

  /** Remove a window from its workspace structure and repair focus. */
  private detach(ws: Workspace, id: number, rect: Rect): void {
    if (ws.layout === "dwindle") {
      const leaf = findLeaf(ws.root, id);
      if (!leaf) return;
      const chain = pathTo(ws.root, leaf) ?? [];
      const parent = lastOf(chain);
      let survivor: Node | null = null;
      if (!parent) {
        ws.root = null;
      } else {
        survivor = parent.a === leaf ? parent.b : parent.a;
        this.replace(ws, parent, survivor);
      }
      if (ws.focus === id) ws.focus = survivor ? this.nearestLeaf(survivor, rect) : null;
    } else {
      const slot = this.slotOf(ws, id);
      if (!slot) return;
      slot.column.wins.splice(slot.index, 1);
      const columnIndex = ws.columns.indexOf(slot.column);
      if (slot.column.wins.length === 0) ws.columns.splice(columnIndex, 1);
      if (ws.focus === id) {
        const column =
          slot.column.wins.length > 0
            ? slot.column
            : ws.columns[Math.min(columnIndex, ws.columns.length - 1)];
        ws.focus = column ? column.wins[Math.min(slot.index, column.wins.length - 1)] : null;
      }
      this.fitScroll(ws);
    }
    if (ws.fullscreen === id) ws.fullscreen = null;
  }

  private replace(ws: Workspace, target: Node, replacement: Node): void {
    if (ws.root === target) {
      ws.root = replacement;
      return;
    }
    const parent = lastOf(pathTo(ws.root, target) ?? []);
    if (!parent) return;
    if (parent.a === target) parent.a = replacement;
    else parent.b = replacement;
  }

  private nearestLeaf(node: Node, rect: Rect): number {
    const c = center(rect);
    let best = leaves(node)[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const leaf of leaves(node)) {
      const lc = leaf.rect ? center(leaf.rect) : c;
      const d = Math.hypot(lc.x - c.x, lc.y - c.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = leaf;
      }
    }
    return best.win;
  }

  private slotOf(ws: Workspace, id: number): { column: Column; index: number } | null {
    for (const column of ws.columns) {
      const index = column.wins.indexOf(id);
      if (index >= 0) return { column, index };
    }
    return null;
  }

  private placeNode(node: Node, rect: Rect, out: Placement[]): void {
    node.rect = rect;
    if (node.kind === "leaf") {
      out.push({ id: node.win, rect: inset(rect, GAP_IN), hidden: false });
      return;
    }
    if (node.axis === "x") {
      const aw = Math.round(rect.w * node.ratio);
      this.placeNode(node.a, { x: rect.x, y: rect.y, w: aw, h: rect.h }, out);
      this.placeNode(node.b, { x: rect.x + aw, y: rect.y, w: rect.w - aw, h: rect.h }, out);
    } else {
      const ah = Math.round(rect.h * node.ratio);
      this.placeNode(node.a, { x: rect.x, y: rect.y, w: rect.w, h: ah }, out);
      this.placeNode(node.b, { x: rect.x, y: rect.y + ah, w: rect.w, h: rect.h - ah }, out);
    }
  }

  private placeColumns(ws: Workspace, area: Rect, out: Placement[]): void {
    let x = area.x - ws.scroll;
    for (const column of ws.columns) {
      const w = Math.round(area.w * column.width);
      const rows = column.wins.length;
      const rowH = Math.floor(area.h / rows);
      column.wins.forEach((id, index) => {
        const y = area.y + index * rowH;
        const h = index === rows - 1 ? area.h - index * rowH : rowH;
        out.push({ id, rect: inset({ x, y, w, h }, GAP_IN), hidden: false });
      });
      x += w;
    }
  }

  private stripWidth(ws: Workspace, area: Rect): number {
    return ws.columns.reduce((sum, column) => sum + Math.round(area.w * column.width), 0);
  }

  /** Scroll so the focused column is fully visible, preferring its right edge. */
  private fitScroll(ws: Workspace): void {
    const area = this.area();
    const total = this.stripWidth(ws, area);
    if (ws.focus !== null) {
      let left = 0;
      for (const column of ws.columns) {
        const w = Math.round(area.w * column.width);
        if (column.wins.includes(ws.focus)) {
          const right = left + w;
          if (right - ws.scroll > area.w) ws.scroll = right - area.w;
          if (left - ws.scroll < 0) ws.scroll = left;
          break;
        }
        left += w;
      }
    }
    ws.scroll = clamp(ws.scroll, 0, Math.max(0, total - area.w));
  }
}
