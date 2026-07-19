// demos/note/app.tsx — Pocket Note: a markdown widget as a PocketJS app.
//
// Two modes over one string document. View mode renders parsed markdown as
// measured, absolutely-positioned rows (layout.ts) behind a manual virtual
// scroll — the IM thread contract: an untransformed overflow-hidden clip
// around a translateY canvas that mounts only the visible slice. Edit mode
// soft-wraps the raw source (editor.ts) with a real caret, drag selection
// and an undo/redo stack. The desktop host feeds keys/mouse/resizes through
// the svc channel (svc.ts) and synthesizes CIRCLE for clicks, so
// hover-focus + the stock onPress pipeline dispatch the chrome (toggle,
// menu) while content pointer gestures (caret, drag-select) ride the svc
// mouse stream directly; on hosts without svc (PSP, sim, goldens) the app
// is a read-only note scrolled by d-pad — unmodified-app base case.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Focusable, Portal, Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN, focusNode, hitFocusable } from "@pocketjs/framework/input";
import { resizeViewport, type NodeMirror } from "@pocketjs/framework";
import { parseMarkdown } from "./markdown.ts";
import {
  BODY_LINE_H,
  bodyWidth,
  EDGE_PAD,
  layoutBlocks,
  textWidth,
  type Seg,
  type ViewRow,
} from "./layout.ts";
import {
  backspaceSel,
  breakRun,
  caretFromX,
  caretLine,
  caretX,
  deleteSel,
  emptyHistory,
  layoutDoc,
  lineEnd,
  lineStart,
  moveVertical,
  recordEdit,
  redo,
  selBounds,
  typeText,
  undo,
  type EditKind,
  type SelEdit,
} from "./editor.ts";
import {
  cmpPos,
  rowChFromX,
  rowFromY,
  rowSelSpan,
  selectedText,
  type RowPos,
} from "./select.ts";
import { connectSvc, type HostEvent } from "./svc.ts";
import { SAMPLE_DOC } from "./sample.ts";

const HEADER_H = 30;
/** Minimum side padding of the content column. */
const PAD_X = 22;
/** The content column stops growing here and centers (markdown-app feel). */
const MAX_CONTENT_W = 560;
const OVERSCAN = 40;
const SCROLL_STEP = 40; //  d-pad / PageUp step base
const SAVE_DEBOUNCE = 45; // ticks (~0.75 s) after the last edit
const CARET_H = 16;
/** Pointer movement (logical px) that turns a press into a drag. */
const DRAG_SLOP = 3;

// Theme ink. Class literals carry fonts/geometry; colors ride inline so
// both themes share one compiled style table.
const INK = {
  dark: {
    body: "#d7dee7",
    dim: "#7e8994",
    accent: "#6fb3ff",
    em: "#b9cbdf",
    code: "#95d79d",
    codeBg: "#19212b",
    quote: "#a8b3c0",
    bar: "#3a4450",
    hr: "#232b34",
    thumb: "#414d5b",
    header: "#8d98a5",
    sel: "#2a4a6e",
    chrome: "#1a212b",
  },
  light: {
    body: "#272b31",
    dim: "#8b9199",
    accent: "#1c6fd2",
    em: "#4a5d75",
    code: "#20713a",
    codeBg: "#f0efe9",
    quote: "#5d6672",
    bar: "#d9d6cb",
    hr: "#e6e4dc",
    thumb: "#c9c6bb",
    header: "#6f7680",
    sel: "#cfe3fb",
    chrome: "#eceade",
  },
};

type Ink = (typeof INK)["dark"];

function segFontClass(seg: Seg): string {
  switch (seg.slot) {
    case 12:
      return "absolute text-2xl font-bold";
    case 11:
      return "absolute text-xl font-bold";
    case 10:
      return "absolute text-lg font-bold";
    case 8:
      return "absolute text-sm font-bold";
    default:
      return "absolute text-sm";
  }
}

function segColor(seg: Seg, ink: Ink): string {
  switch (seg.style) {
    case "code":
      return ink.code;
    case "link":
      return ink.accent;
    case "em":
      return ink.em;
    case "marker":
      return ink.dim;
    default:
      return ink.body;
  }
}

export default function Note(): ReturnType<typeof View> {
  const svc = connectSvc();
  const [vp, setVp] = createSignal({ w: 480, h: 272 });
  const [doc, setDoc] = createSignal(SAMPLE_DOC);
  const [editing, setEditing] = createSignal(false);
  const [dark, setDark] = createSignal(true);
  const [menuOpen, setMenuOpenRaw] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [anchor, setAnchor] = createSignal(0);
  const [vsel, setVsel] = createSignal<{ start: RowPos; end: RowPos } | null>(null);
  const [scrollV, setScrollV] = createSignal(0);
  const [scrollE, setScrollE] = createSignal(0);
  const [mouse, setMouse] = createSignal({ x: -1, y: -1 });

  const ink = () => (dark() ? INK.dark : INK.light);
  const contentW = () => Math.min(vp().w - PAD_X * 2, MAX_CONTENT_W);
  /** Left edge of the centered content column. */
  const marginX = () => Math.max(PAD_X, (vp().w - contentW()) / 2);
  const viewH = () => vp().h - HEADER_H;

  /** The host gates its header-drag/resize claims while the menu is up
   *  (otherwise a click on the header starts a window drag instead of
   *  reaching the backdrop to close the menu). */
  const setMenuOpen = (open: boolean) => {
    if (open !== menuOpen()) svc?.send({ t: "menu", open });
    setMenuOpenRaw(open);
  };

  // ---- view layout -------------------------------------------------------
  const viewLayout = createMemo(() => layoutBlocks(parseMarkdown(doc()), contentW()));
  const maxScrollV = () => Math.max(0, viewLayout().total - viewH());
  const visibleRows = createMemo(() => {
    const top = scrollV() - OVERSCAN;
    const bottom = scrollV() + viewH() + OVERSCAN;
    const out: { row: ViewRow; i: number }[] = [];
    const rows = viewLayout().rows;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.y < bottom && r.y + r.h > top) out.push({ row: r, i });
    }
    return out;
  });

  // ---- edit layout -------------------------------------------------------
  const dlines = createMemo(() => layoutDoc(doc(), contentW(), bodyWidth));
  const editTotal = () => dlines().length * BODY_LINE_H + EDGE_PAD * 2;
  const maxScrollE = () => Math.max(0, editTotal() - viewH());
  const visibleLines = createMemo(() => {
    const lines = dlines();
    const from = Math.max(0, Math.floor((scrollE() - OVERSCAN - EDGE_PAD) / BODY_LINE_H));
    const to = Math.min(
      lines.length,
      Math.ceil((scrollE() + viewH() + OVERSCAN - EDGE_PAD) / BODY_LINE_H),
    );
    const out: { index: number; start: number; end: number; soft: boolean }[] = [];
    for (let i = from; i < to; i++) {
      out.push({ index: i, start: lines[i].start, end: lines[i].end, soft: lines[i].soft });
    }
    return out;
  });
  const caretRow = () => caretLine(dlines(), caret());
  const caretPx = () => caretX(doc(), dlines(), caret(), bodyWidth);
  /** Normalized selection bounds, null when collapsed. */
  const editSel = () => {
    if (caret() === anchor()) return null;
    const [lo, hi] = selBounds({ doc: doc(), caret: caret(), anchor: anchor() });
    return { lo, hi };
  };

  // ---- edits + history ---------------------------------------------------
  const history = emptyHistory();
  let goalX = 0;
  let goalSticky = false;
  let saveIn = -1;
  let lastHover: NodeMirror | null = null;
  /** Re-run hover→focus next frame (a mode switch remounted the target). */
  let rehover = false;

  const markDirty = () => {
    saveIn = SAVE_DEBOUNCE;
  };
  const save = () => {
    saveIn = -1;
    svc?.send({ t: "save", text: doc() });
  };
  const revealCaret = () => {
    const y = EDGE_PAD + caretRow() * BODY_LINE_H;
    if (y < scrollE() + 4) setScrollE(Math.max(0, y - 4));
    else if (y + BODY_LINE_H > scrollE() + viewH() - 4) {
      setScrollE(Math.min(maxScrollE(), y + BODY_LINE_H - viewH() + 4));
    }
  };
  const selState = (): SelEdit => ({ doc: doc(), caret: caret(), anchor: anchor() });
  const applyState = (s: SelEdit) => {
    if (s.doc !== doc()) {
      setDoc(s.doc);
      markDirty();
    }
    setCaret(s.caret);
    setAnchor(s.anchor);
  };
  /** One undoable mutation: snapshot, apply, reveal. */
  const mutate = (kind: EditKind, fn: (s: SelEdit) => SelEdit) => {
    const before = selState();
    const next = fn(before);
    if (next.doc !== before.doc) recordEdit(history, before, kind);
    applyState(next);
    goalSticky = false;
    revealCaret();
  };
  /** Collapse-or-move for plain arrows: a selection collapses to its edge. */
  const collapseOr = (edge: "lo" | "hi", move: (s: SelEdit) => number) => {
    const s = selState();
    const [lo, hi] = selBounds(s);
    const pos = s.caret === s.anchor ? move(s) : edge === "lo" ? lo : hi;
    setCaret(pos);
    setAnchor(pos);
    breakRun(history);
    goalSticky = false;
    revealCaret();
  };
  const applyUndoRedo = (fn: typeof undo) => {
    if (!editing()) return;
    const state = fn(history, selState());
    if (!state) return;
    applyState(state);
    markDirty();
    goalSticky = false;
    revealCaret();
  };

  const enterEdit = (offset: number) => {
    setMenuOpen(false);
    setVsel(null);
    const pos = Math.max(0, Math.min(offset, doc().length));
    setCaret(pos);
    setAnchor(pos);
    breakRun(history);
    // Keep roughly the same place on screen across the mode switch.
    const y = EDGE_PAD + caretLine(dlines(), pos) * BODY_LINE_H;
    setScrollE(Math.max(0, Math.min(maxScrollE(), y - viewH() / 3)));
    setEditing(true);
    goalSticky = false;
    rehover = true;
  };
  const leaveEdit = () => {
    setEditing(false);
    if (saveIn > 0) save();
    setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV())));
    rehover = true;
  };

  const handleKey = (k: string) => {
    if (k === "Escape") {
      if (menuOpen()) setMenuOpen(false);
      else if (!editing() && vsel()) setVsel(null);
      else if (editing() && editSel()) collapseOr("hi", (s) => s.caret);
      else if (editing()) leaveEdit();
      return;
    }
    if (k === "Copy") {
      const text = editing()
        ? (() => {
            const sel = editSel();
            return sel ? doc().slice(sel.lo, sel.hi) : "";
          })()
        : (() => {
            const sel = vsel();
            return sel ? selectedText(viewLayout().rows, sel.start, sel.end) : "";
          })();
      if (text !== "") svc?.send({ t: "copy", text });
      return;
    }
    if (k === "Cut") {
      const sel = editSel();
      if (editing() && sel) {
        svc?.send({ t: "copy", text: doc().slice(sel.lo, sel.hi) });
        mutate("other", (s) => typeText(s, ""));
      }
      return;
    }
    if (k === "Undo") {
      applyUndoRedo(undo);
      return;
    }
    if (k === "Redo") {
      applyUndoRedo(redo);
      return;
    }
    if (!editing()) {
      // View mode: keyboard scrolls.
      const step =
        k === "Up" ? -SCROLL_STEP : k === "Down" ? SCROLL_STEP : k === "PageUp" ? -viewH() : k === "PageDown" ? viewH() : k === "Home" ? -1e9 : k === "End" ? 1e9 : 0;
      if (step !== 0) setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV() + step)));
      return;
    }
    switch (k) {
      case "Backspace":
        mutate("delete", backspaceSel);
        break;
      case "Delete":
        mutate("delete", deleteSel);
        break;
      case "Enter":
        mutate("other", (s) => typeText(s, "\n"));
        break;
      case "Tab":
        mutate("other", (s) => typeText(s, "  "));
        break;
      case "Left":
        collapseOr("lo", (s) => Math.max(0, s.caret - 1));
        break;
      case "Right":
        collapseOr("hi", (s) => Math.min(s.doc.length, s.caret + 1));
        break;
      case "Home":
        collapseOr("lo", (s) => lineStart(dlines(), s.caret));
        break;
      case "End":
        collapseOr("hi", (s) => lineEnd(dlines(), s.caret));
        break;
      case "Up":
      case "Down": {
        if (!goalSticky) {
          goalX = caretPx();
          goalSticky = true;
        }
        const next = moveVertical(doc(), dlines(), caret(), k === "Up" ? -1 : 1, goalX, bodyWidth);
        setCaret(next);
        setAnchor(next);
        breakRun(history);
        goalSticky = true;
        revealCaret();
        break;
      }
      case "PageUp":
      case "PageDown":
        setScrollE(
          Math.max(0, Math.min(maxScrollE(), scrollE() + (k === "PageUp" ? -viewH() : viewH()))),
        );
        break;
    }
  };

  // ---- pointer gestures over the content (svc mouse stream) --------------
  // Chrome (toggle, menu) rides the framework's hover-focus + CIRCLE press;
  // content needs press/drag/release, which BTN bits can't carry.
  let press: { x: number; y: number; dragged: boolean; content: boolean } | null = null;
  let pvAnchor: RowPos | null = null;
  let prevDown = false;

  const editPosAt = (x: number, y: number): number => {
    const line = Math.floor((y - HEADER_H + scrollE() - EDGE_PAD) / BODY_LINE_H);
    return caretFromX(doc(), dlines(), line, x - marginX(), bodyWidth);
  };
  const viewPosAt = (x: number, y: number): RowPos => {
    const rows = viewLayout().rows;
    const row = rowFromY(rows, y - HEADER_H + scrollV());
    return { row, ch: rows.length ? rowChFromX(rows[row], x - marginX(), textWidth) : 0 };
  };

  const pointerDown = (x: number, y: number) => {
    const content = y >= HEADER_H && !menuOpen();
    press = { x, y, dragged: false, content };
    if (!content) return;
    if (editing()) {
      const pos = editPosAt(x, y);
      setCaret(pos);
      setAnchor(pos);
      breakRun(history);
      goalSticky = false;
    } else {
      setVsel(null);
      pvAnchor = viewPosAt(x, y);
    }
  };
  const pointerMove = (x: number, y: number, down: boolean) => {
    if (!down || !press || !press.content) return;
    if (!press.dragged && Math.abs(x - press.x) + Math.abs(y - press.y) < DRAG_SLOP) return;
    press.dragged = true;
    if (editing()) {
      setCaret(editPosAt(x, y)); // anchor stays: the selection
      revealCaret();
    } else if (pvAnchor) {
      const here = viewPosAt(x, y);
      const [start, end] = cmpPos(pvAnchor, here) <= 0 ? [pvAnchor, here] : [here, pvAnchor];
      setVsel({ start, end });
    }
  };
  const pointerUp = (_x: number, _y: number) => {
    // Preview clicks are inert (a markdown preview doesn't react to
    // clicks — the I-beam toggle and the menu enter edit mode); the
    // pointer-down already placed the caret / cleared the selection.
    press = null;
    pvAnchor = null;
  };

  const handleEvent = (ev: HostEvent) => {
    switch (ev.t) {
      case "hello":
      case "resize":
        setVp({ w: ev.w ?? 480, h: ev.h ?? 272 });
        resizeViewport(ev.w ?? 480, ev.h ?? 272);
        setVsel(null); // row geometry changed under the selection
        setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV())));
        setScrollE(Math.max(0, Math.min(maxScrollE(), scrollE())));
        break;
      case "load":
        setDoc(ev.text ?? "");
        setCaret(0);
        setAnchor(0);
        setVsel(null);
        history.past.length = 0;
        history.future.length = 0;
        history.last = null;
        saveIn = -1;
        break;
      case "ch":
        if (editing() && ev.s) mutate("type", (s) => typeText(s, ev.s!));
        break;
      case "paste":
        if (editing() && ev.text) mutate("other", (s) => typeText(s, ev.text!));
        break;
      case "key":
        if (ev.k) handleKey(ev.k);
        break;
      case "mouse": {
        const p = { x: ev.x ?? -1, y: ev.y ?? -1 };
        const down = ev.d ?? false;
        setMouse(p);
        if (down && !prevDown) pointerDown(p.x, p.y);
        else if (down) pointerMove(p.x, p.y, true);
        if (!down && prevDown) pointerUp(p.x, p.y);
        prevDown = down;
        const n = hitFocusable(p.x, p.y);
        if (n && n !== lastHover) focusNode(n);
        lastHover = n;
        break;
      }
      case "scroll": {
        const dy = ev.dy ?? 0;
        if (editing()) setScrollE(Math.max(0, Math.min(maxScrollE(), scrollE() - dy)));
        else setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV() - dy)));
        break;
      }
    }
  };

  onFrame(() => {
    if (saveIn > 0 && --saveIn === 0) save();
    if (!svc) return;
    for (const ev of svc.poll()) handleEvent(ev);
    if (rehover) {
      // The frame after a mode switch: the node under the pointer was
      // remounted, so hover-focus it again without waiting for a move.
      rehover = false;
      const m = mouse();
      if (m.x >= 0) {
        const n = hitFocusable(m.x, m.y);
        if (n) focusNode(n);
        lastHover = n;
      }
    }
  });

  // Button-only hosts (PSP, sim): d-pad scrolls the rendered note.
  onButtonPress(BTN.UP, () => {
    if (!svc) setScrollV(Math.max(0, scrollV() - SCROLL_STEP));
  });
  onButtonPress(BTN.DOWN, () => {
    if (!svc) setScrollV(Math.min(maxScrollV(), scrollV() + SCROLL_STEP));
  });

  // ---- render ------------------------------------------------------------
  const thumbH = (total: number) => Math.max(24, (viewH() * viewH()) / total);
  const scrollbar = (scroll: number, total: number) => (
    <Show when={total > viewH()}>
      <View
        class="absolute rounded-sm"
        style={{
          width: 3,
          insetR: 3,
          insetT: (scroll / (total - viewH())) * (viewH() - thumbH(total) - 8) + 4,
          height: thumbH(total),
          bgColor: ink().thumb,
        }}
      />
    </Show>
  );

  /** Edit-mode selection rect for one display line, null outside. */
  const lineSelRect = (line: { index: number; start: number; end: number }) => {
    const sel = editSel();
    if (!sel) return null;
    const lo = Math.max(sel.lo, line.start);
    const hi = Math.min(sel.hi, line.end);
    if (hi < lo) return null;
    if (hi === lo && !(sel.lo < line.start && sel.hi > line.end)) return null;
    const x0 = bodyWidth(doc().slice(line.start, lo));
    const x1 = bodyWidth(doc().slice(line.start, hi));
    // A fully-selected empty line still shows a sliver (the newline).
    return { x0, x1: Math.max(x1, x0 + (hi === line.end && sel.hi > line.end ? 4 : 0)) };
  };

  return (
    <View
      class={
        dark()
          ? "flex-col w-full h-full rounded-xl overflow-hidden bg-[#11151b]"
          : "flex-col w-full h-full rounded-xl overflow-hidden bg-[#fbfaf6]"
      }
    >
      {/* Header: the host's drag region (everything left of the buttons). */}
      <View class="flex-row items-center gap-2 px-3" style={{ height: HEADER_H }}>
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: ink().header }}>
          POCKET NOTE
        </Text>
        <View class="flex-1" />
        {/* Preview/edit segmented toggle. */}
        <View class="flex-row rounded-md p-[2] gap-[2]" style={{ bgColor: ink().chrome }}>
          <ToggleSeg
            active={() => !editing()}
            ink={ink}
            dark={dark}
            onPress={() => {
              if (editing()) leaveEdit();
            }}
          >
            <EyeIcon color={() => (!editing() ? ink().accent : ink().dim)} bg={ink} dark={dark} />
          </ToggleSeg>
          <ToggleSeg
            active={editing}
            ink={ink}
            dark={dark}
            onPress={() => {
              if (!editing()) enterEdit(caret());
            }}
          >
            <IBeamIcon color={() => (editing() ? ink().accent : ink().dim)} />
          </ToggleSeg>
        </View>
        <Focusable
          class={
            dark()
              ? "px-2 py-1 rounded-md focus:bg-[#1d242e]"
              : "px-2 py-1 rounded-md focus:bg-[#eceade]"
          }
          onPress={() => setMenuOpen(!menuOpen())}
        >
          <Text class="text-xs font-bold" style={{ textColor: ink().header }}>
            •••
          </Text>
        </Focusable>
      </View>

      {/* Content: untransformed clip + translated canvas (the IM contract). */}
      <Show
        when={editing()}
        fallback={
          <Focusable class="relative flex-1 overflow-hidden">
            <View
              class="absolute"
              style={{
                insetL: marginX(),
                width: contentW(),
                insetT: 0,
                height: viewLayout().total,
                translateY: -scrollV(),
              }}
            >
              <For each={visibleRows()}>
                {(entry) => (
                  <MdRow
                    row={entry.row}
                    ink={ink}
                    span={() => {
                      const sel = vsel();
                      return sel
                        ? rowSelSpan(viewLayout().rows, entry.i, sel.start, sel.end, textWidth)
                        : null;
                    }}
                  />
                )}
              </For>
            </View>
            {scrollbar(scrollV(), viewLayout().total)}
          </Focusable>
        }
      >
        <Focusable class="relative flex-1 overflow-hidden">
          <View
            class="absolute"
            style={{
              insetL: marginX(),
              width: contentW(),
              insetT: 0,
              height: editTotal(),
              translateY: -scrollE(),
            }}
          >
            <For each={visibleLines()}>
              {(line) => (
                <View
                  class="absolute left-0 right-0"
                  style={{ insetT: EDGE_PAD + line.index * BODY_LINE_H, height: BODY_LINE_H }}
                >
                  <Show when={lineSelRect(line) != null}>
                    <View
                      class="absolute rounded-sm"
                      style={{
                        insetL: lineSelRect(line)?.x0 ?? 0,
                        insetT: 1,
                        width: Math.max(
                          2,
                          (lineSelRect(line)?.x1 ?? 0) - (lineSelRect(line)?.x0 ?? 0),
                        ),
                        height: BODY_LINE_H - 2,
                        bgColor: ink().sel,
                      }}
                    />
                  </Show>
                  <Text
                    class="absolute text-sm"
                    style={{
                      insetL: 0,
                      insetT: 0,
                      height: BODY_LINE_H,
                      lineHeight: BODY_LINE_H,
                      textColor: ink().body,
                    }}
                  >
                    {doc().slice(line.start, line.end)}
                  </Text>
                </View>
              )}
            </For>
            <Show when={!editSel()}>
              <View
                class="absolute animate-pulse rounded-sm"
                style={{
                  width: 2,
                  insetL: caretPx() - 1,
                  insetT: EDGE_PAD + caretRow() * BODY_LINE_H + (BODY_LINE_H - CARET_H) / 2,
                  height: CARET_H,
                  bgColor: ink().accent,
                }}
              />
            </Show>
          </View>
          {scrollbar(scrollE(), editTotal())}
        </Focusable>
      </Show>

      {/* Resize grip affordance (the host claims the actual corner drag). */}
      <View class="absolute" style={{ insetR: 4, insetB: 4, width: 12, height: 12 }}>
        <For each={[{ x: 8, y: 0 }, { x: 4, y: 4 }, { x: 8, y: 4 }, { x: 0, y: 8 }, { x: 4, y: 8 }, { x: 8, y: 8 }]}>
          {(d) => (
            <View
              class="absolute rounded-sm"
              style={{ insetL: d.x, insetT: d.y, width: 2, height: 2, bgColor: ink().dim }}
            />
          )}
        </For>
      </View>

      {/* The ••• menu: portal overlay, backdrop press closes. */}
      <Show when={menuOpen()}>
        <Portal>
          <Focusable class="absolute inset-0 bg-[#00000001]" onPress={() => setMenuOpen(false)} />
          <View
            class={
              dark()
                ? "absolute flex-col p-1 rounded-lg shadow-lg bg-[#171d25] w-[148]"
                : "absolute flex-col p-1 rounded-lg shadow-lg bg-[#ffffff] w-[148]"
            }
            style={{ insetT: HEADER_H, insetR: 8 }}
          >
            <MenuItem
              label={editing() ? "Preview" : "Edit"}
              dark={dark()}
              color={ink().body}
              onPress={() => {
                setMenuOpen(false);
                if (editing()) leaveEdit();
                else enterEdit(caret());
              }}
            />
            <MenuItem
              label={dark() ? "Light theme" : "Dark theme"}
              dark={dark()}
              color={ink().body}
              onPress={() => {
                setDark(!dark());
                setMenuOpen(false);
              }}
            />
            <MenuItem
              label="Reset note"
              dark={dark()}
              color={ink().body}
              onPress={() => {
                recordEdit(history, selState(), "other");
                setDoc(SAMPLE_DOC);
                setCaret(0);
                setAnchor(0);
                setVsel(null);
                setScrollV(0);
                setScrollE(0);
                markDirty();
                setMenuOpen(false);
              }}
            />
            <View style={{ height: 1, bgColor: ink().hr }} />
            <MenuItem
              label="Close widget"
              dark={dark()}
              color={ink().accent}
              onPress={() => {
                if (saveIn > 0) save();
                svc?.send({ t: "quit" });
                setMenuOpen(false);
              }}
            />
          </View>
        </Portal>
      </Show>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Header toggle + icons (pure Views — the atlas has no icon glyphs)
// ---------------------------------------------------------------------------

function ToggleSeg(props: {
  active: () => boolean;
  ink: () => Ink;
  dark: () => boolean;
  onPress: () => void;
  children?: unknown;
}): ReturnType<typeof View> {
  return (
    <Focusable
      class={
        props.dark()
          ? "rounded items-center justify-center w-[26] h-[20] focus:bg-[#242e3a]"
          : "rounded items-center justify-center w-[26] h-[20] focus:bg-[#e0ddd2]"
      }
      style={{ bgColor: props.active() ? (props.dark() ? "#2c3947" : "#ffffff") : "#00000000" }}
      onPress={props.onPress}
    >
      {props.children}
    </Focusable>
  );
}

/** Preview: an eye — pill iris + pupil. */
function EyeIcon(props: {
  color: () => string;
  bg: () => Ink;
  dark: () => boolean;
}): ReturnType<typeof View> {
  return (
    <View class="relative w-[16] h-[16]">
      <View
        class="absolute rounded-full w-[14] h-[10]"
        style={{ insetL: 1, insetT: 3, bgColor: props.color() }}
      />
      <View
        class="absolute rounded-full w-[4] h-[4]"
        style={{ insetL: 6, insetT: 6, bgColor: props.dark() ? "#11151b" : "#fbfaf6" }}
      />
    </View>
  );
}

/** Edit: an I-beam text cursor. */
function IBeamIcon(props: { color: () => string }): ReturnType<typeof View> {
  return (
    <View class="relative w-[16] h-[16]">
      <View
        class="absolute rounded-sm"
        style={{ insetL: 5, insetT: 1, width: 6, height: 2, bgColor: props.color() }}
      />
      <View
        class="absolute"
        style={{ insetL: 7, insetT: 2, width: 2, height: 12, bgColor: props.color() }}
      />
      <View
        class="absolute rounded-sm"
        style={{ insetL: 5, insetT: 13, width: 6, height: 2, bgColor: props.color() }}
      />
    </View>
  );
}

function MenuItem(props: {
  label: string;
  dark: boolean;
  color: string;
  onPress: () => void;
}): ReturnType<typeof View> {
  return (
    <Focusable
      class={
        props.dark
          ? "px-2 py-1 rounded-md focus:bg-[#222b36]"
          : "px-2 py-1 rounded-md focus:bg-[#f0eee6]"
      }
      onPress={props.onPress}
    >
      <Text class="text-sm" style={{ textColor: props.color, lineHeight: 18 }}>
        {props.label}
      </Text>
    </Focusable>
  );
}

function MdRow(props: {
  row: ViewRow;
  ink: () => Ink;
  span: () => { x0: number; x1: number } | null;
}): ReturnType<typeof View> {
  const row = props.row;
  // Reactive selection highlight — mounted rows must follow a live drag,
  // so this is a <Show> over the span accessor, never a bare call child.
  const highlight = (
    <Show when={props.span() != null}>
      <View
        class="absolute rounded-sm"
        style={{
          insetL: props.span()?.x0 ?? 0,
          insetT: 0,
          width: Math.max(2, (props.span()?.x1 ?? 0) - (props.span()?.x0 ?? 0)),
          height: row.h,
          bgColor: props.ink().sel,
        }}
      />
    </Show>
  );
  if (row.kind === "hr") {
    return (
      <View
        class="absolute left-0 right-0"
        style={{ insetT: row.y + Math.floor(row.h / 2), height: 1, bgColor: props.ink().hr }}
      />
    );
  }
  if (row.kind === "code") {
    return (
      <View
        class="absolute left-0 right-0 rounded-md"
        style={{ insetT: row.y, height: row.h, bgColor: props.ink().codeBg }}
      >
        {highlight}
        <Text
          class="absolute text-sm"
          style={{ insetL: 8, insetT: 8, lineHeight: 18, textColor: props.ink().code }}
        >
          {row.text}
        </Text>
      </View>
    );
  }
  return (
    <View class="absolute left-0 right-0" style={{ insetT: row.y, height: row.h }}>
      {highlight}
      <Show when={row.bar}>
        {/* Unrounded so consecutive quote lines read as one bar. */}
        <View
          class="absolute"
          style={{ insetL: 0, insetT: 0, width: 3, height: row.h, bgColor: props.ink().bar }}
        />
      </Show>
      <For each={row.segs}>
        {(seg) => (
          <Text
            class={segFontClass(seg)}
            style={{
              insetL: row.indent + seg.x,
              insetT: 0,
              height: row.h,
              lineHeight: row.h,
              textColor: segColor(seg, props.ink()),
            }}
          >
            {seg.text}
          </Text>
        )}
      </For>
    </View>
  );
}
