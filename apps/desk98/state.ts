// apps/desk98/state.ts — compositor state: window controls, popups, desktop
// icons. Hot geometry lives in per-window signals so a drag re-evaluates one
// window's style binding, not the world; the window LIST only changes on
// open/close (a reorder would rebuild the layout tree — z rides zIndex).

import { createSignal, type Accessor } from "solid-js";
import type { CaptionButton, Geo } from "./wm.ts";

export type WinKind = "notepad" | "mines" | "folder" | "about" | "shutdown";

export interface MenuDef {
  label: string;
  /** Hit width in px (measured at open — mirrors the render's px-[6] pads). */
  width: number;
  items: PopupItem[];
}

export interface PopupItem {
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
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
  geo: Accessor<Geo>;
  setGeo: (g: Geo) => void;
  z: Accessor<number>;
  setZ: (z: number) => void;
  minimized: Accessor<boolean>;
  setMinimized: (m: boolean) => void;
  maximized: Accessor<boolean>;
  setMaximized: (m: boolean) => void;
  /** Geometry to restore on un-maximize. */
  restoreGeo: Geo | null;
  pressedBtn: Accessor<CaptionButton | null>;
  setPressedBtn: (b: CaptionButton | null) => void;
  /** Open menu-bar index, -1 closed. */
  openMenu: Accessor<number>;
  setOpenMenu: (i: number) => void;
  /** Program-specific state bag (notepad lines, the mines board, …). */
  data: unknown;
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
  const [geo, setGeo] = createSignal<Geo>(spec.geo);
  const [z, setZ] = createSignal(0);
  const [minimized, setMinimized] = createSignal(false);
  const [maximized, setMaximized] = createSignal(false);
  const [pressedBtn, setPressedBtn] = createSignal<CaptionButton | null>(null);
  const [openMenu, setOpenMenu] = createSignal(-1);
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
    geo,
    setGeo,
    z,
    setZ,
    minimized,
    setMinimized,
    maximized,
    setMaximized,
    restoreGeo: null,
    pressedBtn,
    setPressedBtn,
    openMenu,
    setOpenMenu,
    data: spec.data,
  };
}
