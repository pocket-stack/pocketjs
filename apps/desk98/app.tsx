// apps/desk98/app.tsx — PocketJS 98: a Windows 98 desktop compositor as a
// PocketJS app on the gpui macOS host.
//
// The compositor owns ALL input: the host forwards raw mouse/keyboard over
// the desk svc dialect (svc.ts), and this file routes every event itself —
// window drags, resizes, caption buttons, menus, program content — against
// the same geometry the chrome renders (wm.ts + programs.tsx helpers). The
// framework's focus/onPress pipeline is never engaged; a window manager IS
// its own hit tester. Window moves ride paint-only translate props, raises
// ride zIndex, so a drag never relayouts and an idle desktop hashes stable
// for the demand-render governor.
//
// Without the desk companion (sim, goldens, consoles) the app boots a
// static arrangement and just renders it — the unmodified-app base case.

import { createSignal, For, Show, type Accessor } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { virtualNow } from "@pocketjs/framework/clock";
import { connectSvc, type CursorKind, type HostEvent } from "./svc.ts";
import {
  cascadePos,
  clampMove,
  cursorForDir,
  hitRegion,
  maximizedGeo,
  resizeGeo,
  type CaptionButton,
  type Dir,
  type Geo,
  type Region,
} from "./wm.ts";
import { createWin, type DeskIcon, type Popup, type PopupItem, type TaskEntry, type WinCtl } from "./state.ts";
import { DesktopIcons, PopupPanel, StartMenu, Taskbar, Window98 } from "./chrome.tsx";
import {
  ABOUT_GEO,
  aboutHit,
  AboutView,
  folderRowAt,
  FolderView,
  measure,
  MINES_GEO,
  minesHit,
  MinesView,
  NotepadView,
  PAD_LINE_H,
  shutdownHit,
  ShutdownView,
  type AboutData,
  type FolderData,
  type FolderRow,
  type MinesData,
  type PadData,
  type ShutdownData,
} from "./programs.tsx";
import { backspace, colFromX, del, insertText, moveCaret, type CaretMove, type Doc } from "./notepad.ts";
import { newMines, reveal, toggleFlag, type Mines } from "./mines.ts";
import { contentTop } from "./wm.ts";
import { FRAME, TASK_H } from "./theme.ts";

const WELCOME = [
  "Welcome to PocketJS 98.",
  "",
  "This desktop is one PocketJS guest: the windows,",
  "the taskbar, the Start menu and this Notepad are",
  "JSX over the same DrawList contract the consoles",
  "boot, painted by the gpui backend.",
  "",
  "Things to try:",
  "  - drag windows by the title bar",
  "  - drag any edge or corner to resize",
  "  - double-click a title bar to maximize",
  "  - right-click the desktop or Minesweeper",
  "  - Alt+Tab, Alt+F4, Ctrl+Esc",
  "",
  "The font is W95FA, baked to the same atlas",
  "format every other PocketJS target reads.",
];

type Drag =
  | { type: "move"; id: number; sx: number; sy: number; orig: Geo }
  | { type: "resize"; id: number; dir: Dir; sx: number; sy: number; orig: Geo }
  | { type: "capbtn"; id: number; btn: CaptionButton }
  | { type: "minehold"; id: number }
  | { type: "smiley"; id: number }
  | { type: "dialogbtn"; id: number; tag: string }
  | null;

export default function App() {
  const svc = connectSvc();

  const [vp, setVp] = createSignal<{ w: number; h: number }>({ w: 800, h: 600 });
  const [wins, setWins] = createSignal<WinCtl[]>([]);
  const [focusId, setFocusId] = createSignal(-1);
  const [iconSel, setIconSel] = createSignal(-1);
  const [startOpen, setStartOpen] = createSignal(false);
  const [startHover, setStartHover] = createSignal(-1);
  const [startFly, setStartFly] = createSignal<{ index: number; popup: Popup } | null>(null);
  const [flyHover, setFlyHover] = createSignal(-1);
  const [popup, setPopup] = createSignal<{ popup: Popup; winId?: number } | null>(null);
  const [popupHover, setPopupHover] = createSignal(-1);
  const [clock, setClock] = createSignal("--:--");

  // Non-reactive input state (nothing renders from these directly).
  let stack: number[] = []; // window ids, bottom → top
  let drag: Drag = null;
  let mx = 0;
  let my = 0;
  let prevDown = false;
  let epoch = 0; // wall ms at hello, anchored to virtualNow() then
  let epochAt = 0;
  let lastCursor: CursorKind = "default";
  let lastClick = { key: "", t: -1, x: 0, y: 0 };
  let lastCaret = { x: -1, y: -1, h: 0 };
  let minesStart = 0;

  const byId = (id: number) => wins().find((w) => w.id === id);
  const focused = () => byId(focusId());

  // ---- window management --------------------------------------------------

  function applyZ() {
    stack.forEach((id, i) => byId(id)?.setZ(i + 1));
  }

  function raise(id: number) {
    stack = stack.filter((x) => x !== id).concat(id);
    applyZ();
    setFocusId(id);
    const w = byId(id);
    if (w?.minimized()) w.setMinimized(false);
  }

  function addWin(w: WinCtl) {
    setWins(wins().concat(w));
    stack = stack.concat(w.id);
    applyZ();
    setFocusId(w.id);
  }

  function closeWin(id: number) {
    setWins(wins().filter((w) => w.id !== id));
    stack = stack.filter((x) => x !== id);
    applyZ();
    setFocusId(stack.length > 0 ? stack[stack.length - 1] : -1);
  }

  function minimize(id: number) {
    byId(id)?.setMinimized(true);
    const next = stack.filter((x) => x !== id && !byId(x)?.minimized());
    setFocusId(next.length > 0 ? next[next.length - 1] : -1);
  }

  function toggleMax(w: WinCtl) {
    if (!w.resizable) return;
    if (w.maximized()) {
      w.setMaximized(false);
      if (w.restoreGeo) w.setGeo(w.restoreGeo);
    } else {
      w.restoreGeo = w.geo();
      w.setMaximized(true);
      w.setGeo(maximizedGeo(vp().w, vp().h));
    }
  }

  function cycleWindows() {
    const visible = stack.filter((id) => !byId(id)?.minimized());
    if (visible.length < 2) return;
    raise(visible[0]); // bottom-most visible comes up — repeated Alt+Tab cycles
  }

  // ---- programs -----------------------------------------------------------

  function openNotepad(title: string, content: string[]) {
    const existing = wins().find((w) => w.kind === "notepad" && w.title === title);
    if (existing) return raise(existing.id);
    const [doc, setDoc] = createSignal<Doc>({
      lines: content.length > 0 ? content : [""],
      caret: { row: 0, col: 0 },
    });
    const [scroll, setScroll] = createSignal(0);
    const [preedit, setPreedit] = createSignal<{ s: string; c: number } | null>(null);
    const data: PadData = { kind: "notepad", doc, setDoc, scroll, setScroll, preedit, setPreedit };
    const w = createWin({
      kind: "notepad",
      title,
      icon: "icons/notepad-16.svg",
      geo: cascadePos(wins().length, vp().w, vp().h, 400, 300),
      minW: 220,
      minH: 140,
      menus: [
        {
          label: "File",
          width: measure("File") + 12,
          items: [
            { label: "New", act: () => setDoc({ lines: [""], caret: { row: 0, col: 0 } }) },
            { sep: true, label: "" },
            { label: "Exit", act: () => closeWin(w.id) },
          ],
        },
        {
          label: "Edit",
          width: measure("Edit") + 12,
          items: [
            { label: "Time/Date", shortcut: "F5", act: () => insertTimeDate(w) },
            { sep: true, label: "" },
            { label: "Word Wrap", disabled: true },
          ],
        },
        {
          label: "Help",
          width: measure("Help") + 12,
          items: [{ label: "About PocketJS 98", act: openAbout }],
        },
      ],
      data,
    });
    addWin(w);
  }

  function openMines() {
    const existing = wins().find((w) => w.kind === "mines");
    if (existing) return raise(existing.id);
    const [board, setBoard] = createSignal<Mines>(newMines((virtualNow() * 1000) | 0), {
      equals: false,
    });
    const [held, setHeld] = createSignal(-1);
    const [smileyHeld, setSmileyHeld] = createSignal(false);
    const [elapsed, setElapsed] = createSignal(0);
    const data: MinesData = {
      kind: "mines",
      board,
      setBoard,
      held,
      setHeld,
      smileyHeld,
      setSmileyHeld,
      elapsed,
      setElapsed,
    };
    const w = createWin({
      kind: "mines",
      title: "Minesweeper",
      icon: "icons/mines-16.svg",
      geo: { ...cascadePos(wins().length, vp().w, vp().h, MINES_GEO.w, MINES_GEO.h) },
      buttons: ["min", "close"],
      resizable: false,
      menus: [
        {
          label: "Game",
          width: measure("Game") + 12,
          items: [
            { label: "New", shortcut: "F2", act: () => minesNew(w) },
            { sep: true, label: "" },
            { label: "Exit", act: () => closeWin(w.id) },
          ],
        },
        {
          label: "Help",
          width: measure("Help") + 12,
          items: [{ label: "About PocketJS 98", act: openAbout }],
        },
      ],
      data,
    });
    addWin(w);
  }

  function minesNew(w: WinCtl) {
    const d = w.data as MinesData;
    d.setBoard(newMines((virtualNow() * 1000) | 0));
    d.setElapsed(0);
    minesStart = 0;
  }

  function openFolder(title: string, icon: string, rows: FolderRow[], geoW = 420, geoH = 280) {
    const existing = wins().find((w) => w.kind === "folder" && w.title === title);
    if (existing) return raise(existing.id);
    const [selected, setSelected] = createSignal(-1);
    const data: FolderData = { kind: "folder", rows, selected, setSelected };
    const w = createWin({
      kind: "folder",
      title,
      icon,
      geo: cascadePos(wins().length, vp().w, vp().h, geoW, geoH),
      minW: 260,
      minH: 160,
      data,
    });
    addWin(w);
  }

  function openMyComputer() {
    openFolder("My Computer", "icons/computer-16.svg", [
      {
        icon: "icons/drive-16.svg",
        name: "(C:)",
        size: "",
        type: "Local Disk",
        open: () => openDriveC(),
      },
      { icon: "icons/cdrom-16.svg", name: "(D:)", size: "", type: "CD-ROM Disc" },
      { icon: "icons/folder-16.svg", name: "Control Panel", size: "", type: "System Folder" },
      { icon: "icons/folder-16.svg", name: "Printers", size: "", type: "System Folder" },
    ]);
  }

  function openDriveC() {
    openFolder("(C:)", "icons/drive-16.svg", [
      { icon: "icons/folder-16.svg", name: "Program Files", size: "", type: "File Folder" },
      { icon: "icons/folder-16.svg", name: "Windows", size: "", type: "File Folder" },
      { icon: "icons/file-16.svg", name: "AUTOEXEC.BAT", size: "1 KB", type: "MS-DOS Batch File" },
      { icon: "icons/file-16.svg", name: "CONFIG.SYS", size: "1 KB", type: "System file" },
      {
        icon: "icons/notepad-16.svg",
        name: "README.TXT",
        size: "2 KB",
        type: "Text Document",
        open: () => openNotepad("README.TXT - Notepad", WELCOME),
      },
    ]);
  }

  function openDocuments() {
    openFolder("My Documents", "icons/folder-16.svg", [
      {
        icon: "icons/notepad-16.svg",
        name: "welcome.txt",
        size: "1 KB",
        type: "Text Document",
        open: () => openNotepad("welcome.txt - Notepad", WELCOME),
      },
    ]);
  }

  function openRecycle() {
    openFolder("Recycle Bin", "icons/recycle-16.svg", []);
  }

  function openAbout() {
    const existing = wins().find((w) => w.kind === "about");
    if (existing) return raise(existing.id);
    const [armed, setArmed] = createSignal<string | null>(null);
    const data: AboutData & { setArmed: (s: string | null) => void } = {
      kind: "about",
      armed,
      setArmed,
    };
    const w = createWin({
      kind: "about",
      title: "About PocketJS 98",
      icon: "icons/computer-16.svg",
      geo: centered(ABOUT_GEO.w, ABOUT_GEO.h),
      buttons: ["close"],
      resizable: false,
      data,
    });
    addWin(w);
  }

  function openShutdown() {
    const existing = wins().find((w) => w.kind === "shutdown");
    if (existing) return raise(existing.id);
    const [choice, setChoice] = createSignal(0);
    const [armed, setArmed] = createSignal<string | null>(null);
    const data: ShutdownData & { setArmed: (s: string | null) => void } = {
      kind: "shutdown",
      choice,
      setChoice,
      armed,
      setArmed,
    };
    const w = createWin({
      kind: "shutdown",
      title: "Shut Down Windows",
      icon: "icons/shutdown-16.svg",
      geo: centered(SHUTDOWN_GEO.w, SHUTDOWN_GEO.h),
      buttons: ["close"],
      resizable: false,
      data,
    });
    addWin(w);
  }

  function centered(w: number, h: number): Geo {
    return {
      x: Math.max(0, Math.round((vp().w - w) / 2)),
      y: Math.max(0, Math.round((vp().h - TASK_H - h) / 2)),
      w,
      h,
    };
  }

  function restartSession() {
    for (const w of wins().slice()) closeWin(w.id);
    boot();
  }

  function insertTimeDate(w: WinCtl) {
    const d = w.data as PadData;
    const t = new Date(epoch + (virtualNow() - epochAt) * 1000);
    const stamp = `${pad2(t.getHours())}:${pad2(t.getMinutes())} ${pad2(t.getMonth() + 1)}/${pad2(t.getDate())}/${t.getFullYear()}`;
    d.setDoc(insertText(d.doc(), stamp));
  }

  // ---- desktop icons + start menu -----------------------------------------

  const icons: DeskIcon[] = [
    { icon: "icons/computer.svg", label: "My Computer", open: openMyComputer },
    { icon: "icons/documents.svg", label: "My Documents", open: openDocuments },
    { icon: "icons/recycle.svg", label: "Recycle Bin", open: openRecycle },
    { icon: "icons/notepad.svg", label: "Notepad", open: () => openNotepad("Untitled - Notepad", [""]) },
    { icon: "icons/mines.svg", label: "Minesweeper", open: openMines },
  ];
  const ICON_X = 8;
  const ICON_W = 74;
  const ICON_STRIDE = 58;
  const ICON_CELL_H = 48;

  function iconAt(x: number, y: number): number {
    if (x < ICON_X || x >= ICON_X + ICON_W) return -1;
    const rel = y - 8;
    if (rel < 0 || rel % ICON_STRIDE >= ICON_CELL_H) return -1;
    const i = Math.floor(rel / ICON_STRIDE);
    return i >= 0 && i < icons.length ? i : -1;
  }

  const startItems: () => PopupItem[] = () => [
    {
      label: "Programs",
      icon: "icons/folder-16.svg",
      sub: [
        { label: "Notepad", icon: "icons/notepad-16.svg", act: () => openNotepad("Untitled - Notepad", [""]) },
        { label: "Minesweeper", icon: "icons/mines-16.svg", act: openMines },
      ],
    },
    {
      label: "Documents",
      icon: "icons/folder-16.svg",
      sub: [
        { label: "welcome.txt", icon: "icons/notepad-16.svg", act: () => openNotepad("welcome.txt - Notepad", WELCOME) },
      ],
    },
    { label: "Settings", icon: "icons/settings-16.svg", disabled: true },
    { label: "Find", icon: "icons/find-16.svg", disabled: true },
    { label: "Help", icon: "icons/help-16.svg", act: openAbout },
    { label: "Run...", icon: "icons/run-16.svg", disabled: true },
    { sep: true, label: "" },
    { label: "Shut Down...", icon: "icons/shutdown-16.svg", act: openShutdown },
  ];

  const START_ROW = 26;
  const START_SEP = 8;
  const startH = () =>
    2 + startItems().reduce((a, it) => a + (it.sep ? START_SEP : START_ROW), 0);
  const startY = () => vp().h - TASK_H - startH();

  function startItemAt(x: number, y: number): number {
    const items = startItems();
    if (x < 2 + 25 || x >= 2 + 182 - 1) return -1;
    let oy = startY() + 1;
    for (let i = 0; i < items.length; i++) {
      const h = items[i].sep ? START_SEP : START_ROW;
      if (y >= oy && y < oy + h) return items[i].sep ? -1 : i;
      oy += h;
    }
    return -1;
  }

  function buildPopup(x: number, y: number, items: PopupItem[]): Popup {
    let w = 0;
    for (const it of items) {
      if (it.sep) continue;
      w = Math.max(
        w,
        26 + measure(it.label) + (it.shortcut ? 20 + measure(it.shortcut) : 0) + (it.sub ? 14 : 0) + 14,
      );
    }
    const h = 2 + items.reduce((a, it) => a + (it.sep ? START_SEP : 18), 0);
    return {
      x: Math.min(x, vp().w - w - 2),
      y: Math.min(y, vp().h - TASK_H - h),
      w: Math.max(w, 120),
      items,
    };
  }

  function popupItemAt(p: Popup, x: number, y: number): number {
    if (x < p.x + 1 || x >= p.x + p.w - 1) return -1;
    let oy = p.y + 1;
    for (let i = 0; i < p.items.length; i++) {
      const h = p.items[i].sep ? START_SEP : 18;
      if (y >= oy && y < oy + h) return p.items[i].sep ? -1 : i;
      oy += h;
    }
    return -1;
  }

  function closeMenus() {
    setStartOpen(false);
    setStartFly(null);
    setPopup(null);
    setStartHover(-1);
    setFlyHover(-1);
    setPopupHover(-1);
    for (const w of wins()) w.setOpenMenu(-1);
  }

  // ---- helpers ------------------------------------------------------------

  function chromeOpts(w: WinCtl) {
    return {
      buttons: w.buttons,
      resizable: w.resizable,
      maximized: w.maximized(),
      menuWidths: (w.menus ?? []).map((m) => m.width),
    };
  }

  /** Topmost visible window under the point, with its chrome region. */
  function hitWindows(x: number, y: number): { win: WinCtl; region: Region } | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = byId(stack[i]);
      if (!w || w.minimized()) continue;
      const region = hitRegion(w.geo(), chromeOpts(w), x, y);
      if (region) return { win: w, region };
    }
    return null;
  }

  function isDblClick(key: string): boolean {
    const now = virtualNow();
    const hit =
      lastClick.key === key &&
      now - lastClick.t < 0.4 &&
      Math.abs(mx - lastClick.x) < 4 &&
      Math.abs(my - lastClick.y) < 4;
    lastClick = hit ? { key: "", t: -1, x: 0, y: 0 } : { key, t: now, x: mx, y: my };
    return hit;
  }

  function pad2(n: number): string {
    return String(n).padStart(2, "0");
  }

  function sendCursor(k: CursorKind) {
    if (svc && k !== lastCursor) {
      lastCursor = k;
      svc.send({ t: "cursor", k });
    }
  }

  // ---- input routing ------------------------------------------------------

  function onPrimaryDown(shift: boolean) {
    // Open menus swallow the click (classic: outside-click only dismisses).
    if (startOpen()) {
      const fly = startFly();
      if (fly) {
        const i = popupItemAt(fly.popup, mx, my);
        if (i >= 0) {
          const item = fly.popup.items[i];
          if (!item.disabled && item.act) {
            item.act();
            closeMenus();
          }
          return;
        }
      }
      const i = startItemAt(mx, my);
      if (i >= 0) {
        const item = startItems()[i];
        if (item.sub) return; // hover already opened the flyout; stay open
        if (!item.disabled && item.act) {
          item.act();
          closeMenus();
        }
        return;
      }
      // Outside click (the Start button included) dismisses and is consumed.
      closeMenus();
      return;
    }
    const pop = popup();
    if (pop) {
      const i = popupItemAt(pop.popup, mx, my);
      closeMenus();
      if (i >= 0) {
        const item = pop.popup.items[i];
        if (!item.disabled && item.act) item.act();
      }
      return;
    }

    // Taskbar.
    if (my >= vp().h - TASK_H) {
      if (mx >= 2 && mx < 58) {
        setStartOpen(!startOpen());
        return;
      }
      const entry = taskEntryAt(mx, my);
      if (entry !== -1) {
        const id = wins()[entry].id;
        const w = byId(id);
        if (!w) return;
        if (focusId() === id && !w.minimized()) minimize(id);
        else raise(id);
      }
      return;
    }

    // Windows, top-down.
    const hit = hitWindows(mx, my);
    if (hit) {
      const { win: w, region } = hit;
      raise(w.id);
      if (region.kind === "button") {
        drag = { type: "capbtn", id: w.id, btn: region.button };
        w.setPressedBtn(region.button);
        return;
      }
      if (region.kind === "caption") {
        if (isDblClick(`cap:${w.id}`)) {
          toggleMax(w);
          return;
        }
        if (!w.maximized()) {
          drag = { type: "move", id: w.id, sx: mx, sy: my, orig: w.geo() };
        }
        return;
      }
      if (region.kind === "resize") {
        drag = { type: "resize", id: w.id, dir: region.dir, sx: mx, sy: my, orig: w.geo() };
        return;
      }
      if (region.kind === "menu") {
        const open = w.openMenu() === region.index ? -1 : region.index;
        w.setOpenMenu(open);
        if (open >= 0 && w.menus) {
          const mxs = w.menus.slice(0, open).reduce((a, m) => a + m.width, 0);
          const g = w.geo();
          setPopup({
            popup: buildPopup(g.x + FRAME + mxs, g.y + FRAME + 18 + 1 + 18, w.menus[open].items),
            winId: w.id,
          });
        }
        return;
      }
      routeContentDown(w, region.cx, region.cy, shift);
      return;
    }

    // Desktop: select an icon (double-click opens), deactivate windows.
    const icon = iconAt(mx, my);
    setIconSel(icon);
    setFocusId(-1);
    if (icon >= 0 && isDblClick(`icon:${icon}`)) icons[icon].open();
  }

  function routeContentDown(w: WinCtl, cx: number, cy: number, _shift: boolean) {
    if (w.kind === "notepad") {
      const d = w.data as PadData;
      const doc = d.doc();
      const row = Math.max(
        0,
        Math.min(doc.lines.length - 1, Math.floor((cy - 3 + d.scroll()) / PAD_LINE_H)),
      );
      const col = colFromX(doc.lines[row], cx - 3, (s) => measure(s));
      d.setDoc({ lines: doc.lines, caret: { row, col } });
      return;
    }
    if (w.kind === "mines") {
      const d = w.data as MinesData;
      const hit = minesHit(cx, cy);
      if (hit?.type === "cell") {
        drag = { type: "minehold", id: w.id };
        d.setHeld(hit.i);
      } else if (hit?.type === "smiley") {
        drag = { type: "smiley", id: w.id };
        d.setSmileyHeld(true);
      }
      return;
    }
    if (w.kind === "folder") {
      const d = w.data as FolderData;
      const row = folderRowAt(cy, d.rows.length);
      d.setSelected(row);
      if (row >= 0 && isDblClick(`row:${w.id}:${row}`)) d.rows[row].open?.();
      return;
    }
    if (w.kind === "about") {
      const g = w.geo();
      const hit = aboutHit(g.w - FRAME * 2, g.h - FRAME - contentTop({ menuWidths: [] }), cx, cy);
      if (hit === "ok") {
        drag = { type: "dialogbtn", id: w.id, tag: "ok" };
        (w.data as AboutData & { setArmed: (s: string | null) => void }).setArmed("ok");
      }
      return;
    }
    if (w.kind === "shutdown") {
      const g = w.geo();
      const d = w.data as ShutdownData & { setArmed: (s: string | null) => void };
      const hit = shutdownHit(g.w - FRAME * 2, g.h - FRAME - contentTop({ menuWidths: [] }), cx, cy);
      if (hit === "radio0") d.setChoice(0);
      else if (hit === "radio1") d.setChoice(1);
      else if (hit === "ok" || hit === "cancel") {
        drag = { type: "dialogbtn", id: w.id, tag: hit };
        d.setArmed(hit);
      }
    }
  }

  function onRightDown() {
    if (startOpen() || popup()) {
      closeMenus();
      return;
    }
    const hit = hitWindows(mx, my);
    if (hit) {
      const { win: w, region } = hit;
      if (region.kind === "content" && w.kind === "mines") {
        raise(w.id);
        const d = w.data as MinesData;
        const cell = minesHit(region.cx, region.cy);
        if (cell?.type === "cell") {
          d.setBoard(toggleFlag(d.board(), cell.i));
        }
        return;
      }
      if (region.kind === "caption") {
        raise(w.id);
        setPopup({
          popup: buildPopup(mx, my, [
            { label: "Minimize", act: () => minimize(w.id) },
            {
              label: w.maximized() ? "Restore" : "Maximize",
              disabled: !w.resizable,
              act: () => toggleMax(w),
            },
            { sep: true, label: "" },
            { label: "Close", shortcut: "Alt+F4", act: () => closeWin(w.id) },
          ]),
          winId: w.id,
        });
      }
      return;
    }
    if (my < vp().h - TASK_H) {
      const icon = iconAt(mx, my);
      setIconSel(icon);
      setPopup({
        popup: buildPopup(mx, my, [
          { label: "Arrange Icons", act: () => {} },
          { label: "Refresh", act: () => {} },
          { sep: true, label: "" },
          { label: "New Text Document", act: () => openNotepad("Untitled - Notepad", [""]) },
          { sep: true, label: "" },
          { label: "Properties", disabled: true },
        ]),
      });
    }
  }

  function onMove() {
    // Menu hover states.
    if (startOpen()) {
      const i = startItemAt(mx, my);
      setStartHover(i);
      if (i >= 0) {
        const item = startItems()[i];
        if (item.sub) {
          if (startFly()?.index !== i) {
            let oy = startY() + 1;
            for (let k = 0; k < i; k++) oy += startItems()[k].sep ? START_SEP : START_ROW;
            setStartFly({ index: i, popup: buildPopup(2 + 182 - 3, oy, item.sub) });
            setFlyHover(-1);
          }
        } else if (startFly()) {
          setStartFly(null);
        }
      }
      const fly = startFly();
      if (fly) setFlyHover(popupItemAt(fly.popup, mx, my));
    }
    const pop = popup();
    if (pop) {
      setPopupHover(popupItemAt(pop.popup, mx, my));
      // A menu-bar dropdown follows the hovered menu title (classic).
      if (pop.winId !== undefined) {
        const w = byId(pop.winId);
        if (w?.menus) {
          const r = hitRegion(w.geo(), chromeOpts(w), mx, my);
          if (r?.kind === "menu" && r.index !== w.openMenu()) {
            w.setOpenMenu(r.index);
            const mxs = w.menus.slice(0, r.index).reduce((a, m) => a + m.width, 0);
            const g = w.geo();
            setPopup({
              popup: buildPopup(g.x + FRAME + mxs, g.y + FRAME + 18 + 1 + 18, w.menus[r.index].items),
              winId: w.id,
            });
          }
        }
      }
    }

    // Drags.
    if (drag?.type === "move") {
      const w = byId(drag.id);
      if (w) {
        const g = clampMove(
          { ...drag.orig, x: drag.orig.x + (mx - drag.sx), y: drag.orig.y + (my - drag.sy) },
          vp().w,
          vp().h,
        );
        w.setGeo(g);
      }
      return;
    }
    if (drag?.type === "resize") {
      const w = byId(drag.id);
      if (w) {
        w.setGeo(
          resizeGeo(drag.orig, drag.dir, mx - drag.sx, my - drag.sy, w.minW, w.minH),
        );
      }
      sendCursor(cursorForDir(drag.dir));
      return;
    }
    if (drag?.type === "capbtn") {
      const w = byId(drag.id);
      if (w) {
        const r = hitRegion(w.geo(), chromeOpts(w), mx, my);
        w.setPressedBtn(r?.kind === "button" && r.button === drag.btn ? drag.btn : null);
      }
      return;
    }
    if (drag?.type === "minehold") {
      const w = byId(drag.id);
      if (w) {
        const d = w.data as MinesData;
        const r = hitRegion(w.geo(), chromeOpts(w), mx, my);
        const cell = r?.kind === "content" ? minesHit(r.cx, r.cy) : null;
        d.setHeld(cell?.type === "cell" ? cell.i : -1);
      }
      return;
    }
    if (drag?.type === "dialogbtn") {
      const w = byId(drag.id);
      if (w) {
        const r = hitRegion(w.geo(), chromeOpts(w), mx, my);
        const g = w.geo();
        const cw = g.w - FRAME * 2;
        const chh = g.h - FRAME - contentTop({ menuWidths: [] });
        let over: string | null = null;
        if (r?.kind === "content") {
          over =
            w.kind === "about" ? aboutHit(cw, chh, r.cx, r.cy) : shutdownHit(cw, chh, r.cx, r.cy);
        }
        (w.data as { setArmed: (s: string | null) => void }).setArmed(
          over === drag.tag ? drag.tag : null,
        );
      }
      return;
    }

    // Hover cursor shape.
    let k: CursorKind = "default";
    const hover = hitWindows(mx, my);
    if (hover) {
      if (hover.region.kind === "resize") k = cursorForDir(hover.region.dir);
      else if (hover.region.kind === "content" && hover.win.kind === "notepad") k = "text";
    }
    sendCursor(k);
  }

  function onPrimaryUp() {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.type === "capbtn") {
      const w = byId(d.id);
      if (w && w.pressedBtn() === d.btn) {
        w.setPressedBtn(null);
        if (d.btn === "close") closeWin(d.id);
        else if (d.btn === "min") minimize(d.id);
        else if (d.btn === "max") toggleMax(w);
      } else w?.setPressedBtn(null);
      return;
    }
    if (d.type === "minehold") {
      const w = byId(d.id);
      if (w) {
        const md = w.data as MinesData;
        const i = md.held();
        md.setHeld(-1);
        if (i >= 0) {
          const was = md.board().phase;
          md.setBoard(reveal(md.board(), i));
          if (was === "ready" && md.board().phase === "playing") minesStart = virtualNow();
        }
      }
      return;
    }
    if (d.type === "smiley") {
      const w = byId(d.id);
      if (w) {
        (w.data as MinesData).setSmileyHeld(false);
        const r = hitRegion(w.geo(), chromeOpts(w), mx, my);
        if (r?.kind === "content" && minesHit(r.cx, r.cy)?.type === "smiley") minesNew(w);
      }
      return;
    }
    if (d.type === "dialogbtn") {
      const w = byId(d.id);
      if (w) {
        const data = w.data as { setArmed: (s: string | null) => void };
        const armed = (w.data as AboutData).armed();
        data.setArmed(null);
        if (armed === d.tag) {
          if (w.kind === "about") closeWin(w.id);
          else if (w.kind === "shutdown") {
            const choice = (w.data as ShutdownData).choice();
            if (d.tag === "cancel") closeWin(w.id);
            else if (choice === 0) svc?.send({ t: "quit" });
            else restartSession();
          }
        }
      }
      return;
    }
    if (d.type === "resize") sendCursor("default");
  }

  function onKey(ev: HostEvent) {
    const k = ev.k ?? "";
    if (k === "Escape") {
      if (ev.ctl) {
        // Ctrl+Esc toggles the Start menu (the classic pre-Win-key chord).
        setPopup(null);
        setStartOpen(!startOpen());
        return;
      }
      if (startOpen() || popup()) closeMenus();
      return;
    }
    if (k === "Tab" && (ev.alt || ev.ctl)) {
      cycleWindows();
      return;
    }
    if (k === "F4" && ev.alt) {
      const w = focused();
      if (w) closeWin(w.id);
      else openShutdown();
      return;
    }
    const w = focused();
    if (!w) return;
    if (w.kind === "mines" && k === "F2") {
      minesNew(w);
      return;
    }
    if (w.kind === "notepad") {
      if (k === "F5") {
        insertTimeDate(w);
        return;
      }
      const d = w.data as PadData;
      const doc = d.doc();
      switch (k) {
        case "Enter":
          d.setDoc(insertText(doc, "\n"));
          break;
        case "Backspace":
          d.setDoc(backspace(doc));
          break;
        case "Delete":
          d.setDoc(del(doc));
          break;
        case "Tab":
          d.setDoc(insertText(doc, "    "));
          break;
        case "Left":
        case "Right":
        case "Up":
        case "Down":
        case "Home":
        case "End":
          d.setDoc({ lines: doc.lines, caret: moveCaret(doc, k as CaretMove) });
          break;
        default:
          return;
      }
      scrollCaretIntoView(w);
      return;
    }
    if (w.kind === "shutdown" && k === "Enter") {
      const choice = (w.data as ShutdownData).choice();
      if (choice === 0) svc?.send({ t: "quit" });
      else restartSession();
      return;
    }
    if (w.kind === "about" && k === "Enter") closeWin(w.id);
  }

  function padViewH(w: WinCtl): number {
    return w.geo().h - FRAME - contentTop(chromeOpts(w)) - 2;
  }

  function scrollCaretIntoView(w: WinCtl) {
    const d = w.data as PadData;
    const y = d.doc().caret.row * PAD_LINE_H;
    const viewH = padViewH(w);
    if (y - d.scroll() < 0) d.setScroll(Math.max(0, y));
    else if (y - d.scroll() > viewH - PAD_LINE_H) d.setScroll(y - viewH + PAD_LINE_H);
  }

  function typeInto(w: WinCtl, s: string) {
    const d = w.data as PadData;
    d.setDoc(insertText(d.doc(), s));
    scrollCaretIntoView(w);
  }

  // ---- taskbar ------------------------------------------------------------

  const taskEntries = (): TaskEntry[] =>
    wins()
      .filter((w) => w.kind !== "shutdown")
      .map((w) => ({ id: w.id, title: w.title, icon: w.icon }));
  const taskButtonW = () => {
    const n = Math.max(1, taskEntries().length);
    return Math.min(160, Math.floor((vp().w - 70 - 60 - n * 3) / n));
  };

  function taskEntryAt(x: number, y: number): number {
    if (y < vp().h - TASK_H + 3) return -1;
    const entries = taskEntries();
    const w = taskButtonW();
    const x0 = 2 + 54 + 3 + 1 + 3;
    for (let i = 0; i < entries.length; i++) {
      const bx = x0 + i * (w + 3);
      if (x >= bx && x < bx + w) {
        return wins().findIndex((win) => win.id === entries[i].id);
      }
    }
    return -1;
  }

  // ---- frame pump ---------------------------------------------------------

  function handleEvent(ev: HostEvent) {
    switch (ev.t) {
      case "hello": {
        setVp({ w: ev.w ?? 800, h: ev.h ?? 600 });
        epoch = ev.epoch ?? 0;
        epochAt = virtualNow();
        break;
      }
      case "resize": {
        const w = ev.w ?? vp().w;
        const h = ev.h ?? vp().h;
        setVp({ w, h });
        for (const win of wins()) {
          if (win.maximized()) win.setGeo(maximizedGeo(w, h));
          else win.setGeo(clampMove(win.geo(), w, h));
        }
        break;
      }
      case "mouse": {
        if (ev.b === 2) {
          if (ev.d) {
            mx = ev.x ?? mx;
            my = ev.y ?? my;
            onRightDown();
          }
          break;
        }
        mx = ev.x ?? mx;
        my = ev.y ?? my;
        const down = ev.d ?? false;
        if (down && !prevDown) onPrimaryDown(ev.sh ?? false);
        else if (!down && prevDown) {
          onMove();
          onPrimaryUp();
        } else onMove();
        prevDown = down;
        break;
      }
      case "key":
        onKey(ev);
        break;
      case "ch": {
        const w = focused();
        if (w?.kind === "notepad" && ev.s) typeInto(w, ev.s);
        break;
      }
      case "paste": {
        const w = focused();
        if (w?.kind === "notepad" && ev.text) typeInto(w, ev.text);
        break;
      }
      case "ime": {
        const w = focused();
        if (w?.kind === "notepad") {
          const d = w.data as PadData;
          d.setPreedit(ev.s ? { s: ev.s, c: ev.c ?? ev.s.length } : null);
        }
        break;
      }
      case "scroll": {
        const hover = hitWindows(mx, my);
        if (hover?.win.kind === "notepad") {
          const d = hover.win.data as PadData;
          const contentH = d.doc().lines.length * PAD_LINE_H + 6;
          const maxY = Math.max(0, contentH - padViewH(hover.win));
          d.setScroll(Math.max(0, Math.min(maxY, d.scroll() + (ev.dy ?? 0))));
        }
        break;
      }
    }
  }

  function boot() {
    openNotepad("welcome.txt - Notepad", WELCOME);
    if (!svc) {
      // Standalone (sim/goldens): a lively static arrangement.
      openMines();
      openMyComputer();
    }
  }

  boot();

  onFrame(() => {
    if (svc) for (const ev of svc.poll()) handleEvent(ev);

    // Taskbar clock (minute precision, anchored at the hello epoch).
    if (epoch > 0) {
      const t = new Date(epoch + (virtualNow() - epochAt) * 1000);
      const s = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
      if (s !== clock()) setClock(s);
    }

    // Minesweeper timer.
    const mw = wins().find((w) => w.kind === "mines");
    if (mw) {
      const d = mw.data as MinesData;
      if (d.board().phase === "playing" && minesStart > 0) {
        const e = Math.min(999, Math.floor(virtualNow() - minesStart));
        if (e !== d.elapsed()) d.setElapsed(e);
      }
    }

    // IME candidate window docking: report the focused notepad caret.
    const fw = focused();
    if (svc && fw?.kind === "notepad") {
      const d = fw.data as PadData;
      const g = fw.geo();
      const doc = d.doc();
      const line = doc.lines[doc.caret.row] ?? "";
      const x = g.x + FRAME + 4 + measure(line.slice(0, doc.caret.col));
      const y = g.y + contentTop(chromeOpts(fw)) + 3 + doc.caret.row * PAD_LINE_H - d.scroll();
      if (x !== lastCaret.x || y !== lastCaret.y) {
        lastCaret = { x, y, h: PAD_LINE_H };
        svc.send({ t: "caret", x, y, h: PAD_LINE_H });
      }
    }
  });

  // ---- render -------------------------------------------------------------

  return (
    <View class="absolute inset-0 bg-[#008080] overflow-hidden">
      <DesktopIcons icons={icons} selected={iconSel()} />
      <For each={wins()}>
        {(w) => (
          <Window98 win={w} active={focusId() === w.id}>
            <WinContent win={w} active={focusId() === w.id} />
          </Window98>
        )}
      </For>
      <Show when={startOpen()}>
        <StartMenu x={2} y={startY()} h={startH()} items={startItems()} hover={startHover()} />
        <Show when={startFly()}>
          {(fly) => <PopupPanel popup={fly().popup} hover={flyHover()} />}
        </Show>
      </Show>
      <Show when={popup()}>{(p) => <PopupPanel popup={p().popup} hover={popupHover()} />}</Show>
      <Taskbar
        entries={taskEntries()}
        activeId={focusId()}
        startOpen={startOpen()}
        clock={clock()}
        buttonW={taskButtonW()}
      />
    </View>
  );
}

function WinContent(props: { win: WinCtl; active: boolean }) {
  const w = props.win;
  switch (w.kind) {
    case "notepad":
      return <NotepadView data={w.data as PadData} active={props.active} />;
    case "mines":
      return <MinesView data={w.data as MinesData} />;
    case "folder":
      return (
        <FolderView data={w.data as FolderData} active={props.active} resizable={w.resizable} />
      );
    case "about":
      return <AboutView data={w.data as AboutData} />;
    case "shutdown":
      return <ShutdownView data={w.data as ShutdownData} />;
  }
}
