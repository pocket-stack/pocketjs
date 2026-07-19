// demos/note/select.ts — preview-mode selection math over layout rows.
//
// The rendered note is absolute rows of positioned segments (layout.ts),
// not a string — so preview selection lives in (row, char) space: a
// position is a row index plus a char offset into that row's selectable
// text. Pure and measure-injected like editor.ts, so the mapping (point ↔
// position ↔ highlight spans) unit-tests with a fake measure.
//
// Granularity choices (browser-like where it's cheap, honest where not):
// - line rows select per char, walking segments (marker segs — list
//   bullets/ordinals — are furniture, not text: skipped);
// - code rows select as one block (all or nothing);
// - hr rows are inert.

import type { Seg, ViewRow } from "./layout.ts";

export type MeasureSlot = (text: string, slot: number) => number;

/** A selection endpoint: row index + char offset into rowText(row). */
export interface RowPos {
  row: number;
  ch: number;
}

export function cmpPos(a: RowPos, b: RowPos): number {
  return a.row !== b.row ? a.row - b.row : a.ch - b.ch;
}

function textSegs(row: ViewRow & { kind: "line" }): Seg[] {
  return row.segs.filter((s) => s.style !== "marker");
}

/** The selectable text of a row (segment texts joined; "" when inert). */
export function rowText(row: ViewRow): string {
  if (row.kind === "code") return row.text;
  if (row.kind !== "line") return "";
  let out = "";
  for (const seg of textSegs(row)) out += seg.text;
  return out;
}

/** Char count of a row's selectable text. */
export function rowLen(row: ViewRow): number {
  return rowText(row).length;
}

/**
 * Canvas x (content-column space, indent included) → char offset into the
 * row's selectable text, snapped to the nearest boundary. Code rows snap
 * to 0 or full (block granularity).
 */
export function rowChFromX(row: ViewRow, x: number, m: MeasureSlot): number {
  if (row.kind === "code") return 0; // block granularity — caller spans all
  if (row.kind !== "line") return 0;
  let ch = 0;
  for (const seg of textSegs(row)) {
    const segX = row.indent + seg.x;
    let acc = segX;
    for (let i = 0; i < seg.text.length; i++) {
      const cw = m(seg.text[i], seg.slot);
      if (x < acc + cw / 2) return ch;
      acc += cw;
      ch++;
    }
  }
  return ch;
}

/** Char offset → canvas x px (boundary position before that char). */
export function rowXOfCh(row: ViewRow, ch: number, m: MeasureSlot): number {
  if (row.kind !== "line") return 0;
  const segs = textSegs(row);
  let left = ch;
  let last = 0;
  for (const seg of segs) {
    const segX = row.indent + seg.x;
    if (left <= seg.text.length) {
      return segX + m(seg.text.slice(0, left), seg.slot);
    }
    left -= seg.text.length;
    last = segX + m(seg.text, seg.slot);
  }
  return last;
}

/** The x extent of a row's selectable text: [start of first seg, end of last]. */
export function rowXBounds(row: ViewRow, m: MeasureSlot): [number, number] {
  if (row.kind === "code") {
    let w = 0;
    for (const line of row.text.split("\n")) w = Math.max(w, m(line, 1));
    return [0, w + 16]; // CODE_PAD both sides
  }
  if (row.kind !== "line") return [0, 0];
  const segs = textSegs(row);
  if (segs.length === 0) return [row.indent, row.indent];
  const first = row.indent + segs[0].x;
  const last = segs[segs.length - 1];
  return [first, row.indent + last.x + m(last.text, last.slot)];
}

/**
 * The highlight span of row index `r` for a normalized selection
 * [start, end] — null when the row is outside the range or inert.
 * Boundary rows clip to the endpoint chars; interior rows span fully.
 */
export function rowSelSpan(
  rows: readonly ViewRow[],
  r: number,
  start: RowPos,
  end: RowPos,
  m: MeasureSlot,
): { x0: number; x1: number } | null {
  if (r < start.row || r > end.row) return null;
  const row = rows[r];
  if (row.kind === "hr") return null;
  const [lo, hi] = rowXBounds(row, m);
  if (row.kind === "code") {
    // Block granularity: any overlap selects the whole block.
    return { x0: lo, x1: hi };
  }
  let x0 = lo;
  let x1 = hi;
  if (r === start.row) x0 = Math.max(lo, rowXOfCh(row, start.ch, m));
  if (r === end.row) x1 = Math.min(hi, rowXOfCh(row, end.ch, m));
  if (x1 <= x0) return null;
  return { x0, x1 };
}

/** Canvas y → index of the row containing (or nearest below) it; gaps
 *  between rows snap to the following row. */
export function rowFromY(rows: readonly ViewRow[], y: number): number {
  for (let i = 0; i < rows.length; i++) {
    if (y < rows[i].y + rows[i].h) return i;
  }
  return Math.max(0, rows.length - 1);
}

/**
 * The text a normalized [start, end] selection covers, rows joined with
 * newlines — what ⌘C puts on the clipboard. Boundary rows slice at the
 * endpoint chars; code rows are atomic (their whole text); inert rows
 * contribute nothing (a rule "selects" as a blank line would in a
 * browser: skipped).
 */
export function selectedText(rows: readonly ViewRow[], start: RowPos, end: RowPos): string {
  let out = "";
  let first = true;
  for (let r = start.row; r <= end.row && r < rows.length; r++) {
    const row = rows[r];
    if (row.kind === "hr") continue;
    let text: string;
    if (row.kind === "code") {
      text = row.text;
    } else {
      text = rowText(row);
      if (r === end.row) text = text.slice(0, end.ch);
      if (r === start.row) text = text.slice(start.ch);
    }
    if (!first) {
      // A soft-wrapped continuation re-joins with the space the wrap
      // consumed; everything else is a real line break.
      out += row.kind === "line" && row.wrapCont ? " " : "\n";
    }
    out += text;
    first = false;
  }
  return out;
}
