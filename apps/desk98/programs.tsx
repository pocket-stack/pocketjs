// apps/desk98/programs.tsx — the window contents: Notepad (with selection),
// Minesweeper, the Explorer-style folder view, About and Shut Down dialogs.
// Vue Vapor JSX, presentational like chrome.tsx; each program also exports
// the content-local hit helpers app.tsx routes clicks through, so render
// geometry and hit geometry sit in one file. Content coordinates are
// (cx, cy) from wm.ts hitRegion — origin at the frame's inner top-left,
// below caption (and menu bar if present).

import { computed } from "vue";
import { Image, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { T98 } from "./chrome.tsx";
import { FONT, FRAME } from "./theme.ts";
import { caretXY, segSelSpan, segsFromBreaks, wrapLine, type VSeg } from "./notepad.ts";
import { MINES_W, type Cell } from "./mines.ts";
import type { AboutData, FolderData, MinesData, PadData, ShutdownData, WinCtl } from "./state.ts";

export function measure(s: string): number {
  const ops = getOps();
  return ops.measureText ? ops.measureText(s, FONT) : s.length * 7;
}

// ---------------------------------------------------------------------------
// Notepad
// ---------------------------------------------------------------------------

export const PAD_LINE_H = 16;
export const PAD_PAD = 3; // inset of the text from the white well

// Wrap math runs on every render, keystroke and pointer move, so word/prefix
// widths ride a bounded cache (advances are additive — a cached width is
// exact forever; the atlas never changes at runtime).
const widthCache = new Map<string, number>();

/** Cached slot-19 width — the `width` function every wrap helper takes. */
export function padWidth(s: string): number {
  if (s === "") return 0;
  let w = widthCache.get(s);
  if (w === undefined) {
    if (widthCache.size > 4096) widthCache.clear();
    w = measure(s);
    widthCache.set(s, w);
  }
  return w;
}

/** Wrap width for a notepad window: the content well minus the 3px text
 *  insets (mirrors NotepadView's left-[3] + right margin). Infinity when
 *  Word Wrap is off — every line becomes one visual segment. */
export function padWrapW(w: WinCtl): number {
  const d = w.data as PadData;
  return d.wrap.value ? Math.max(40, w.geo.value.w - FRAME * 2 - PAD_PAD * 2) : Infinity;
}

/** One line's visual segments: the host wrapText op when present (spec op
 *  43 — the platform half: core greedy over the slot's measure provider,
 *  gpui's LineWrapper for native-text apps), else the same greedy rules in
 *  JS over measureText. A parity test pins the two equal on baked hosts. */
function wrapLineHost(line: string, maxW: number): { from: number; to: number }[] {
  const ops = getOps();
  if (Number.isFinite(maxW) && ops.wrapText) {
    return segsFromBreaks(line.length, ops.wrapText(line, FONT, maxW));
  }
  return wrapLine(line, maxW, padWidth);
}

/** The whole document as visual segments through the host/fallback path. */
export function wrapDocHost(lines: string[], maxW: number): VSeg[] {
  const out: VSeg[] = [];
  for (let row = 0; row < lines.length; row++) {
    for (const s of wrapLineHost(lines[row], maxW)) out.push({ row, from: s.from, to: s.to });
  }
  return out;
}

/** The window's visual segments — the ONE layout both the render below and
 *  app.tsx hit-testing/caret movement read. */
export function padSegs(w: WinCtl): VSeg[] {
  const d = w.data as PadData;
  return wrapDocHost(d.doc.value.lines, padWrapW(w));
}

export function NotepadView(props: { data: PadData; wrapW: number; active: boolean }) {
  const d = props.data;
  const segsAll = () => wrapDocHost(d.doc.value.lines, props.wrapW);
  const caretPos = () => caretXY(segsAll(), d.doc.value.lines, d.doc.value.caret, padWidth);
  const caretX = () => {
    const pre = d.preedit.value;
    return caretPos().x + (pre ? padWidth(pre.s.slice(0, pre.c)) : 0);
  };
  /** Visual-segment text split at the selection edges. */
  const parts = (seg: VSeg): { t: string; sel: boolean }[] => {
    const line = d.doc.value.lines[seg.row];
    const span = segSelSpan(d.doc.value, seg);
    if (!span) return [{ t: line.slice(seg.from, seg.to), sel: false }];
    return [
      { t: line.slice(seg.from, span.from), sel: false },
      { t: line.slice(span.from, span.to), sel: true },
      { t: line.slice(span.to, seg.to), sel: false },
    ];
  };
  return (
    <View class="flex-1 flex-col bg-[#ffffff] bevel-[#808080,#ffffff,#000000,#dfdfdf] overflow-hidden">
      <View class="flex-1 relative overflow-hidden">
        <View
          class="absolute left-[3] top-[3] right-0 flex-col"
          style={{ translateY: -d.scroll.value }}
        >
          {segsAll().map((seg, vi) => (
            <View class="h-[16] flex-row items-center">
              {vi === caretPos().vrow && d.preedit.value ? (
                [
                  <T98 t={d.doc.value.lines[seg.row].slice(seg.from, d.doc.value.caret.col)} />,
                  <View class="flex-col">
                    <T98 t={d.preedit.value.s} />
                    <View class="h-[1] bg-[#000000]" />
                  </View>,
                  <T98 t={d.doc.value.lines[seg.row].slice(d.doc.value.caret.col, seg.to)} />,
                ]
              ) : (
                parts(seg).map((p) =>
                  p.sel ? (
                    <View class="bg-[#000080] flex-row">
                      <T98 cls="text-[#ffffff]" t={p.t} />
                    </View>
                  ) : (
                    <T98 t={p.t} />
                  ),
                )
              )}
            </View>
          ))}
        </View>
        {props.active ? (
          <View
            class="absolute w-[1] h-[14] bg-[#000000] animate-caret"
            style={{
              insetL: 0,
              insetT: 0,
              translateX: 3 + caretX(),
              translateY: 3 + caretPos().vrow * PAD_LINE_H - d.scroll.value + 1,
            }}
          />
        ) : null}
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

/** One 7-seg digit, 13×23, red on black.
 *     a
 *   f   b        segments: bit 0..6 = a b c d e f g
 *     g
 *   e   c
 *     d
 */
function Digit(props: { ch: string }) {
  const on = (bit: number) => (((SEGS[props.ch] ?? 0) >> bit) & 1) === 1;
  return (
    <View class="w-[13] h-[23] bg-[#000000] relative">
      <View class={on(0) ? "absolute left-[2] top-[1] w-[9] h-[2] bg-[#ff0000]" : "absolute left-[2] top-[1] w-[9] h-[2] bg-[#3a0000]"} />
      <View class={on(1) ? "absolute left-[10] top-[2] w-[2] h-[9] bg-[#ff0000]" : "absolute left-[10] top-[2] w-[2] h-[9] bg-[#3a0000]"} />
      <View class={on(2) ? "absolute left-[10] top-[12] w-[2] h-[9] bg-[#ff0000]" : "absolute left-[10] top-[12] w-[2] h-[9] bg-[#3a0000]"} />
      <View class={on(3) ? "absolute left-[2] top-[20] w-[9] h-[2] bg-[#ff0000]" : "absolute left-[2] top-[20] w-[9] h-[2] bg-[#3a0000]"} />
      <View class={on(4) ? "absolute left-[1] top-[12] w-[2] h-[9] bg-[#ff0000]" : "absolute left-[1] top-[12] w-[2] h-[9] bg-[#3a0000]"} />
      <View class={on(5) ? "absolute left-[1] top-[2] w-[2] h-[9] bg-[#ff0000]" : "absolute left-[1] top-[2] w-[2] h-[9] bg-[#3a0000]"} />
      <View class={on(6) ? "absolute left-[2] top-[10] w-[9] h-[3] bg-[#ff0000]" : "absolute left-[2] top-[10] w-[9] h-[3] bg-[#3a0000]"} />
    </View>
  );
}

/** Three-digit 7-seg counter (mine count / timer), clamped to -99..999. */
function Counter(props: { value: number }) {
  const text = computed(() => {
    const v = Math.max(-99, Math.min(999, Math.round(props.value)));
    return v < 0 ? "-" + String(-v).padStart(2, "0") : String(v).padStart(3, "0");
  });
  return (
    <View class="flex-row bevel-[#808080,#ffffff] p-[1] gap-0">
      <Digit ch={text.value[0]} />
      <Digit ch={text.value[1]} />
      <Digit ch={text.value[2]} />
    </View>
  );
}

/** One field cell: raised while hidden, flat when revealed (red on the bust
 *  mine), flag/mine art, colored adjacency digit. */
function MinesCell(props: { data: MinesData; i: number }) {
  const c = (): Cell => props.data.board.value.cells[props.i];
  const heldDown = () => props.data.held.value === props.i && c().state === "hidden";
  // The hidden/revealed swap must sit in a JSX child position — a bare
  // ternary returned from the component body evaluates once at setup.
  return (
    <View class="w-[16] h-[16] relative">
      {c().state !== "revealed" ? (
        <View
          class={
            heldDown()
              ? "absolute inset-0 bg-[#c0c0c0] bevel-[#808080,#c0c0c0] flex-col justify-center items-center"
              : "absolute inset-0 bg-[#c0c0c0] bevel-[#ffffff,#808080] bevel-w-[2] flex-col justify-center items-center"
          }
        >
          {c().state === "flag" ? <Image class="w-[8] h-[8]" src="icons/flag.svg" /> : null}
        </View>
      ) : (
        <View
          class={
            props.data.board.value.bust === props.i
              ? "absolute inset-0 bg-[#ff0000] bevel-[#808080,#ff0000] flex-col justify-center items-center"
              : "absolute inset-0 bg-[#c0c0c0] bevel-[#808080,#c0c0c0] flex-col justify-center items-center"
          }
        >
          {c().mine ? (
            <Image class="w-[8] h-[8]" src="icons/mine.svg" />
          ) : c().adj > 0 ? (
            <T98 bold cls={NUM_COLORS[c().adj] || "text-[#000000]"} t={String(c().adj)} />
          ) : null}
        </View>
      )}
    </View>
  );
}

const ROWS9 = Array.from({ length: MINES_W }, (_, i) => i);

/** Minesweeper content: sunken header (mine counter, smiley, timer) over the
 *  9×9 field. The grid rides static index arrays — the board ref retriggers
 *  cell reads, rows never move. */
export function MinesView(props: { data: MinesData }) {
  const d = props.data;
  const smiley = () => {
    if (d.smileyHeld.value) return "icons/smile.svg";
    const m = d.board.value;
    if (m.phase === "lost") return "icons/smile-dead.svg";
    if (m.phase === "won") return "icons/smile-cool.svg";
    if (d.held.value >= 0) return "icons/smile-ooh.svg";
    return "icons/smile.svg";
  };
  return (
    <View class="flex-1 flex-col p-[5] bg-[#c0c0c0]">
      <View class="h-[36] flex-row items-center justify-between px-[5] bevel-[#808080,#ffffff] bevel-w-[2]">
        <Counter value={10 - d.board.value.flags} />
        <View
          class={
            d.smileyHeld.value
              ? "w-[26] h-[26] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#808080,#ffffff]"
              : "w-[26] h-[26] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#808080] bevel-w-[2]"
          }
        >
          <Image class="w-[16] h-[16]" src={smiley()} />
        </View>
        <Counter value={d.elapsed.value} />
      </View>
      <View class="h-[6]" />
      <View class="flex-col bevel-[#808080,#ffffff] bevel-w-[3] p-[3]">
        {ROWS9.map((ry) => (
          <View class="flex-row">
            {ROWS9.map((rx) => (
              <MinesCell data={d} i={ry * MINES_W + rx} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Folder (Explorer details view)
// ---------------------------------------------------------------------------

export const FOLDER_HEADER_H = 17;
export const FOLDER_ROW_H = 17;
export const FOLDER_STATUS_H = 20;

/** Row index for a content-local click inside the list, -1 none. */
export function folderRowAt(cy: number, rowCount: number): number {
  const i = Math.floor((cy - 1 - FOLDER_HEADER_H) / FOLDER_ROW_H);
  return i >= 0 && i < rowCount ? i : -1;
}

export function FolderView(props: { data: FolderData; resizable: boolean }) {
  const d = props.data;
  return (
    <View class="flex-1 flex-col">
      <View class="flex-1 flex-col bg-[#ffffff] bevel-[#808080,#ffffff,#000000,#dfdfdf] p-[1] overflow-hidden">
        <View class="h-[17] flex-row shrink-0">
          <View class="flex-1 flex-row items-center px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
            <T98 t="Name" />
          </View>
          <View class="w-[64] flex-row items-center justify-end px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
            <T98 t="Size" />
          </View>
          <View class="w-[104] flex-row items-center px-[6] bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]">
            <T98 t="Type" />
          </View>
        </View>
        {d.rows.map((row, i) => (
          <View
            class={
              d.selected.value === i
                ? "h-[17] flex-row items-center px-[2] bg-[#000080] shrink-0"
                : "h-[17] flex-row items-center px-[2] shrink-0"
            }
          >
            <Image class="w-[16] h-[16] mr-[4]" src={row.icon} />
            <View class="flex-1 flex-row overflow-hidden">
              <T98 cls={d.selected.value === i ? "text-[#ffffff]" : "text-[#000000]"} t={row.name} />
            </View>
            <View class="w-[60] flex-row justify-end">
              <T98 cls={d.selected.value === i ? "text-[#ffffff]" : "text-[#000000]"} t={row.size} />
            </View>
            <View class="w-[100] flex-row pl-[6]">
              <T98 cls={d.selected.value === i ? "text-[#ffffff]" : "text-[#000000]"} t={row.type} />
            </View>
          </View>
        ))}
        {d.rows.length === 0 ? (
          <View class="flex-1 flex-col justify-center items-center">
            <T98 cls="text-[#808080]" t="(empty)" />
          </View>
        ) : null}
      </View>
      <View class="h-[20] flex-row items-end gap-[2] pt-[2]">
        <View class="flex-1 h-[18] flex-row items-center px-[6] bevel-[#808080,#ffffff]">
          <T98 t={`${d.rows.length} object(s)`} />
        </View>
        {props.resizable ? <Image class="w-[16] h-[16]" src="icons/grip.svg" /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// About + Shut Down dialogs
// ---------------------------------------------------------------------------

export const ABOUT_GEO = { w: 340, h: 216 } as const;
export const SHUTDOWN_GEO = { w: 300, h: 176 } as const;

/** Dialog push button; armed = pressed bevel + 1px content nudge. */
function Button98(props: { label: string; armed: boolean }) {
  return (
    <View
      class={
        props.armed
          ? "w-[75] h-[23] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#000000,#ffffff,#808080,#dfdfdf]"
          : "w-[75] h-[23] flex-col justify-center items-center bg-[#c0c0c0] bevel-[#ffffff,#000000,#dfdfdf,#808080]"
      }
    >
      <View class={props.armed ? "ml-[1] mt-[1]" : ""}>
        <T98 t={props.label} />
      </View>
    </View>
  );
}

/** Content-local button hits for the About dialog. */
export function aboutHit(contentW: number, contentH: number, cx: number, cy: number): "ok" | null {
  const x = contentW - 10 - 75;
  const y = contentH - 10 - 23;
  return cx >= x && cx < x + 75 && cy >= y && cy < y + 23 ? "ok" : null;
}

export function AboutView(props: { data: AboutData }) {
  return (
    <View class="flex-1 flex-col p-[10] gap-[8]">
      <View class="flex-row items-center gap-[10]">
        <Image class="w-[32] h-[32]" src="icons/computer.svg" />
        <T98 xl t="PocketJS 98" />
      </View>
      <View class="h-[2] flex-col">
        <View class="h-[1] bg-[#808080]" />
        <View class="h-[1] bg-[#ffffff]" />
      </View>
      <T98 t="A desktop compositor demo on the gpui backend." />
      <T98 t="Vue Vapor JSX over the same DrawList the" />
      <T98 t="consoles boot; windows, menus and shortcuts" />
      <T98 t="live in the guest." />
      <T98 cls="text-[#808080]" t="github.com/pocket-stack/pocketjs" />
      <View class="flex-1" />
      <View class="flex-row justify-end">
        <Button98 label="OK" armed={props.data.armed.value === "ok"} />
      </View>
    </View>
  );
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

export function ShutdownView(props: { data: ShutdownData }) {
  const radio = (i: number, label: string) => (
    <View class="h-[20] flex-row items-center gap-[6]">
      <View class="w-[12] h-[12] rounded-full bg-[#808080] flex-col justify-center items-center">
        <View class="w-[10] h-[10] rounded-full bg-[#ffffff] flex-col justify-center items-center">
          {props.data.choice.value === i ? (
            <View class="w-[4] h-[4] rounded-full bg-[#000000]" />
          ) : null}
        </View>
      </View>
      <T98 t={label} />
    </View>
  );
  return (
    <View class="flex-1 flex-col p-[10]">
      <View class="flex-row items-start gap-[10]">
        <Image class="w-[32] h-[32]" src="icons/shutdown.svg" />
        <View class="flex-col gap-[2]">
          <T98 t="What do you want the computer to do?" />
        </View>
      </View>
      <View class="h-[10]" />
      <View class="flex-col pl-[46]">
        {radio(0, "Shut down")}
        {radio(1, "Restart")}
      </View>
      <View class="flex-1" />
      <View class="flex-row justify-end gap-[6]">
        <Button98 label="OK" armed={props.data.armed.value === "ok"} />
        <Button98 label="Cancel" armed={props.data.armed.value === "cancel"} />
      </View>
    </View>
  );
}
