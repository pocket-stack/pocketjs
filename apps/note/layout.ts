// apps/note/layout.ts — measured markdown layout: blocks → absolute rows.
//
// Same two facts as apps/im/wrap.ts: the engine breaks only on '\n', and a
// virtual list needs every row height before anything mounts — one cached
// measureText per word, then integer math. The twist here is *styled* wrap:
// a paragraph is a run of spans (bold/code/link change the measuring slot),
// so lines come back as pre-positioned segments, each an absolutely placed
// <Text> at its measured x. Every constant mirrors a class literal in
// app.tsx — the arithmetic in this file IS the rendered geometry.

import { getOps } from "@pocketjs/framework";
import type { Block, Span, SpanStyle } from "./markdown.ts";

// Build-pinned font slots (framework/compiler/tailwind.ts fontSlotFor: FONT_PX index
// 12/14/16/18/20/24/36, bold +7). Literals on purpose — compiler source
// must stay out of the app import graph.
export const FONT_BODY = 1; //      fontSlotFor(14, false) — text-sm
export const FONT_BODY_BOLD = 8; // fontSlotFor(14, true)
export const FONT_H1 = 12; //       fontSlotFor(24, true)  — text-2xl bold
export const FONT_H2 = 11; //       fontSlotFor(20, true)  — text-xl bold
export const FONT_H3 = 10; //       fontSlotFor(18, true)  — text-lg bold
export const FONT_META = 0; //      fontSlotFor(12, false) — text-xs

export const BODY_LINE_H = 20;
const H_LINE: Record<"h1" | "h2" | "h3", number> = { h1: 32, h2: 26, h3: 22 };
const H_FONT: Record<"h1" | "h2" | "h3", number> = { h1: FONT_H1, h2: FONT_H2, h3: FONT_H3 };
/** Extra space above a heading (below is the normal block gap). */
const H_SPACE: Record<"h1" | "h2" | "h3", number> = { h1: 10, h2: 8, h3: 6 };
const BLOCK_GAP = 8;
const CODE_LINE_H = 18;
const CODE_PAD = 8;
const QUOTE_BAR_W = 3;
const QUOTE_PAD = 10;
const LI_INDENT = 18; //     marker column width
const LI_DEPTH = 16; //      one extra indent step
const HR_H = 17; //          1px rule + margins
export const EDGE_PAD = 10;

// ---------------------------------------------------------------------------
// Cached measurement
// ---------------------------------------------------------------------------

const widthCache = new Map<string, number>();

export function textWidth(text: string, slot: number): number {
  if (text === "") return 0;
  const key = slot + "|" + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    w = getOps().measureText(text, slot);
    widthCache.set(key, w);
  }
  return w;
}

/** The editor's measure fn (body font), for editor.ts / caret math. */
export function bodyWidth(text: string): number {
  return textWidth(text, FONT_BODY);
}

// ---------------------------------------------------------------------------
// Styled wrap
// ---------------------------------------------------------------------------

/** One absolutely positioned <Text> within a line row. */
export interface Seg {
  text: string;
  x: number;
  slot: number;
  style: SpanStyle | "marker";
}

export type ViewRow =
  | {
      kind: "line";
      key: string;
      y: number;
      h: number;
      segs: Seg[];
      /** Left inset of the text body (list indent / quote pad). */
      indent: number;
      /** Draw the quote bar alongside this line. */
      bar: boolean;
      /** Soft-wrap continuation of the previous row (same logical line —
       *  a copy re-joins them with the space the wrap consumed). */
      wrapCont: boolean;
      /** Source line the row came from (view-click → edit caret). */
      srcLine: number;
    }
  | { kind: "code"; key: string; y: number; h: number; text: string; srcLine: number }
  | { kind: "hr"; key: string; y: number; h: number; srcLine: number };

export interface ViewLayout {
  rows: ViewRow[];
  total: number;
}

function slotFor(style: SpanStyle, base: number, bold: number): number {
  return style === "bold" ? bold : base;
}

/**
 * Greedy word wrap over styled spans at `maxW`, returning lines of
 * positioned segments. Explicit '\n' inside a span always breaks.
 */
export interface WrapLine {
  segs: Seg[];
  /** This line starts at a hard boundary (block start or explicit '\n'),
   *  not a soft wrap. */
  hard: boolean;
}

export function wrapSpans(
  spans: Span[],
  maxW: number,
  base: number,
  bold: number,
): WrapLine[] {
  // Flatten to word tokens. `glue` marks a token that follows its
  // predecessor with no space — the first word of a span continues the
  // previous span's last word ("**Bold**," parses to "Bold" + glued ",").
  const tokens: { text: string; style: SpanStyle; glue: boolean }[] = [];
  for (const span of spans) {
    const paras = span.text.split("\n");
    for (let p = 0; p < paras.length; p++) {
      if (p > 0) tokens.push({ text: "\n", style: span.style, glue: false });
      const words = paras[p].split(" ");
      for (let i = 0; i < words.length; i++) {
        tokens.push({
          text: words[i],
          style: span.style,
          glue: p === 0 && i === 0 && tokens.length > 0,
        });
      }
    }
  }

  const lines: WrapLine[] = [];
  let line: Seg[] = [];
  let x = 0;
  /** Pending px before the next word (separator and/or literal spaces). */
  let gap = 0;
  let gapSlot = base;
  /** The next flushed line begins at a hard boundary. */
  let pendingHard = true;
  const flushLine = () => {
    lines.push({ segs: line, hard: pendingHard });
    pendingHard = false;
    line = [];
    x = 0;
    gap = 0;
  };
  const append = (text: string, style: SpanStyle, slot: number, w: number) => {
    const last = line[line.length - 1];
    const spaceW = last ? textWidth(" ", last.slot) : 0;
    if (last && last.style === style && last.slot === slot && gap === 0) {
      last.text += text;
    } else if (last && last.style === style && last.slot === slot && gap === spaceW) {
      last.text += " " + text;
    } else {
      line.push({ text, x: x + gap, slot, style });
    }
    x += gap + w;
    gap = 0;
  };
  for (const token of tokens) {
    if (token.text === "\n") {
      flushLine();
      pendingHard = true;
      continue;
    }
    if (token.text === "") {
      // An empty token is a literal space (split artifact of "  ").
      gap += textWidth(" ", gapSlot);
      continue;
    }
    const slot = slotFor(token.style, base, bold);
    const w = textWidth(token.text, slot);
    const sep = line.length > 0 && !token.glue ? textWidth(" ", gapSlot) : 0;
    if (line.length > 0 && x + gap + sep + w > maxW) {
      flushLine();
    } else {
      gap += sep;
    }
    // A single token wider than the line: hard-break by chars.
    if (w > maxW) {
      let chunk = "";
      let chunkW = 0;
      for (const ch of token.text) {
        const cw = textWidth(ch, slot);
        if (chunk !== "" && x + gap + chunkW + cw > maxW) {
          append(chunk, token.style, slot, chunkW);
          flushLine();
          chunk = "";
          chunkW = 0;
        }
        chunk += ch;
        chunkW += cw;
      }
      if (chunk !== "") append(chunk, token.style, slot, chunkW);
      gapSlot = slot;
      continue;
    }
    append(token.text, token.style, slot, w);
    gapSlot = slot;
  }
  lines.push({ segs: line, hard: pendingHard });
  return lines;
}

// ---------------------------------------------------------------------------
// Block layout
// ---------------------------------------------------------------------------

/** Lay every block out at an absolute y for a `width`-px content column. */
export function layoutBlocks(blocks: Block[], width: number): ViewLayout {
  const rows: ViewRow[] = [];
  let y = EDGE_PAD;
  let first = true;
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    if (!first) y += BLOCK_GAP;
    first = false;

    if (block.kind === "hr") {
      rows.push({ kind: "hr", key: `${b}`, y, h: HR_H, srcLine: block.line });
      y += HR_H;
      continue;
    }
    if (block.kind === "code") {
      const lineCount = block.text === "" ? 1 : block.text.split("\n").length;
      const h = lineCount * CODE_LINE_H + CODE_PAD * 2;
      rows.push({ kind: "code", key: `${b}`, y, h, text: block.text, srcLine: block.line });
      y += h;
      continue;
    }

    let indent = 0;
    let bar = false;
    let base = FONT_BODY;
    let bold = FONT_BODY_BOLD;
    let lineH = BODY_LINE_H;
    if (block.kind === "li") {
      indent = LI_INDENT + block.depth * LI_DEPTH;
    } else if (block.kind === "quote") {
      indent = QUOTE_BAR_W + QUOTE_PAD;
      bar = true;
    } else if (block.kind !== "p") {
      base = H_FONT[block.kind];
      bold = base;
      lineH = H_LINE[block.kind];
      y += H_SPACE[block.kind];
    }

    const lines = wrapSpans(block.spans, Math.max(40, width - indent), base, bold);
    for (let l = 0; l < lines.length; l++) {
      const segs = lines[l].segs;
      if (block.kind === "li" && l === 0) {
        segs.unshift({
          text: block.marker,
          x: -LI_INDENT,
          slot: block.marker === "•" ? FONT_BODY_BOLD : FONT_BODY,
          style: "marker",
        });
      }
      rows.push({
        kind: "line",
        key: `${b}:${l}`,
        y,
        h: lineH,
        segs,
        indent,
        bar,
        wrapCont: l > 0 && !lines[l].hard,
        srcLine: block.line,
      });
      y += lineH;
    }
  }
  return { rows, total: y + EDGE_PAD };
}
