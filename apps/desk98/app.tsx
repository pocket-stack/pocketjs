// apps/desk98/app.tsx — PocketJS 98: a Windows 98 desktop compositor as a
// PocketJS app on the gpui macOS host — Vue Vapor, authored in JSX
// (vue-jsx-vapor, the same path as apps/hero-vue-vapor).
//
// The compositor owns ALL input: the host forwards raw mouse/keyboard over
// the desk svc dialect (svc.ts), and this file routes every event itself —
// window drags, resizes, caption buttons, menus, text selection, program
// content — against the same geometry the chrome renders (wm.ts +
// programs.tsx helpers). The framework's focus/onPress pipeline is never
// engaged; a window manager IS its own hit tester. Window moves ride
// paint-only translate props, raises ride zIndex, so a drag never relayouts
// and an idle desktop hashes stable for the demand-render governor.
//
// Shortcuts are macOS-style: the host forwards ⌘ chords as cmd-flagged key
// lines (⌘Q quits and ⌘V pastes host-side) — ⌘W closes, ⌘M minimizes,
// ⌘` cycles, ⌘N opens Notepad, ⌘Esc toggles Start, ⌘A/C/X edit the
// focused Notepad.
//
// Without the desk companion (sim, goldens, consoles) the app boots a
// static arrangement and just renders it — the unmodified-app base case.

import { ref, shallowRef, triggerRef } from "vue";
import { Image, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { virtualNow } from "@pocketjs/framework/clock";
import { connectSvc, type CursorKind, type HostEvent } from "./svc.ts";
import {
  cascadePos,
  clampMove,
  contentTop,
  cursorForDir,
  hitRegion,
  maximizedGeo,
  resizeGeo,
  type CaptionButton,
  type Dir,
  type Geo,
  type Region,
} from "./wm.ts";
import {
  createWin,
  type AboutData,
  type DeskIcon,
  type FolderData,
  type FolderRow,
  type MinesData,
  type PadData,
  type Popup,
  type PopupItem,
  type ShutdownData,
  type TaskEntry,
  type WinCtl,
} from "./state.ts";
import {
  ABOUT_GEO,
  AboutView,
  aboutHit,
  FolderView,
  folderRowAt,
  measure,
  MINES_GEO,
  MinesView,
  minesHit,
  NotepadView,
  PAD_LINE_H,
  padSegs,
  padWidth,
  padWrapW,
  SHUTDOWN_GEO,
  ShutdownView,
  shutdownHit,
} from "./programs.tsx";
import {
  applyMoveWrapped,
  backspace,
  caretAtPoint,
  caretXY,
  del,
  deleteSel,
  docEquals,
  emptyHistory,
  hasSel,
  insertText,
  record,
  redoStep,
  selectAll,
  selectedText,
  undoStep,
  wordRangeAt,
  type Caret,
  type CaretMove,
  type Doc,
  type EditKind,
} from "./notepad.ts";
import { newMines, reveal, toggleFlag } from "./mines.ts";
import { CAPTION_ACTIVE, CAPTION_INACTIVE, FRAME, TASK_H } from "./theme.ts";
import { CaptionButtons, DesktopIcons, PopupPanel, StartMenu, T98, Taskbar } from "./chrome.tsx";

const WELCOME = [
  "Welcome to PocketJS 98.",
  "",
  "This desktop is one PocketJS guest: the windows, the taskbar, the Start menu and this Notepad are Vue Vapor JSX over the same DrawList contract the consoles boot, painted by the gpui backend.",
  "",
  "Word wrap is on (Edit > Word Wrap) - these paragraphs are single logical lines; resize the window and they reflow live.",
  "",
  "Things to try:",
  "  - drag windows by the title bar",
  "  - drag any edge or corner to resize",
  "  - double-click a title bar to maximize",
  "  - drag-select this text; Cmd+C/X/V, right-click",
  "  - right-click the desktop or Minesweeper",
  "  - Cmd+` cycles windows, Cmd+W closes them",
  "  - Cmd+Esc opens the Start menu",
  "",
  "The font is W95FA, baked to the same atlas format every other PocketJS target reads.",
];

type Drag =
  | { type: "move"; id: number; sx: number; sy: number; orig: Geo }
  | { type: "resize"; id: number; dir: Dir; sx: number; sy: number; orig: Geo }
  | { type: "capbtn"; id: number; btn: CaptionButton }
  | { type: "textsel"; id: number }
  | { type: "minehold"; id: number }
  | { type: "smiley"; id: number }
  | { type: "dialogbtn"; id: number; tag: string }
  | null;

// Program data bags (typed views of w.data for render + routing).
const padOf = (w: WinCtl) => w.data as PadData;
const minesOf = (w: WinCtl) => w.data as MinesData;
const folderOf = (w: WinCtl) => w.data as FolderData;
const aboutOf = (w: WinCtl) => w.data as AboutData;
const shutdownOf = (w: WinCtl) => w.data as ShutdownData;

/** One window: raised frame, caption gradient, controls, menu bar, and the
 *  program content dispatched on the (static) window kind. Position/size
 *  ride the style prop — translate moves are paint-only, and zIndex raises
 *  without reordering siblings (a reorder would rebuild the layout tree). */
function Window98(props: { win: WinCtl; active: boolean }) {
  const w = props.win;
  return (
    <View
      class="absolute flex-col bg-[#c0c0c0] p-[3] bevel-[#dfdfdf,#000000,#ffffff,#808080]"
      style={{
        insetL: 0,
        insetT: 0,
        width: w.geo.value.w,
        height: w.geo.value.h,
        translateX: w.geo.value.x,
        translateY: w.geo.value.y,
        zIndex: w.z.value,
        opacity: w.minimized.value ? 0 : 1,
      }}
    >
      <View class={props.active ? CAPTION_ACTIVE : CAPTION_INACTIVE}>
        <Image class="w-[16] h-[16] mr-[3]" src={w.icon} />
        <View class="flex-1 flex-row overflow-hidden">
          <T98 bold cls={props.active ? "text-[#ffffff]" : "text-[#c0c0c0]"} t={w.title} />
        </View>
        <CaptionButtons win={w} />
      </View>
      {w.menus !== null ? (
        <View class="flex-row items-center h-[18] bg-[#c0c0c0]">
          {(w.menus ?? []).map((menu, i) => (
            <View
              class={
                w.openMenu.value === i
                  ? "h-[17] px-[6] flex-col justify-center bg-[#000080]"
                  : "h-[17] px-[6] flex-col justify-center"
              }
            >
              <T98
                cls={w.openMenu.value === i ? "text-[#ffffff]" : "text-[#000000]"}
                t={menu.label}
              />
            </View>
          ))}
        </View>
      ) : null}
      <View class="flex-1 flex-col overflow-hidden">
        {w.kind === "notepad" ? (
          <NotepadView data={padOf(w)} wrapW={padWrapW(w)} active={props.active} />
        ) : w.kind === "mines" ? (
          <MinesView data={minesOf(w)} />
        ) : w.kind === "folder" ? (
          <FolderView data={folderOf(w)} resizable={w.resizable} />
        ) : w.kind === "about" ? (
          <AboutView data={aboutOf(w)} />
        ) : (
          <ShutdownView data={shutdownOf(w)} />
        )}
      </View>
    </View>
  );
}

export default function App() {
  const svc = connectSvc();

  const vp = shallowRef<{ w: number; h: number }>({ w: 800, h: 600 });
  const wins = shallowRef<WinCtl[]>([]);
  const focusId = ref(-1);
  const iconSel = ref(-1);
  const startOpen = ref(false);
  const startHover = ref(-1);
  const startFly = shallowRef<{ index: number; popup: Popup } | null>(null);
  const flyHover = ref(-1);
  const popup = shallowRef<{ popup: Popup; winId?: number } | null>(null);
  const popupHover = ref(-1);
  const clock = ref("--:--");

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

  const byId = (id: number) => wins.value.find((w) => w.id === id);
  const focused = () => byId(focusId.value);

  // ---- window management ----------------------------------------------------

  function applyZ() {
    stack.forEach((id, i) => {
      const w = byId(id);
      if (w) w.z.value = i + 1;
    });
  }

  function raise(id: number) {
    stack = stack.filter((x) => x !== id).concat(id);
    applyZ();
    focusId.value = id;
    const w = byId(id);
    if (w?.minimized.value) w.minimized.value = false;
  }

  function addWin(w: WinCtl) {
    wins.value = wins.value.concat(w);
    stack = stack.concat(w.id);
    applyZ();
    focusId.value = w.id;
  }

  function closeWin(id: number) {
    wins.value = wins.value.filter((w) => w.id !== id);
    stack = stack.filter((x) => x !== id);
    applyZ();
    focusId.value = stack.length > 0 ? stack[stack.length - 1] : -1;
  }

  function minimize(id: number) {
    const w = byId(id);
    if (w) w.minimized.value = true;
    const next = stack.filter((x) => x !== id && !byId(x)?.minimized.value);
    focusId.value = next.length > 0 ? next[next.length - 1] : -1;
  }

  function toggleMax(w: WinCtl) {
    if (!w.resizable) return;
    if (w.maximized.value) {
      w.maximized.value = false;
      if (w.restoreGeo) w.geo.value = w.restoreGeo;
    } else {
      w.restoreGeo = w.geo.value;
      w.maximized.value = true;
      w.geo.value = maximizedGeo(vp.value.w, vp.value.h);
    }
  }

  function cycleWindows() {
    const visible = stack.filter((id) => !byId(id)?.minimized.value);
    if (visible.length < 2) return;
    raise(visible[0]); // bottom-most visible comes up — repeated ⌘` cycles
  }

  // ---- clipboard (notepad selection ↔ host) ---------------------------------

  function focusedPad(): { w: WinCtl; d: PadData } | null {
    const w = focused();
    return w?.kind === "notepad" ? { w, d: padOf(w) } : null;
  }

  function copySel(): void {
    const p = focusedPad();
    if (!p) return;
    const text = selectedText(p.d.doc.value);
    if (text !== "" && svc) svc.send({ t: "copy", text });
  }

  function cutSel(): void {
    const p = focusedPad();
    if (!p || !hasSel(p.d.doc.value)) return;
    copySel();
    applyEdit(p.w, "other", deleteSel(p.d.doc.value));
  }

  function pasteReq(): void {
    // The clipboard lives host-side; the paste line answers next frame.
    svc?.send({ t: "paste-req" });
  }

  function selectAllIn(w: WinCtl): void {
    const d = padOf(w);
    d.doc.value = selectAll(d.doc.value);
  }

  // ---- programs ---------------------------------------------------------------

  function openNotepad(title: string, content: string[]) {
    const existing = wins.value.find((w) => w.kind === "notepad" && w.title === title);
    if (existing) return raise(existing.id);
    const data: PadData = {
      kind: "notepad",
      doc: shallowRef<Doc>({
        lines: content.length > 0 ? content : [""],
        caret: { row: 0, col: 0 },
      }),
      scroll: ref(0),
      preedit: ref<{ s: string; c: number } | null>(null),
      wrap: ref(true),
      hist: emptyHistory(),
    };
    const w = createWin({
      kind: "notepad",
      title,
      icon: "icons/notepad-16.svg",
      geo: cascadePos(wins.value.length, vp.value.w, vp.value.h, 400, 300),
      minW: 220,
      minH: 140,
      menus: [
        {
          label: "File",
          width: measure("File") + 12,
          items: () => [
            {
              label: "New",
              act: () => {
                applyEdit(w, "other", { lines: [""], caret: { row: 0, col: 0 } });
              },
            },
            { sep: true, label: "" },
            {
              label: "Exit",
              shortcut: "Cmd+W",
              act: () => {
                closeWin(w.id);
              },
            },
          ],
        },
        {
          label: "Edit",
          width: measure("Edit") + 12,
          items: () => [
            {
              label: "Undo",
              shortcut: "Cmd+Z",
              disabled: data.hist.undo.length === 0,
              act: () => {
                undoIn(w);
              },
            },
            {
              label: "Redo",
              shortcut: "Cmd+Shift+Z",
              disabled: data.hist.redo.length === 0,
              act: () => {
                redoIn(w);
              },
            },
            { sep: true, label: "" },
            { label: "Cut", shortcut: "Cmd+X", disabled: !hasSel(data.doc.value), act: cutSel },
            { label: "Copy", shortcut: "Cmd+C", disabled: !hasSel(data.doc.value), act: copySel },
            { label: "Paste", shortcut: "Cmd+V", act: pasteReq },
            {
              label: "Select All",
              shortcut: "Cmd+A",
              act: () => {
                selectAllIn(w);
              },
            },
            { sep: true, label: "" },
            {
              label: "Time/Date",
              shortcut: "F5",
              act: () => {
                insertTimeDate(w);
              },
            },
            { sep: true, label: "" },
            {
              label: "Word Wrap",
              checked: data.wrap.value,
              act: () => {
                data.wrap.value = !data.wrap.value;
                scrollCaretIntoView(w);
              },
            },
          ],
        },
        {
          label: "Help",
          width: measure("Help") + 12,
          items: () => [{ label: "About PocketJS 98", act: openAbout }],
        },
      ],
      data,
    });
    addWin(w);
  }

  function openMines() {
    const existing = wins.value.find((w) => w.kind === "mines");
    if (existing) return raise(existing.id);
    const data: MinesData = {
      kind: "mines",
      board: shallowRef(newMines((virtualNow() * 1000) | 0)),
      held: ref(-1),
      smileyHeld: ref(false),
      elapsed: ref(0),
    };
    const w = createWin({
      kind: "mines",
      title: "Minesweeper",
      icon: "icons/mines-16.svg",
      geo: { ...cascadePos(wins.value.length, vp.value.w, vp.value.h, MINES_GEO.w, MINES_GEO.h) },
      buttons: ["min", "close"],
      resizable: false,
      menus: [
        {
          label: "Game",
          width: measure("Game") + 12,
          items: () => [
            {
              label: "New",
              shortcut: "F2",
              act: () => {
                minesNew(w);
              },
            },
            { sep: true, label: "" },
            {
              label: "Exit",
              shortcut: "Cmd+W",
              act: () => {
                closeWin(w.id);
              },
            },
          ],
        },
        {
          label: "Help",
          width: measure("Help") + 12,
          items: () => [{ label: "About PocketJS 98", act: openAbout }],
        },
      ],
      data,
    });
    addWin(w);
  }

  function minesNew(w: WinCtl) {
    const d = minesOf(w);
    d.board.value = newMines((virtualNow() * 1000) | 0);
    d.elapsed.value = 0;
    minesStart = 0;
  }

  function openFolder(title: string, icon: string, rows: FolderRow[], geoW = 420, geoH = 280) {
    const existing = wins.value.find((w) => w.kind === "folder" && w.title === title);
    if (existing) return raise(existing.id);
    const data: FolderData = { kind: "folder", rows, selected: ref(-1) };
    const w = createWin({
      kind: "folder",
      title,
      icon,
      geo: cascadePos(wins.value.length, vp.value.w, vp.value.h, geoW, geoH),
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
        open: () => {
          openDriveC();
        },
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
        open: () => {
          openNotepad("README.TXT - Notepad", WELCOME);
        },
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
        open: () => {
          openNotepad("welcome.txt - Notepad", WELCOME);
        },
      },
    ]);
  }

  function openRecycle() {
    openFolder("Recycle Bin", "icons/recycle-16.svg", []);
  }

  function openAbout() {
    const existing = wins.value.find((w) => w.kind === "about");
    if (existing) return raise(existing.id);
    const data: AboutData = { kind: "about", armed: ref<string | null>(null) };
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
    const existing = wins.value.find((w) => w.kind === "shutdown");
    if (existing) return raise(existing.id);
    const data: ShutdownData = {
      kind: "shutdown",
      choice: ref(0),
      armed: ref<string | null>(null),
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
      x: Math.max(0, Math.round((vp.value.w - w) / 2)),
      y: Math.max(0, Math.round((vp.value.h - TASK_H - h) / 2)),
      w,
      h,
    };
  }

  function restartSession() {
    for (const w of wins.value.slice()) closeWin(w.id);
    boot();
  }

  function insertTimeDate(w: WinCtl) {
    const d = padOf(w);
    const t = new Date(epoch + (virtualNow() - epochAt) * 1000);
    const stamp = `${pad2(t.getHours())}:${pad2(t.getMinutes())} ${pad2(t.getMonth() + 1)}/${pad2(t.getDate())}/${t.getFullYear()}`;
    applyEdit(w, "other", insertText(d.doc.value, stamp));
  }

  // ---- desktop icons + start menu ----------------------------------------------

  const icons: DeskIcon[] = [
    { icon: "icons/computer.svg", label: "My Computer", open: openMyComputer },
    { icon: "icons/documents.svg", label: "My Documents", open: openDocuments },
    { icon: "icons/recycle.svg", label: "Recycle Bin", open: openRecycle },
    {
      icon: "icons/notepad.svg",
      label: "Notepad",
      open: () => {
        openNotepad("Untitled - Notepad", [""]);
      },
    },
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

  const startItems = (): PopupItem[] => [
    {
      label: "Programs",
      icon: "icons/folder-16.svg",
      sub: [
        {
          label: "Notepad",
          icon: "icons/notepad-16.svg",
          act: () => {
            openNotepad("Untitled - Notepad", [""]);
          },
        },
        { label: "Minesweeper", icon: "icons/mines-16.svg", act: openMines },
      ],
    },
    {
      label: "Documents",
      icon: "icons/folder-16.svg",
      sub: [
        {
          label: "welcome.txt",
          icon: "icons/notepad-16.svg",
          act: () => {
            openNotepad("welcome.txt - Notepad", WELCOME);
          },
        },
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
  const startY = () => vp.value.h - TASK_H - startH();

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
      x: Math.min(x, vp.value.w - w - 2),
      y: Math.min(y, vp.value.h - TASK_H - h),
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
    startOpen.value = false;
    startFly.value = null;
    popup.value = null;
    startHover.value = -1;
    flyHover.value = -1;
    popupHover.value = -1;
    for (const w of wins.value) w.openMenu.value = -1;
  }

  function toggleStart() {
    popup.value = null;
    startOpen.value = !startOpen.value;
    if (!startOpen.value) {
      startFly.value = null;
      startHover.value = -1;
      flyHover.value = -1;
    }
  }

  // ---- helpers ------------------------------------------------------------------

  function chromeOpts(w: WinCtl) {
    return {
      buttons: w.buttons,
      resizable: w.resizable,
      maximized: w.maximized.value,
      menuWidths: (w.menus ?? []).map((m) => m.width),
    };
  }

  /** Topmost visible window under the point, with its chrome region. */
  function hitWindows(x: number, y: number): { win: WinCtl; region: Region } | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = byId(stack[i]);
      if (!w || w.minimized.value) continue;
      const region = hitRegion(w.geo.value, chromeOpts(w), x, y);
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

  /** Notepad caret for a content-local point, over the wrapped layout
   *  (visual row from y, column from x inside that segment). */
  function padCaretAt(w: WinCtl, cx: number, cy: number): Caret {
    const d = padOf(w);
    const vrow = Math.floor((cy - 3 + d.scroll.value) / PAD_LINE_H);
    return caretAtPoint(padSegs(w), d.doc.value.lines, vrow, cx - 3, padWidth);
  }

  // ---- input routing --------------------------------------------------------------

  function onPrimaryDown(shift: boolean) {
    // Open menus swallow the click (classic: outside-click only dismisses).
    if (startOpen.value) {
      const fly = startFly.value;
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
    const pop = popup.value;
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
    if (my >= vp.value.h - TASK_H) {
      if (mx >= 2 && mx < 58) {
        startOpen.value = !startOpen.value;
        return;
      }
      const entry = taskEntryAt(mx, my);
      if (entry !== -1) {
        const id = wins.value[entry].id;
        const w = byId(id);
        if (!w) return;
        if (focusId.value === id && !w.minimized.value) minimize(id);
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
        w.pressedBtn.value = region.button;
        return;
      }
      if (region.kind === "caption") {
        if (isDblClick(`cap:${w.id}`)) {
          toggleMax(w);
          return;
        }
        if (!w.maximized.value) {
          drag = { type: "move", id: w.id, sx: mx, sy: my, orig: w.geo.value };
        }
        return;
      }
      if (region.kind === "resize") {
        drag = { type: "resize", id: w.id, dir: region.dir, sx: mx, sy: my, orig: w.geo.value };
        return;
      }
      if (region.kind === "menu") {
        const open = w.openMenu.value === region.index ? -1 : region.index;
        w.openMenu.value = open;
        if (open >= 0 && w.menus) {
          const mxs = w.menus.slice(0, open).reduce((a, m) => a + m.width, 0);
          const g = w.geo.value;
          popup.value = {
            popup: buildPopup(g.x + FRAME + mxs, g.y + FRAME + 18 + 1 + 18, w.menus[open].items()),
            winId: w.id,
          };
        }
        return;
      }
      routeContentDown(w, region.cx, region.cy, shift);
      return;
    }

    // Desktop: select an icon (double-click opens), deactivate windows.
    const icon = iconAt(mx, my);
    iconSel.value = icon;
    focusId.value = -1;
    if (icon >= 0 && isDblClick(`icon:${icon}`)) icons[icon].open();
  }

  function routeContentDown(w: WinCtl, cx: number, cy: number, shift: boolean) {
    if (w.kind === "notepad") {
      const d = padOf(w);
      const doc = d.doc.value;
      const caret = padCaretAt(w, cx, cy);
      if (isDblClick(`pad:${w.id}`)) {
        // Double-click: select the word under the pointer.
        const r = wordRangeAt(doc.lines[caret.row], caret.col);
        d.doc.value = {
          lines: doc.lines,
          caret: { row: caret.row, col: r.to },
          anchor: { row: caret.row, col: r.from },
        };
        return;
      }
      // Click places the caret; shift-click extends; dragging selects.
      const anchor = shift ? (doc.anchor ?? doc.caret) : { row: caret.row, col: caret.col };
      d.doc.value = { lines: doc.lines, caret, anchor };
      drag = { type: "textsel", id: w.id };
      return;
    }
    if (w.kind === "mines") {
      const d = minesOf(w);
      const hit = minesHit(cx, cy);
      if (hit?.type === "cell") {
        drag = { type: "minehold", id: w.id };
        d.held.value = hit.i;
      } else if (hit?.type === "smiley") {
        drag = { type: "smiley", id: w.id };
        d.smileyHeld.value = true;
      }
      return;
    }
    if (w.kind === "folder") {
      const d = folderOf(w);
      const row = folderRowAt(cy, d.rows.length);
      d.selected.value = row;
      if (row >= 0 && isDblClick(`row:${w.id}:${row}`)) d.rows[row].open?.();
      return;
    }
    if (w.kind === "about") {
      const g = w.geo.value;
      const hit = aboutHit(g.w - FRAME * 2, g.h - FRAME - contentTop({ menuWidths: [] }), cx, cy);
      if (hit === "ok") {
        drag = { type: "dialogbtn", id: w.id, tag: "ok" };
        aboutOf(w).armed.value = "ok";
      }
      return;
    }
    if (w.kind === "shutdown") {
      const g = w.geo.value;
      const d = shutdownOf(w);
      const hit = shutdownHit(g.w - FRAME * 2, g.h - FRAME - contentTop({ menuWidths: [] }), cx, cy);
      if (hit === "radio0") d.choice.value = 0;
      else if (hit === "radio1") d.choice.value = 1;
      else if (hit === "ok" || hit === "cancel") {
        drag = { type: "dialogbtn", id: w.id, tag: hit };
        d.armed.value = hit;
      }
    }
  }

  function onRightDown() {
    if (startOpen.value || popup.value) {
      closeMenus();
      return;
    }
    const hit = hitWindows(mx, my);
    if (hit) {
      const { win: w, region } = hit;
      if (region.kind === "content" && w.kind === "mines") {
        raise(w.id);
        const d = minesOf(w);
        const cell = minesHit(region.cx, region.cy);
        if (cell?.type === "cell") {
          d.board.value = toggleFlag(d.board.value, cell.i);
          triggerRef(d.board);
        }
        return;
      }
      if (region.kind === "content" && w.kind === "notepad") {
        raise(w.id);
        const d = padOf(w);
        const has = hasSel(d.doc.value);
        popup.value = {
          popup: buildPopup(mx, my, [
            { label: "Cut", shortcut: "Cmd+X", disabled: !has, act: cutSel },
            { label: "Copy", shortcut: "Cmd+C", disabled: !has, act: copySel },
            { label: "Paste", shortcut: "Cmd+V", act: pasteReq },
            { sep: true, label: "" },
            {
              label: "Select All",
              shortcut: "Cmd+A",
              act: () => {
                selectAllIn(w);
              },
            },
          ]),
        };
        return;
      }
      if (region.kind === "caption") {
        raise(w.id);
        popup.value = {
          popup: buildPopup(mx, my, [
            {
              label: "Minimize",
              shortcut: "Cmd+M",
              act: () => {
                minimize(w.id);
              },
            },
            {
              label: w.maximized.value ? "Restore" : "Maximize",
              disabled: !w.resizable,
              act: () => {
                toggleMax(w);
              },
            },
            { sep: true, label: "" },
            {
              label: "Close",
              shortcut: "Cmd+W",
              act: () => {
                closeWin(w.id);
              },
            },
          ]),
          winId: w.id,
        };
      }
      return;
    }
    if (my < vp.value.h - TASK_H) {
      const icon = iconAt(mx, my);
      iconSel.value = icon;
      popup.value = {
        popup: buildPopup(mx, my, [
          { label: "Arrange Icons", act: () => {} },
          { label: "Refresh", act: () => {} },
          { sep: true, label: "" },
          {
            label: "New Text Document",
            act: () => {
              openNotepad("Untitled - Notepad", [""]);
            },
          },
          { sep: true, label: "" },
          { label: "Properties", disabled: true },
        ]),
      };
    }
  }

  function onMove() {
    // Menu hover states.
    if (startOpen.value) {
      const i = startItemAt(mx, my);
      startHover.value = i;
      if (i >= 0) {
        const item = startItems()[i];
        if (item.sub) {
          if (startFly.value?.index !== i) {
            let oy = startY() + 1;
            for (let k = 0; k < i; k++) oy += startItems()[k].sep ? START_SEP : START_ROW;
            startFly.value = { index: i, popup: buildPopup(2 + 182 - 3, oy, item.sub) };
            flyHover.value = -1;
          }
        } else if (startFly.value) {
          startFly.value = null;
        }
      }
      const fly = startFly.value;
      if (fly) flyHover.value = popupItemAt(fly.popup, mx, my);
    }
    const pop = popup.value;
    if (pop) {
      popupHover.value = popupItemAt(pop.popup, mx, my);
      // A menu-bar dropdown follows the hovered menu title (classic).
      if (pop.winId !== undefined) {
        const w = byId(pop.winId);
        if (w?.menus) {
          const r = hitRegion(w.geo.value, chromeOpts(w), mx, my);
          if (r?.kind === "menu" && r.index !== w.openMenu.value) {
            w.openMenu.value = r.index;
            const mxs = w.menus.slice(0, r.index).reduce((a, m) => a + m.width, 0);
            const g = w.geo.value;
            popup.value = {
              popup: buildPopup(
                g.x + FRAME + mxs,
                g.y + FRAME + 18 + 1 + 18,
                w.menus[r.index].items(),
              ),
              winId: w.id,
            };
          }
        }
      }
    }

    // Drags.
    if (drag?.type === "move") {
      const w = byId(drag.id);
      if (w) {
        w.geo.value = clampMove(
          { ...drag.orig, x: drag.orig.x + (mx - drag.sx), y: drag.orig.y + (my - drag.sy) },
          vp.value.w,
          vp.value.h,
        );
      }
      return;
    }
    if (drag?.type === "resize") {
      const w = byId(drag.id);
      if (w) {
        w.geo.value = resizeGeo(drag.orig, drag.dir, mx - drag.sx, my - drag.sy, w.minW, w.minH);
      }
      sendCursor(cursorForDir(drag.dir));
      return;
    }
    if (drag?.type === "textsel") {
      const w = byId(drag.id);
      if (w) {
        const d = padOf(w);
        const g = w.geo.value;
        const cx = mx - g.x - FRAME;
        const cy = my - g.y - contentTop(chromeOpts(w));
        const doc = d.doc.value;
        const caret = padCaretAt(w, Math.max(0, cx), cy);
        if (
          caret.row !== doc.caret.row ||
          caret.col !== doc.caret.col ||
          (caret.end ?? false) !== (doc.caret.end ?? false)
        ) {
          d.doc.value = { lines: doc.lines, caret, anchor: doc.anchor ?? doc.caret };
        }
      }
      sendCursor("text");
      return;
    }
    if (drag?.type === "capbtn") {
      const w = byId(drag.id);
      if (w) {
        const r = hitRegion(w.geo.value, chromeOpts(w), mx, my);
        w.pressedBtn.value = r?.kind === "button" && r.button === drag.btn ? drag.btn : null;
      }
      return;
    }
    if (drag?.type === "minehold") {
      const w = byId(drag.id);
      if (w) {
        const d = minesOf(w);
        const r = hitRegion(w.geo.value, chromeOpts(w), mx, my);
        const cell = r?.kind === "content" ? minesHit(r.cx, r.cy) : null;
        d.held.value = cell?.type === "cell" ? cell.i : -1;
      }
      return;
    }
    if (drag?.type === "dialogbtn") {
      const w = byId(drag.id);
      if (w) {
        const r = hitRegion(w.geo.value, chromeOpts(w), mx, my);
        const g = w.geo.value;
        const cw = g.w - FRAME * 2;
        const chh = g.h - FRAME - contentTop({ menuWidths: [] });
        let over: string | null = null;
        if (r?.kind === "content") {
          over =
            w.kind === "about" ? aboutHit(cw, chh, r.cx, r.cy) : shutdownHit(cw, chh, r.cx, r.cy);
        }
        const armed = w.kind === "about" ? aboutOf(w).armed : shutdownOf(w).armed;
        armed.value = over === drag.tag ? drag.tag : null;
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
      if (w && w.pressedBtn.value === d.btn) {
        w.pressedBtn.value = null;
        if (d.btn === "close") closeWin(d.id);
        else if (d.btn === "min") minimize(d.id);
        else if (d.btn === "max") toggleMax(w);
      } else if (w) w.pressedBtn.value = null;
      return;
    }
    if (d.type === "minehold") {
      const w = byId(d.id);
      if (w) {
        const md = minesOf(w);
        const i = md.held.value;
        md.held.value = -1;
        if (i >= 0) {
          const was = md.board.value.phase;
          md.board.value = reveal(md.board.value, i);
          triggerRef(md.board);
          if (was === "ready" && md.board.value.phase === "playing") minesStart = virtualNow();
        }
      }
      return;
    }
    if (d.type === "smiley") {
      const w = byId(d.id);
      if (w) {
        minesOf(w).smileyHeld.value = false;
        const r = hitRegion(w.geo.value, chromeOpts(w), mx, my);
        if (r?.kind === "content" && minesHit(r.cx, r.cy)?.type === "smiley") minesNew(w);
      }
      return;
    }
    if (d.type === "dialogbtn") {
      const w = byId(d.id);
      if (w) {
        const armedRef = w.kind === "about" ? aboutOf(w).armed : shutdownOf(w).armed;
        const armed = armedRef.value;
        armedRef.value = null;
        if (armed === d.tag) {
          if (w.kind === "about") closeWin(w.id);
          else if (w.kind === "shutdown") {
            const choice = shutdownOf(w).choice.value;
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

  /** macOS-style ⌘ chords (host forwards them cmd-flagged, raw lowercase k). */
  function onCmd(k: string, shift: boolean) {
    switch (k) {
      case "z": {
        const p = focusedPad();
        if (p) {
          if (shift) redoIn(p.w);
          else undoIn(p.w);
        }
        return;
      }
      case "escape":
        toggleStart();
        return;
      case "`":
        cycleWindows();
        return;
      case "n":
        openNotepad("Untitled - Notepad", [""]);
        return;
      case "w": {
        const w = focused();
        if (w) closeWin(w.id);
        return;
      }
      case "m": {
        const w = focused();
        if (w) minimize(w.id);
        return;
      }
      case "a": {
        const p = focusedPad();
        if (p) selectAllIn(p.w);
        return;
      }
      case "c":
        copySel();
        return;
      case "x":
        cutSel();
        return;
    }
  }

  function onKey(ev: HostEvent) {
    const k = ev.k ?? "";
    if (ev.cmd) {
      onCmd(k, ev.sh ?? false);
      return;
    }
    if (k === "Escape") {
      if (startOpen.value || popup.value) closeMenus();
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
      const d = padOf(w);
      const doc = d.doc.value;
      switch (k) {
        case "Enter":
          applyEdit(w, "other", insertText(doc, "\n"));
          return;
        case "Backspace":
          applyEdit(w, "erase", backspace(doc));
          return;
        case "Delete":
          applyEdit(w, "erase", del(doc));
          return;
        case "Tab":
          applyEdit(w, "type", insertText(doc, "    "));
          return;
        case "Left":
        case "Right":
        case "Up":
        case "Down":
        case "Home":
        case "End":
          d.doc.value = applyMoveWrapped(doc, k as CaretMove, ev.sh ?? false, padSegs(w), padWidth);
          break;
        default:
          return;
      }
      scrollCaretIntoView(w);
      return;
    }
    if (w.kind === "shutdown" && k === "Enter") {
      const choice = shutdownOf(w).choice.value;
      if (choice === 0) svc?.send({ t: "quit" });
      else restartSession();
      return;
    }
    if (w.kind === "about" && k === "Enter") closeWin(w.id);
  }

  function padViewH(w: WinCtl): number {
    return w.geo.value.h - FRAME - contentTop(chromeOpts(w)) - 2;
  }

  function scrollCaretIntoView(w: WinCtl) {
    const d = padOf(w);
    const vrow = caretXY(padSegs(w), d.doc.value.lines, d.doc.value.caret, padWidth).vrow;
    const y = vrow * PAD_LINE_H;
    const viewH = padViewH(w);
    if (y - d.scroll.value < 0) d.scroll.value = Math.max(0, y);
    else if (y - d.scroll.value > viewH - PAD_LINE_H) d.scroll.value = y - viewH + PAD_LINE_H;
  }

  /** Apply an EDIT (never a plain caret/selection move) with an undo
   *  snapshot. Coalescing lives in notepad.ts record(); no-op edits record
   *  nothing. */
  function applyEdit(w: WinCtl, kind: EditKind, next: Doc) {
    const d = padOf(w);
    const prev = d.doc.value;
    if (docEquals(prev, next)) return;
    d.hist = record(d.hist, prev, next, kind);
    d.doc.value = next;
    scrollCaretIntoView(w);
  }

  function undoIn(w: WinCtl) {
    const d = padOf(w);
    const r = undoStep(d.hist, d.doc.value);
    if (!r) return;
    d.hist = r.h;
    d.doc.value = r.doc;
    d.preedit.value = null;
    scrollCaretIntoView(w);
  }

  function redoIn(w: WinCtl) {
    const d = padOf(w);
    const r = redoStep(d.hist, d.doc.value);
    if (!r) return;
    d.hist = r.h;
    d.doc.value = r.doc;
    d.preedit.value = null;
    scrollCaretIntoView(w);
  }

  function typeInto(w: WinCtl, s: string, kind: EditKind = "type") {
    applyEdit(w, kind, insertText(padOf(w).doc.value, s));
  }

  // ---- taskbar --------------------------------------------------------------------

  const taskEntries = (): TaskEntry[] =>
    wins.value
      .filter((w) => w.kind !== "shutdown")
      .map((w) => ({ id: w.id, title: w.title, icon: w.icon }));
  const taskButtonW = () => {
    const n = Math.max(1, taskEntries().length);
    return Math.min(160, Math.floor((vp.value.w - 70 - 60 - n * 3) / n));
  };

  function taskEntryAt(x: number, y: number): number {
    if (y < vp.value.h - TASK_H + 3) return -1;
    const entries = taskEntries();
    const w = taskButtonW();
    const x0 = 2 + 54 + 3 + 1 + 3;
    for (let i = 0; i < entries.length; i++) {
      const bx = x0 + i * (w + 3);
      if (x >= bx && x < bx + w) {
        return wins.value.findIndex((win) => win.id === entries[i].id);
      }
    }
    return -1;
  }

  // ---- frame pump -------------------------------------------------------------------

  function handleEvent(ev: HostEvent) {
    switch (ev.t) {
      case "hello": {
        vp.value = { w: ev.w ?? 800, h: ev.h ?? 600 };
        epoch = ev.epoch ?? 0;
        epochAt = virtualNow();
        break;
      }
      case "resize": {
        const w = ev.w ?? vp.value.w;
        const h = ev.h ?? vp.value.h;
        vp.value = { w, h };
        for (const win of wins.value) {
          if (win.maximized.value) win.geo.value = maximizedGeo(w, h);
          else win.geo.value = clampMove(win.geo.value, w, h);
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
        if (w?.kind === "notepad" && ev.text) typeInto(w, ev.text, "other");
        break;
      }
      case "ime": {
        const w = focused();
        if (w?.kind === "notepad") {
          const d = padOf(w);
          // Composition replaces the selection the moment it starts.
          if (ev.s && hasSel(d.doc.value)) applyEdit(w, "other", deleteSel(d.doc.value));
          d.preedit.value = ev.s ? { s: ev.s, c: ev.c ?? ev.s.length } : null;
        }
        break;
      }
      case "scroll": {
        const hover = hitWindows(mx, my);
        if (hover?.win.kind === "notepad") {
          const d = padOf(hover.win);
          const contentH = padSegs(hover.win).length * PAD_LINE_H + 6;
          const maxY = Math.max(0, contentH - padViewH(hover.win));
          d.scroll.value = Math.max(0, Math.min(maxY, d.scroll.value + (ev.dy ?? 0)));
        }
        break;
      }
    }
  }

  function boot() {
    openNotepad("welcome.txt - Notepad", WELCOME);
    if (!svc) {
      // Standalone (sim, goldens): a lively static arrangement.
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
      if (s !== clock.value) clock.value = s;
    }

    // Minesweeper timer.
    const mw = wins.value.find((w) => w.kind === "mines");
    if (mw) {
      const d = minesOf(mw);
      if (d.board.value.phase === "playing" && minesStart > 0) {
        const e = Math.min(999, Math.floor(virtualNow() - minesStart));
        if (e !== d.elapsed.value) d.elapsed.value = e;
      }
    }

    // IME candidate window docking: report the focused notepad caret.
    const fw = focused();
    if (svc && fw?.kind === "notepad") {
      const d = padOf(fw);
      const g = fw.geo.value;
      const doc = d.doc.value;
      const pos = caretXY(padSegs(fw), doc.lines, doc.caret, padWidth);
      const x = g.x + FRAME + 4 + pos.x;
      const y = g.y + contentTop(chromeOpts(fw)) + 3 + pos.vrow * PAD_LINE_H - d.scroll.value;
      if (x !== lastCaret.x || y !== lastCaret.y) {
        lastCaret = { x, y, h: PAD_LINE_H };
        svc.send({ t: "caret", x, y, h: PAD_LINE_H });
      }
    }
  });

  // ---- render -------------------------------------------------------------

  return (
    <View class="absolute inset-0 bg-[#008080] overflow-hidden">
      <DesktopIcons icons={icons} selected={iconSel.value} />
      {wins.value.map((w) => (
        <Window98 win={w} active={focusId.value === w.id} />
      ))}
      {startOpen.value ? (
        <StartMenu x={2} y={startY()} h={startH()} items={startItems()} hover={startHover.value} />
      ) : null}
      {startOpen.value && startFly.value ? (
        <PopupPanel popup={startFly.value.popup} hover={flyHover.value} />
      ) : null}
      {popup.value ? <PopupPanel popup={popup.value.popup} hover={popupHover.value} /> : null}
      <Taskbar
        entries={taskEntries()}
        activeId={focusId.value}
        startOpen={startOpen.value}
        clock={clock.value}
        buttonW={taskButtonW()}
      />
    </View>
  );
}
