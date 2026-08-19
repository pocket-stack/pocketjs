// apps/desk98/programs.tsx — the window contents: Notepad, Minesweeper, the
// Explorer-style folder view, About and Shut Down dialogs. Presentational
// like chrome.tsx; each program also exports the content-local hit helpers
// app.tsx routes clicks through, so render geometry and hit geometry sit in
// one file. Content coordinates are (cx, cy) from wm.ts hitRegion — origin
// at the frame's inner top-left, below caption (and menu bar if present).

import { For, Index, Show, type Accessor, type JSX } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { T98 } from "./chrome.tsx";
import { FONT } from "./theme.ts";
import type { Doc } from "./notepad.ts";
import { MINES_W, type Mines } from "./mines.ts";

export function measure(s: string): number {
  const ops = getOps();
  return ops.measureText ? ops.measureText(s, FONT) : s.length * 7;
}

// ---------------------------------------------------------------------------
// Notepad
// ---------------------------------------------------------------------------

export const PAD_LINE_H = 16;
export const PAD_PAD = 3; // inset of the text from the white well

export interface PadData {
  kind: "notepad";
  doc: Accessor<Doc>;
  setDoc: (d: Doc) => void;
  scroll: Accessor<number>;
  setScroll: (y: number) => void;
  preedit: Accessor<{ s: string; c: number } | null>;
  setPreedit: (p: { s: string; c: number } | null) => void;
}

export function NotepadView(props: { data: PadData; active: boolean }): JSX.Element {
  const d = props.data;
  const caretRow = () => d.doc().caret.row;
  const caretX = () => {
    const doc = d.doc();
    const line = doc.lines[doc.caret.row] ?? "";
    const pre = d.preedit();
    const head = line.slice(0, doc.caret.col);
    return measure(pre ? head + pre.s.slice(0, pre.c) : head);
  };
  return (
    <View class="flex-1 flex-col bg-[#ffffff] bevel-[#808080,#ffffff,#000000,#dfdfdf] overflow-hidden">
      <View class="flex-1 relative overflow-hidden">
        <View
          class="absolute left-[3] top-[3] right-0 flex-col"
          style={{ translateY: -d.scroll() }}
        >
          <Index each={d.doc().lines}>
            {(line, row) => (
              <View class="h-[16] flex-row items-center">
                <Show
                  when={row === caretRow() && d.preedit() !== null}
                  fallback={<T98>{line()}</T98>}
                >
                  <T98>{line().slice(0, d.doc().caret.col)}</T98>
                  <View class="flex-col">
                    <T98>{d.preedit()?.s ?? ""}</T98>
                    <View class="h-[1] bg-[#000000]" />
                  </View>
                  <T98>{line().slice(d.doc().caret.col)}</T98>
                </Show>
              </View>
            )}
          </Index>
        </View>
        <Show when={props.active}>
          <View
            class="absolute w-[1] h-[14] bg-[#000000] animate-caret"
            style={{
              insetL: 0,
              insetT: 0,
              translateX: 3 + caretX(),
              translateY: 3 + caretRow() * PAD_LINE_H - d.scroll() + 1,
            }}
          />
        </Show>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Minesweeper — fixed-size window; all metrics in content-local px.
// ---------------------------------------------------------------------------

export const MINES_GEO = { w: 166, h: 227 } as const;
const M_PAD = 5; // content padding
const M_HEADER_H = 36;
const M_FIELD_TOP = M_PAD + M_HEADER_H + 6; // header + gap
const M_CELL = 16;
const M_CELLS_X = M_PAD + 3; // field bevel-w-[3] ring
const M_CELLS_Y = M_FIELD_TOP + 3;

export interface MinesData {
  kind: "mines";
  board: Accessor<Mines>;
  setBoard: (m: Mines) => void;
  /** Cell index held by the primary button, -1 none. */
  held: Accessor<number>;
  setHeld: (i: number) => void;
  smileyHeld: Accessor<boolean>;
  setSmileyHeld: (h: boolean) => void;
  /** Seconds shown by the timer (app.tsx advances it while playing). */
  elapsed: Accessor<number>;
  setElapsed: (s: number) => void;
}

export type MinesHit = { type: "cell"; i: number } | { type: "smiley" } | null;

export function minesHit(cx: number, cy: number): MinesHit {
  const sx = 160 / 2 - 13;
  if (cx >= sx && cx < sx + 26 && cy >= M_PAD + 5 && cy < M_PAD + 5 + 26) {
    return { type: "smiley" };
  }
  const x = Math.floor((cx - M_CELLS_X) / M_CELL);
  const y = Math.floor((cy - M_CELLS_Y) / M_CELL);
  if (x >= 0 && x < 9 && y >= 0 && y < 9) return { type: "cell", i: y * MINES_W + x };
  return null;
}

const NUM_COLORS = [
  "", // 0 unused
  "text-[#0000ff]",
  "text-[#008000]",
  "text-[#ff0000]",
  "text-[#000080]",
  "text-[#800000]",
  "text-[#008080]",
  "text-[#000000]",
  "text-[#808080]",
];

/** One 7-seg digit, 13×23, red on black. */
function Digit(props: { ch: Accessor<string> }): JSX.Element {
  //    a
  //  f   b        segments: bit 0..6 = a b c d e f g
  //    g
  //  e   c
  //    d
  const SEGS: Record<string, number> = {
    "0": 0b0111111,
    "1": 0b0000110,
    "2": 0b1011011,
    "3": 0b1001111,
    "4": 0b1100110,
    "5": 0b1101101,
    "6": 0b1111101,
    "7": 0b0000111,
    "8": 0b1111111,
    "9": 0b1101111,
    "-": 0b1000000,
    " ": 0,
  };
  const on = (bit: number) => ((SEGS[props.ch()] ?? 0) >> bit) & 1;
  const seg = (bit: number, cls: string, off: string) => (
    <View class={on(bit) ? cls : off} />
  );
  return (
    <View class="w-[13] h-[23] bg-[#000000] relative">
      {seg(0, "absolute left-[2] top-[1] w-[9] h-[2] bg-[#ff0000]", "absolute left-[2] top-[1] w-[9] h-[2] bg-[#3a0000]")}
      {seg(1, "absolute left-[10] top-[2] w-[2] h-[9] bg-[#ff0000]", "absolute left-[10] top-[2] w-[2] h-[9] bg-[#3a0000]")}
      {seg(2, "absolute left-[10] top-[12] w-[2] h-[9] bg-[#ff0000]", "absolute left-[10] top-[12] w-[2] h-[9] bg-[#3a0000]")}
      {seg(3, "absolute left-[2] top-[20] w-[9] h-[2] bg-[#ff0000]", "absolute left-[2] top-[20] w-[9] h-[2] bg-[#3a0000]")}
      {seg(4, "absolute left-[1] top-[12] w-[2] h-[9] bg-[#ff0000]", "absolute left-[1] top-[12] w-[2] h-[9] bg-[#3a0000]")}
      {seg(5, "absolute left-[1] top-[2] w-[2] h-[9] bg-[#ff0000]", "absolute left-[1] top-[2] w-[2] h-[9] bg-[#3a0000]")}
      {seg(6, "absolute left-[2] top-[10] w-[9] h-[3] bg-[#ff0000]", "absolute left-[2] top-[10] w-[9] h-[3] bg-[#3a0000]")}
    </View>
  );
}

function Counter(props: { value: Accessor<number> }): JSX.Element {
  const text = () => {
    const v = Math.max(-99, Math.min(999, Math.round(props.value())));
    return v < 0 ? "-" + String(-v).padStart(2, "0") : String(v).padStart(3, "0");
  };
  return (
    <View class="flex-row bevel-[#808080,#ffffff] p-[1] gap-0">
      <Digit ch={() => text()[0]} />
      <Digit ch={() => text()[1]} />
      <Digit ch={() => text()[2]} />
    </View>
  );
}

export function MinesView(props: { data: MinesData }): JSX.Element {
  const d = props.data;
  const smiley = () => {
    if (d.smileyHeld()) return "icons/smile.svg";
    const m = d.board();
    if (m.phase === "lost") return "icons/smile-dead.svg";
    if (m.phase === "won") return "icons/smile-cool.svg";
    if (d.held() >= 0) return "icons/smile-ooh.svg";
    return "icons/smile.svg";
  };
  return (
    <View class="flex-1 flex-col p-[5] bg-[#c0c0c0]">
      <View class="h-[36] flex-row items-center justify-between px-[5] bevel-[#808080,#ffffff] bevel-w-[2]">
        <Counter value={() => 10 - d.board().flags} />
        <View
          class={
            d.smileyHeld()
              ? "w-[26] h-[26] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#808080,#ffffff]"
              : "w-[26] h-[26] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#808080] bevel-w-[2]"
          }
        >
          <Image class="w-[16] h-[16]" src={smiley()} />
        </View>
        <Counter value={d.elapsed} />
      </View>
      <View class="h-[6]" />
      <View class="flex-col bevel-[#808080,#ffffff] bevel-w-[3] p-[3]">
        <Index each={ROWS9}>
          {(_, ry) => (
            <View class="flex-row">
              <Index each={ROWS9}>
                {(_, rx) => <MinesCell data={d} i={ry * MINES_W + rx} />}
              </Index>
            </View>
          )}
        </Index>
      </View>
    </View>
  );
}

const ROWS9 = Array.from({ length: MINES_W }, (_, i) => i);

function MinesCell(props: { data: MinesData; i: number }): JSX.Element {
  const c = () => props.data.board().cells[props.i];
  const bust = () => props.data.board().bust === props.i;
  const heldDown = () => props.data.held() === props.i && c().state === "hidden";
  return (
    <Show
      when={c().state === "revealed"}
      fallback={
        <View
          class={
            heldDown()
              ? "w-[16] h-[16] bg-[#c0c0c0] bevel-[#808080,#c0c0c0] flex-col justify-center items-center"
              : "w-[16] h-[16] bg-[#c0c0c0] bevel-[#ffffff,#808080] bevel-w-[2] flex-col justify-center items-center"
          }
        >
          <Show when={c().state === "flag"}>
            <Image class="w-[8] h-[8]" src="icons/flag.svg" />
          </Show>
        </View>
      }
    >
      <View
        class={
          bust()
            ? "w-[16] h-[16] bg-[#ff0000] bevel-[#808080,#ff0000] flex-col justify-center items-center"
            : "w-[16] h-[16] bg-[#c0c0c0] bevel-[#808080,#c0c0c0] flex-col justify-center items-center"
        }
      >
        <Show when={c().mine} fallback={
          <Show when={c().adj > 0}>
            <T98 bold class={NUM_COLORS[c().adj] || "text-[#000000]"}>
              {String(c().adj)}
            </T98>
          </Show>
        }>
          <Image class="w-[8] h-[8]" src="icons/mine.svg" />
        </Show>
      </View>
    </Show>
  );
}

// ---------------------------------------------------------------------------
// Folder (Explorer details view)
// ---------------------------------------------------------------------------

export const FOLDER_HEADER_H = 17;
export const FOLDER_ROW_H = 17;
export const FOLDER_STATUS_H = 20;

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
  selected: Accessor<number>;
  setSelected: (i: number) => void;
}

/** Row index for a content-local click inside the list, -1 none. */
export function folderRowAt(cy: number, rowCount: number): number {
  const i = Math.floor((cy - 1 - FOLDER_HEADER_H) / FOLDER_ROW_H);
  return i >= 0 && i < rowCount ? i : -1;
}

export function FolderView(props: { data: FolderData; active: boolean; resizable: boolean }): JSX.Element {
  const d = props.data;
  return (
    <View class="flex-1 flex-col">
      <View class="flex-1 flex-col bg-[#ffffff] bevel-[#808080,#ffffff,#000000,#dfdfdf] p-[1] overflow-hidden">
        <View class="h-[17] flex-row shrink-0">
          <View class="flex-1 flex-row items-center px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
            <T98>Name</T98>
          </View>
          <View class="w-[64] flex-row items-center justify-end px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
            <T98>Size</T98>
          </View>
          <View class="w-[104] flex-row items-center px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
            <T98>Type</T98>
          </View>
        </View>
        <For each={d.rows}>
          {(row, i) => (
            <View
              class={
                d.selected() === i()
                  ? "h-[17] flex-row items-center px-[2] bg-[#000080] shrink-0"
                  : "h-[17] flex-row items-center px-[2] shrink-0"
              }
            >
              <Image class="w-[16] h-[16] mr-[4]" src={row.icon} />
              <View class="flex-1 flex-row overflow-hidden">
                <T98 class={d.selected() === i() ? "text-[#ffffff]" : "text-[#000000]"}>
                  {row.name}
                </T98>
              </View>
              <View class="w-[60] flex-row justify-end">
                <T98 class={d.selected() === i() ? "text-[#ffffff]" : "text-[#000000]"}>
                  {row.size}
                </T98>
              </View>
              <View class="w-[100] flex-row pl-[6]">
                <T98 class={d.selected() === i() ? "text-[#ffffff]" : "text-[#000000]"}>
                  {row.type}
                </T98>
              </View>
            </View>
          )}
        </For>
        <Show when={d.rows.length === 0}>
          <View class="flex-1 flex-col justify-center items-center">
            <T98 class="text-[#808080]">(empty)</T98>
          </View>
        </Show>
      </View>
      <View class="h-[20] flex-row items-end gap-[2] pt-[2]">
        <View class="flex-1 h-[18] flex-row items-center px-[6] bevel-[#808080,#ffffff]">
          <T98>{`${d.rows.length} object(s)`}</T98>
        </View>
        <Show when={props.resizable}>
          <Image class="w-[16] h-[16]" src="icons/grip.svg" />
        </Show>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// About + Shut Down dialogs
// ---------------------------------------------------------------------------

export const ABOUT_GEO = { w: 340, h: 216 } as const;
export const SHUTDOWN_GEO = { w: 300, h: 176 } as const;

function Button98(props: { label: string; armed: boolean; def?: boolean }): JSX.Element {
  return (
    <View
      class={
        props.armed
          ? "w-[75] h-[23] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]"
          : "w-[75] h-[23] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
      }
    >
      <View class={props.armed ? "ml-[1] mt-[1]" : ""}>
        <T98>{props.label}</T98>
      </View>
    </View>
  );
}

export interface AboutData {
  kind: "about";
  armed: Accessor<string | null>;
}

/** Content-local button hits for the About dialog. */
export function aboutHit(contentW: number, contentH: number, cx: number, cy: number): "ok" | null {
  const x = contentW - 10 - 75;
  const y = contentH - 10 - 23;
  return cx >= x && cx < x + 75 && cy >= y && cy < y + 23 ? "ok" : null;
}

export function AboutView(props: { data: AboutData }): JSX.Element {
  return (
    <View class="flex-1 flex-col p-[10] gap-[8]">
      <View class="flex-row items-center gap-[10]">
        <Image class="w-[32] h-[32]" src="icons/computer.svg" />
        <T98 xl>PocketJS 98</T98>
      </View>
      <View class="h-[2] flex-col">
        <View class="h-[1] bg-[#808080]" />
        <View class="h-[1] bg-[#ffffff]" />
      </View>
      <T98>A desktop compositor demo on the gpui backend.</T98>
      <T98>Same DrawList contract the consoles boot; the</T98>
      <T98>windows, menus and shortcuts live in the guest.</T98>
      <T98 class="text-[#808080]">github.com/pocket-stack/pocketjs</T98>
      <View class="flex-1" />
      <View class="flex-row justify-end">
        <Button98 label="OK" armed={props.data.armed() === "ok"} def />
      </View>
    </View>
  );
}

export interface ShutdownData {
  kind: "shutdown";
  choice: Accessor<number>;
  setChoice: (i: number) => void;
  armed: Accessor<string | null>;
}

export type ShutdownHit = "ok" | "cancel" | "radio0" | "radio1" | null;

export function shutdownHit(
  contentW: number,
  contentH: number,
  cx: number,
  cy: number,
): ShutdownHit {
  const by = contentH - 10 - 23;
  const cancelX = contentW - 10 - 75;
  const okX = cancelX - 6 - 75;
  if (cy >= by && cy < by + 23) {
    if (cx >= okX && cx < okX + 75) return "ok";
    if (cx >= cancelX && cx < cancelX + 75) return "cancel";
  }
  for (const i of [0, 1]) {
    const ry = 46 + i * 20;
    if (cx >= 56 && cx < 220 && cy >= ry && cy < ry + 18) return i === 0 ? "radio0" : "radio1";
  }
  return null;
}

export function ShutdownView(props: { data: ShutdownData }): JSX.Element {
  const radio = (i: number, label: string) => (
    <View class="h-[20] flex-row items-center gap-[6]">
      <View class="w-[12] h-[12] rounded-full bg-[#808080] flex-col justify-center items-center">
        <View class="w-[10] h-[10] rounded-full bg-[#ffffff] flex-col justify-center items-center">
          <Show when={props.data.choice() === i}>
            <View class="w-[4] h-[4] rounded-full bg-[#000000]" />
          </Show>
        </View>
      </View>
      <T98>{label}</T98>
    </View>
  );
  return (
    <View class="flex-1 flex-col p-[10]">
      <View class="flex-row items-start gap-[10]">
        <Image class="w-[32] h-[32]" src="icons/shutdown.svg" />
        <View class="flex-col gap-[2]">
          <T98>What do you want the computer to do?</T98>
        </View>
      </View>
      <View class="h-[10]" />
      <View class="flex-col pl-[46]">
        {radio(0, "Shut down")}
        {radio(1, "Restart")}
      </View>
      <View class="flex-1" />
      <View class="flex-row justify-end gap-[6]">
        <Button98 label="OK" armed={props.data.armed() === "ok"} def />
        <Button98 label="Cancel" armed={props.data.armed() === "cancel"} />
      </View>
    </View>
  );
}
