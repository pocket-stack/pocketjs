// demos/note/app.tsx — Pocket Note: a markdown widget as a PocketJS app.
//
// Two modes over one string document. View mode renders parsed markdown as
// measured, absolutely-positioned rows (layout.ts) behind a manual virtual
// scroll — the IM thread contract: an untransformed overflow-hidden clip
// around a translateY canvas that mounts only the visible slice. Edit mode
// soft-wraps the raw source (editor.ts) with a real caret. The desktop
// host feeds keys/mouse/resizes through the svc channel (svc.ts) and
// synthesizes CIRCLE for clicks, so hover-focus + the stock onPress
// pipeline do all interaction dispatch; on hosts without svc (PSP, sim,
// goldens) the app is a read-only note scrolled by d-pad — unmodified-app
// base case.

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
  type Seg,
  type ViewRow,
} from "./layout.ts";
import {
  backspace,
  caretFromX,
  caretLine,
  caretX,
  del,
  insertAt,
  layoutDoc,
  lineEnd,
  lineStart,
  moveVertical,
} from "./editor.ts";
import { connectSvc, type HostEvent } from "./svc.ts";
import { SAMPLE_DOC } from "./sample.ts";

const HEADER_H = 30;
const PAD_X = 14;
const OVERSCAN = 40;
const SCROLL_STEP = 40; //  d-pad / PageUp step base
const SAVE_DEBOUNCE = 45; // ticks (~0.75 s) after the last edit
const CARET_H = 16;

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
  },
};

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

function segColor(seg: Seg, ink: (typeof INK)["dark"]): string {
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

/** Global char offset of source line `n` (caret for view-mode clicks). */
function lineOffset(doc: string, n: number): number {
  let off = 0;
  const lines = doc.split("\n");
  for (let i = 0; i < n && i < lines.length; i++) off += lines[i].length + 1;
  return Math.min(off, doc.length);
}

export default function Note(): ReturnType<typeof View> {
  const svc = connectSvc();
  const [vp, setVp] = createSignal({ w: 480, h: 272 });
  const [doc, setDoc] = createSignal(SAMPLE_DOC);
  const [editing, setEditing] = createSignal(false);
  const [dark, setDark] = createSignal(true);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [scrollV, setScrollV] = createSignal(0);
  const [scrollE, setScrollE] = createSignal(0);
  const [mouse, setMouse] = createSignal({ x: -1, y: -1 });
  const [unsaved, setUnsaved] = createSignal(false);

  const ink = () => (dark() ? INK.dark : INK.light);
  const contentW = () => vp().w - PAD_X * 2;
  const viewH = () => vp().h - HEADER_H;

  // ---- view layout -------------------------------------------------------
  const viewLayout = createMemo(() => layoutBlocks(parseMarkdown(doc()), contentW()));
  const maxScrollV = () => Math.max(0, viewLayout().total - viewH());
  const visibleRows = createMemo(() => {
    const top = scrollV() - OVERSCAN;
    const bottom = scrollV() + viewH() + OVERSCAN;
    return viewLayout().rows.filter((r) => r.y < bottom && r.y + r.h > top);
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
    const out: { index: number; start: number; end: number }[] = [];
    for (let i = from; i < to; i++) out.push({ index: i, start: lines[i].start, end: lines[i].end });
    return out;
  });
  const caretRow = () => caretLine(dlines(), caret());
  const caretPx = () => caretX(doc(), dlines(), caret(), bodyWidth);

  // ---- edits -------------------------------------------------------------
  let goalX = 0;
  let goalSticky = false;
  let saveIn = -1;
  let lastHover: NodeMirror | null = null;
  /** Re-run hover→focus next frame (a mode switch remounted the target). */
  let rehover = false;

  const markDirty = () => {
    setUnsaved(true);
    saveIn = SAVE_DEBOUNCE;
  };
  const save = () => {
    saveIn = -1;
    setUnsaved(false);
    svc?.send({ t: "save", text: doc() });
  };
  const revealCaret = () => {
    const y = EDGE_PAD + caretRow() * BODY_LINE_H;
    if (y < scrollE() + 4) setScrollE(Math.max(0, y - 4));
    else if (y + BODY_LINE_H > scrollE() + viewH() - 4) {
      setScrollE(Math.min(maxScrollE(), y + BODY_LINE_H - viewH() + 4));
    }
  };
  const applyEdit = (fn: (s: { doc: string; caret: number }) => { doc: string; caret: number }) => {
    const next = fn({ doc: doc(), caret: caret() });
    if (next.doc !== doc()) {
      setDoc(next.doc);
      markDirty();
    }
    setCaret(next.caret);
    goalSticky = false;
    revealCaret();
  };

  const enterEdit = (offset: number) => {
    setMenuOpen(false);
    setCaret(Math.max(0, Math.min(offset, doc().length)));
    // Keep roughly the same place on screen across the mode switch.
    const y = EDGE_PAD + caretLine(dlines(), caret()) * BODY_LINE_H;
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
      else if (editing()) leaveEdit();
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
        applyEdit(backspace);
        break;
      case "Delete":
        applyEdit(del);
        break;
      case "Enter":
        applyEdit((s) => insertAt(s, "\n"));
        break;
      case "Tab":
        applyEdit((s) => insertAt(s, "  "));
        break;
      case "Left":
        applyEdit((s) => ({ doc: s.doc, caret: Math.max(0, s.caret - 1) }));
        break;
      case "Right":
        applyEdit((s) => ({ doc: s.doc, caret: Math.min(s.doc.length, s.caret + 1) }));
        break;
      case "Home":
        applyEdit((s) => ({ doc: s.doc, caret: lineStart(dlines(), s.caret) }));
        break;
      case "End":
        applyEdit((s) => ({ doc: s.doc, caret: lineEnd(dlines(), s.caret) }));
        break;
      case "Up":
      case "Down": {
        if (!goalSticky) {
          goalX = caretPx();
          goalSticky = true;
        }
        const next = moveVertical(doc(), dlines(), caret(), k === "Up" ? -1 : 1, goalX, bodyWidth);
        setCaret(next);
        goalSticky = true; // survive the applyEdit-free path
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

  const handleEvent = (ev: HostEvent) => {
    switch (ev.t) {
      case "hello":
      case "resize":
        setVp({ w: ev.w ?? 480, h: ev.h ?? 272 });
        resizeViewport(ev.w ?? 480, ev.h ?? 272);
        setScrollV(Math.max(0, Math.min(maxScrollV(), scrollV())));
        setScrollE(Math.max(0, Math.min(maxScrollE(), scrollE())));
        break;
      case "load":
        setDoc(ev.text ?? "");
        setCaret(0);
        setUnsaved(false);
        saveIn = -1;
        break;
      case "ch":
        if (editing() && ev.s) applyEdit((s) => insertAt(s, ev.s!));
        break;
      case "key":
        if (ev.k) handleKey(ev.k);
        break;
      case "mouse": {
        const p = { x: ev.x ?? -1, y: ev.y ?? -1 };
        setMouse(p);
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

  // ---- interaction targets ----------------------------------------------
  const contentPress = () => {
    const m = mouse();
    if (editing()) {
      const line = Math.floor((m.y - HEADER_H + scrollE() - EDGE_PAD) / BODY_LINE_H);
      setCaret(caretFromX(doc(), dlines(), line, m.x - PAD_X, bodyWidth));
      goalSticky = false;
      return;
    }
    // View mode: click drops you into the source near the clicked block.
    const ly = m.y - HEADER_H + scrollV();
    const rows = viewLayout().rows;
    let src = 0;
    for (const r of rows) if (r.y <= ly) src = r.srcLine;
    enterEdit(lineOffset(doc(), src));
  };

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
        <View
          class="rounded-full w-[7] h-[7]"
          style={{ bgColor: unsaved() ? ink().accent : ink().bar }}
        />
        <Text class="text-xs font-bold tracking-wide" style={{ textColor: ink().header }}>
          POCKET NOTE
        </Text>
        <View class="flex-1" />
        <Focusable
          class={
            dark()
              ? "px-2 py-1 rounded-md focus:bg-[#1d242e]"
              : "px-2 py-1 rounded-md focus:bg-[#eceade]"
          }
          onPress={() => (editing() ? leaveEdit() : enterEdit(0))}
        >
          <Text class="text-xs font-bold" style={{ textColor: ink().accent }}>
            {editing() ? "DONE" : "EDIT"}
          </Text>
        </Focusable>
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
          <Focusable class="relative flex-1 overflow-hidden" onPress={contentPress}>
            <View
              class="absolute"
              style={{
                insetL: PAD_X,
                insetR: PAD_X,
                insetT: 0,
                height: viewLayout().total,
                translateY: -scrollV(),
              }}
            >
              <For each={visibleRows()}>{(row) => <MdRow row={row} ink={ink} />}</For>
            </View>
            {scrollbar(scrollV(), viewLayout().total)}
          </Focusable>
        }
      >
        <Focusable class="relative flex-1 overflow-hidden" onPress={contentPress}>
          <View
            class="absolute"
            style={{
              insetL: PAD_X,
              insetR: PAD_X,
              insetT: 0,
              height: editTotal(),
              translateY: -scrollE(),
            }}
          >
            <For each={visibleLines()}>
              {(line) => (
                <Text
                  class="absolute text-sm"
                  style={{
                    insetL: 0,
                    insetT: EDGE_PAD + line.index * BODY_LINE_H,
                    height: BODY_LINE_H,
                    lineHeight: BODY_LINE_H,
                    textColor: ink().body,
                  }}
                >
                  {doc().slice(line.start, line.end)}
                </Text>
              )}
            </For>
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
              label={editing() ? "Done editing" : "Edit"}
              dark={dark()}
              color={ink().body}
              onPress={() => {
                setMenuOpen(false);
                if (editing()) leaveEdit();
                else enterEdit(0);
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
                setDoc(SAMPLE_DOC);
                setCaret(0);
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

function MdRow(props: { row: ViewRow; ink: () => (typeof INK)["dark"] }): ReturnType<typeof View> {
  const row = props.row;
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
