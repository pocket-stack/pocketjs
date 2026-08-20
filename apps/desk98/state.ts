// apps/desk98/state.ts — compositor state: window controls, popups, desktop
// icons. Hot geometry lives in per-window refs so a drag re-evaluates one
// window's style binding, not the world; the window LIST only changes on
// open/close (a reorder would rebuild the layout tree — z rides zIndex).

import { ref, shallowRef, type Ref, type ShallowRef } from "vue";
import type { CaptionButton, Geo } from "./wm.ts";
import type { Doc, History } from "./notepad.ts";
import type { Mines } from "./mines.ts";

export type WinKind = "notepad" | "mines" | "folder" | "about" | "shutdown";

export interface MenuDef {
  label: string;
  /** Hit width in px (measured at open — mirrors the render's px-[6] pads). */
  width: number;
  /** Built at open — disabled states follow live state (selection, …). */
  items: () => PopupItem[];
}

export interface PopupItem {
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  /** Toggle state — renders a checkmark in the icon slot. */
  checked?: boolean;
  sep?: boolean;
  sub?: PopupItem[];
  act?: () => void;
}

export interface Popup {
  x: number;
  y: number;
  w: number;
  items: PopupItem[];
}

export interface WinCtl {
  id: number;
  kind: WinKind;
  title: string;
  icon: string;
  buttons: readonly CaptionButton[];
  resizable: boolean;
  minW: number;
  minH: number;
  menus: MenuDef[] | null;
  geo: ShallowRef<Geo>;
  z: Ref<number>;
  minimized: Ref<boolean>;
  maximized: Ref<boolean>;
  /** Geometry to restore on un-maximize. */
  restoreGeo: Geo | null;
  pressedBtn: Ref<CaptionButton | null>;
  /** Open menu-bar index, -1 closed. */
  openMenu: Ref<number>;
  /** Program-specific state bag (PadData, MinesData, …). */
  data: unknown;
}

// Program state bags. Vue refs instead of accessor/setter pairs — templates
// read `.value` explicitly (refs nested in objects never auto-unwrap).

export interface PadData {
  kind: "notepad";
  doc: ShallowRef<Doc>;
  scroll: Ref<number>;
  preedit: Ref<{ s: string; c: number } | null>;
  /** Word wrap (Edit menu toggle): reflow to the window width. */
  wrap: Ref<boolean>;
  /** Undo/redo snapshots (notepad.ts History). Plain field: nothing renders
   *  from it — the Edit/context menus read it when they build their items. */
  hist: History;
}

export interface MinesData {
  kind: "mines";
  /** Mutated in place by mines.ts rules — re-assign + triggerRef to paint. */
  board: ShallowRef<Mines>;
  /** Cell index held by the primary button, -1 none. */
  held: Ref<number>;
  smileyHeld: Ref<boolean>;
  /** Seconds shown by the timer (app.vue advances it while playing). */
  elapsed: Ref<number>;
}

export interface FolderRow {
  icon: string;
  name: string;
  size: string;
  type: string;
  open?: () => void;
}

export interface FolderData {
  kind: "folder";
  rows: FolderRow[];
  selected: Ref<number>;
}

export interface AboutData {
  kind: "about";
  armed: Ref<string | null>;
}

export interface ShutdownData {
  kind: "shutdown";
  choice: Ref<number>;
  armed: Ref<string | null>;
}

export interface TaskEntry {
  id: number;
  title: string;
  icon: string;
}

export interface DeskIcon {
  icon: string;
  label: string;
  open: () => void;
}

let nextId = 1;

export function createWin(spec: {
  kind: WinKind;
  title: string;
  icon: string;
  geo: Geo;
  buttons?: readonly CaptionButton[];
  resizable?: boolean;
  minW?: number;
  minH?: number;
  menus?: MenuDef[] | null;
  data?: unknown;
}): WinCtl {
  return {
    id: nextId++,
    kind: spec.kind,
    title: spec.title,
    icon: spec.icon,
    buttons: spec.buttons ?? ["min", "max", "close"],
    resizable: spec.resizable ?? true,
    minW: spec.minW ?? 200,
    minH: spec.minH ?? 120,
    menus: spec.menus ?? null,
    geo: shallowRef<Geo>(spec.geo),
    z: ref(0),
    minimized: ref(false),
    maximized: ref(false),
    restoreGeo: null,
    pressedBtn: ref<CaptionButton | null>(null),
    openMenu: ref(-1),
    data: spec.data,
  };
}
