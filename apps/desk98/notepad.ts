// apps/desk98/notepad.ts — pure Notepad text rules: insertion, deletion,
// caret movement, the selection model (anchor + caret) and the word-wrap
// layout (logical lines → visual segments). No framework imports —
// unit-tested directly.
//
// The wrap model: the Doc stores LOGICAL lines and the caret/selection live
// in logical (row, col) coordinates; wrapDoc() projects each line onto 1..N
// VISUAL segments {row, from, to} under a pixel width, and every mapping in
// both directions (caret → x/vrow, click → caret, Up/Down/Home/End) goes
// through the same segment list — render geometry and hit geometry share one
// source of truth. Widths come from a caller-supplied measure function;
// glyph advances are additive in this engine (no kerning pairs), so a
// slice's width is exact.

export interface Caret {
  row: number;
  col: number;
  /** Wrap affinity: at a soft-wrap boundary column this caret belongs to
   *  the END of the earlier visual row (End key, clicks past a row's text),
   *  not the start of the next. Edits and plain moves never set it. */
  end?: boolean;
}

export interface Doc {
  lines: string[];
  caret: Caret;
  /** Selection anchor (the other end of the range); null/absent = none.
   *  Every edit collapses it — edited Docs never carry a stale anchor. */
  anchor?: Caret | null;
}

// ---------------------------------------------------------------------------
// Undo/redo history
// ---------------------------------------------------------------------------
// Docs are immutable values (every edit returns a fresh one), so history is
// plain snapshots — O(1) per step, structure shared. Coalescing: consecutive
// edits of the same CONTINUOUS kind ("type" runs, "erase" runs) collapse
// into one undo unit; "other" edits (Enter, paste, cut, Time/Date, New)
// always stand alone. Continuity is checked against `tip` — the doc the
// last recorded edit produced — so a caret move or click between keystrokes
// breaks the group without recording anything itself.

export type EditKind = "type" | "erase" | "other";

export interface History {
  undo: readonly Doc[];
  redo: readonly Doc[];
  kind: EditKind | null;
  tip: Doc | null;
}

const HISTORY_DEPTH = 200;

export function emptyHistory(): History {
  return { undo: [], redo: [], kind: null, tip: null };
}

/** Two docs hold the same text + caret + selection (cheap: shared strings). */
export function docEquals(a: Doc, b: Doc): boolean {
  if (a.lines.length !== b.lines.length) return false;
  for (let i = 0; i < a.lines.length; i++) if (a.lines[i] !== b.lines[i]) return false;
  const sameCaret = a.caret.row === b.caret.row && a.caret.col === b.caret.col;
  const an = a.anchor ?? null;
  const bn = b.anchor ?? null;
  const sameAnchor =
    an === bn || (an !== null && bn !== null && an.row === bn.row && an.col === bn.col);
  return sameCaret && sameAnchor;
}

/** Record an edit prev → next. Clears the redo stack; coalesces per the
 *  rules above; caps the depth. */
export function record(h: History, prev: Doc, next: Doc, kind: EditKind): History {
  const cont = kind !== "other" && kind === h.kind && h.tip === prev;
  let undo = cont ? h.undo : [...h.undo, prev];
  if (undo.length > HISTORY_DEPTH) undo = undo.slice(undo.length - HISTORY_DEPTH);
  return { undo, redo: [], kind, tip: next };
}

/** Pop one undo unit; null when empty. The current doc moves to redo. */
export function undoStep(h: History, current: Doc): { h: History; doc: Doc } | null {
  if (h.undo.length === 0) return null;
  const doc = h.undo[h.undo.length - 1];
  return {
    h: { undo: h.undo.slice(0, -1), redo: [...h.redo, current], kind: null, tip: null },
    doc,
  };
}

/** Pop one redo unit; null when empty. The current doc moves back to undo. */
export function redoStep(h: History, current: Doc): { h: History; doc: Doc } | null {
  if (h.redo.length === 0) return null;
  const doc = h.redo[h.redo.length - 1];
  return {
    h: { undo: [...h.undo, current], redo: h.redo.slice(0, -1), kind: null, tip: null },
    doc,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function cmpCaret(a: Caret, b: Caret): number {
  return a.row !== b.row ? a.row - b.row : a.col - b.col;
}

/** The ordered selection range, null when collapsed or absent. */
export function selRange(doc: Doc): { from: Caret; to: Caret } | null {
  if (!doc.anchor) return null;
  const c = cmpCaret(doc.anchor, doc.caret);
  if (c === 0) return null;
  return c < 0 ? { from: doc.anchor, to: doc.caret } : { from: doc.caret, to: doc.anchor };
}

export function hasSel(doc: Doc): boolean {
  return selRange(doc) !== null;
}

export function selectedText(doc: Doc): string {
  const r = selRange(doc);
  if (!r) return "";
  if (r.from.row === r.to.row) return doc.lines[r.from.row].slice(r.from.col, r.to.col);
  const parts = [doc.lines[r.from.row].slice(r.from.col)];
  for (let row = r.from.row + 1; row < r.to.row; row++) parts.push(doc.lines[row]);
  parts.push(doc.lines[r.to.row].slice(0, r.to.col));
  return parts.join("\n");
}

/** Delete the selected range; caret lands at its start. No-op when none. */
export function deleteSel(doc: Doc): Doc {
  const r = selRange(doc);
  if (!r) return { lines: doc.lines, caret: doc.caret };
  const lines = doc.lines.slice();
  const merged = lines[r.from.row].slice(0, r.from.col) + lines[r.to.row].slice(r.to.col);
  lines.splice(r.from.row, r.to.row - r.from.row + 1, merged);
  return { lines, caret: { row: r.from.row, col: r.from.col } };
}

export function selectAll(doc: Doc): Doc {
  const last = doc.lines.length - 1;
  return {
    lines: doc.lines,
    caret: { row: last, col: doc.lines[last].length },
    anchor: { row: 0, col: 0 },
  };
}

/** Column range of the word (or whitespace run) around col — double-click. */
export function wordRangeAt(line: string, col: number): { from: number; to: number } {
  if (line.length === 0) return { from: 0, to: 0 };
  const i = Math.max(0, Math.min(col, line.length - 1));
  const wordish = (ch: string) => /[\w]/.test(ch);
  const cls = wordish(line[i]) ? 1 : line[i] === " " ? 0 : 2;
  const same = (ch: string) => (cls === 1 ? wordish(ch) : cls === 0 ? ch === " " : !wordish(ch) && ch !== " ");
  let from = i;
  let to = i + 1;
  while (from > 0 && same(line[from - 1])) from--;
  while (to < line.length && same(line[to])) to++;
  return { from, to };
}

/** The selected column span on one row, null when the row has none. Rows
 *  strictly inside a multi-row selection select their full length. */
export function rowSelSpan(doc: Doc, row: number): { from: number; to: number } | null {
  const r = selRange(doc);
  if (!r || row < r.from.row || row > r.to.row) return null;
  const from = row === r.from.row ? r.from.col : 0;
  const to = row === r.to.row ? r.to.col : doc.lines[row].length;
  return from === to ? null : { from, to };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function clampCaret(lines: string[], caret: Caret): Caret {
  const row = Math.max(0, Math.min(caret.row, lines.length - 1));
  const col = Math.max(0, Math.min(caret.col, lines[row].length));
  return { row, col };
}

/** Insert typed text at the caret (replacing any selection); \n splits. */
export function insertText(doc: Doc, s: string): Doc {
  if (hasSel(doc)) doc = deleteSel(doc);
  let { lines, caret } = doc;
  lines = lines.slice();
  caret = clampCaret(lines, caret);
  const parts = s.replace(/\r\n?/g, "\n").split("\n");
  const line = lines[caret.row];
  const before = line.slice(0, caret.col);
  const after = line.slice(caret.col);
  if (parts.length === 1) {
    lines[caret.row] = before + parts[0] + after;
    return { lines, caret: { row: caret.row, col: caret.col + parts[0].length } };
  }
  const inserted = [before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after];
  lines.splice(caret.row, 1, ...inserted);
  return {
    lines,
    caret: { row: caret.row + parts.length - 1, col: parts[parts.length - 1].length },
  };
}

export function backspace(doc: Doc): Doc {
  if (hasSel(doc)) return deleteSel(doc);
  let { lines, caret } = doc;
  lines = lines.slice();
  caret = clampCaret(lines, caret);
  if (caret.col > 0) {
    const line = lines[caret.row];
    lines[caret.row] = line.slice(0, caret.col - 1) + line.slice(caret.col);
    return { lines, caret: { row: caret.row, col: caret.col - 1 } };
  }
  if (caret.row === 0) return { lines, caret };
  const col = lines[caret.row - 1].length;
  lines[caret.row - 1] += lines[caret.row];
  lines.splice(caret.row, 1);
  return { lines, caret: { row: caret.row - 1, col } };
}

export function del(doc: Doc): Doc {
  if (hasSel(doc)) return deleteSel(doc);
  let { lines, caret } = doc;
  lines = lines.slice();
  caret = clampCaret(lines, caret);
  const line = lines[caret.row];
  if (caret.col < line.length) {
    lines[caret.row] = line.slice(0, caret.col) + line.slice(caret.col + 1);
    return { lines, caret };
  }
  if (caret.row === lines.length - 1) return { lines, caret };
  lines[caret.row] += lines[caret.row + 1];
  lines.splice(caret.row + 1, 1);
  return { lines, caret };
}

export type CaretMove = "Left" | "Right" | "Up" | "Down" | "Home" | "End";

export function moveCaret(doc: Doc, key: CaretMove): Caret {
  const { lines } = doc;
  const caret = clampCaret(lines, doc.caret);
  switch (key) {
    case "Left":
      if (caret.col > 0) return { row: caret.row, col: caret.col - 1 };
      if (caret.row > 0) return { row: caret.row - 1, col: lines[caret.row - 1].length };
      return caret;
    case "Right":
      if (caret.col < lines[caret.row].length) return { row: caret.row, col: caret.col + 1 };
      if (caret.row < lines.length - 1) return { row: caret.row + 1, col: 0 };
      return caret;
    case "Up":
      return caret.row > 0 ? clampCaret(lines, { row: caret.row - 1, col: caret.col }) : caret;
    case "Down":
      return caret.row < lines.length - 1
        ? clampCaret(lines, { row: caret.row + 1, col: caret.col })
        : caret;
    case "Home":
      return { row: caret.row, col: 0 };
    case "End":
      return { row: caret.row, col: lines[caret.row].length };
  }
}

/** One caret move, selection-aware. `extend` (shift held) keeps or plants
 *  the anchor; a plain horizontal move over a selection collapses to the
 *  matching edge (the standard behavior), vertical moves step from it. */
export function applyMove(doc: Doc, key: CaretMove, extend: boolean): Doc {
  if (extend) {
    const anchor = doc.anchor ?? doc.caret;
    return { lines: doc.lines, caret: moveCaret(doc, key), anchor };
  }
  const r = selRange(doc);
  if (r) {
    const edge = key === "Left" || key === "Up" || key === "Home" ? r.from : r.to;
    if (key === "Left" || key === "Right") return { lines: doc.lines, caret: edge };
    return { lines: doc.lines, caret: moveCaret({ lines: doc.lines, caret: edge }, key) };
  }
  return { lines: doc.lines, caret: moveCaret(doc, key) };
}

// ---------------------------------------------------------------------------
// Word wrap: logical lines → visual segments
// ---------------------------------------------------------------------------

/** One visual row: lines[row].slice(from, to). Consecutive segments of a row
 *  tile it exactly (to === next.from); trailing spaces at a soft break stay
 *  on the upper row (they hang past the wrap width, like classic Notepad). */
export interface VSeg {
  row: number;
  from: number;
  to: number;
}

/** Greedy word wrap of one line under maxW px: break before the word that
 *  overflows, splitting words wider than a whole row at character level.
 *  Space runs never trigger a break — they hang on the row they follow. */
export function wrapLine(
  line: string,
  maxW: number,
  width: (s: string) => number,
): { from: number; to: number }[] {
  if (line.length === 0) return [{ from: 0, to: 0 }];
  if (!Number.isFinite(maxW) || width(line) <= maxW) return [{ from: 0, to: line.length }];
  const segs: { from: number; to: number }[] = [];
  let segFrom = 0; // current visual row start
  let x = 0; // committed row width (hanging spaces included)
  let i = 0;
  while (i < line.length) {
    if (line[i] === " ") {
      let j = i;
      while (j < line.length && line[j] === " ") j++;
      x += width(line.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] !== " ") j++;
    const w = width(line.slice(i, j));
    if (i > segFrom && x + w > maxW) {
      segs.push({ from: segFrom, to: i });
      segFrom = i;
      x = 0;
    }
    if (w > maxW) {
      // A word wider than a whole row: hard character chunks.
      let cw = 0;
      for (let k = i; k < j; k++) {
        const chW = width(line[k]);
        if (k > segFrom && cw + chW > maxW) {
          segs.push({ from: segFrom, to: k });
          segFrom = k;
          cw = 0;
        }
        cw += chW;
      }
      x = cw;
      i = j;
      continue;
    }
    x += w;
    i = j;
  }
  segs.push({ from: segFrom, to: line.length });
  return segs;
}

/** The whole document as visual segments, in reading order. */
export function wrapDoc(lines: string[], maxW: number, width: (s: string) => number): VSeg[] {
  const out: VSeg[] = [];
  for (let row = 0; row < lines.length; row++) {
    for (const s of wrapLine(lines[row], maxW, width)) out.push({ row, from: s.from, to: s.to });
  }
  return out;
}

/** Segments of one line from host-computed break columns (the wrapText op:
 *  ascending UTF-16 indices, empty = fits). */
export function segsFromBreaks(
  len: number,
  breaks: readonly number[],
): { from: number; to: number }[] {
  if (breaks.length === 0) return [{ from: 0, to: len }];
  const segs: { from: number; to: number }[] = [];
  let from = 0;
  for (const b of breaks) {
    segs.push({ from, to: b });
    from = b;
  }
  segs.push({ from, to: len });
  return segs;
}

/** Index of the visual segment a caret sits on. A caret at a soft-wrap
 *  boundary column belongs to the next row's start unless it carries end
 *  affinity (End key, clicks past a wrapped row's text). */
export function vrowOf(segs: VSeg[], caret: Caret): number {
  let first = -1;
  let last = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].row !== caret.row) {
      if (last >= 0) break;
      continue;
    }
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return -1;
  for (let i = first; i <= last; i++) {
    if (caret.col < segs[i].to) {
      return caret.end && caret.col === segs[i].from && i > first ? i - 1 : i;
    }
  }
  return last;
}

/** Caret → (visual row, x px inside it). */
export function caretXY(
  segs: VSeg[],
  lines: string[],
  caret: Caret,
  width: (s: string) => number,
): { vrow: number; x: number } {
  const vrow = vrowOf(segs, caret);
  if (vrow < 0) return { vrow: 0, x: 0 };
  const s = segs[vrow];
  return { vrow, x: width(lines[s.row].slice(s.from, caret.col)) };
}

/** (visual row, x px) → caret, with end affinity when the hit lands past a
 *  soft-wrapped row's last column (the caret stays visibly on that row). */
export function caretAtPoint(
  segs: VSeg[],
  lines: string[],
  vrow: number,
  x: number,
  width: (s: string) => number,
): Caret {
  if (segs.length === 0) return { row: 0, col: 0 };
  const s = segs[Math.max(0, Math.min(segs.length - 1, vrow))];
  const col = s.from + colFromX(lines[s.row].slice(s.from, s.to), x, width);
  if (col === s.to && s.to < lines[s.row].length) return { row: s.row, col, end: true };
  return { row: s.row, col };
}

/** Selection span intersected with one visual segment (absolute cols). */
export function segSelSpan(doc: Doc, seg: VSeg): { from: number; to: number } | null {
  const span = rowSelSpan(doc, seg.row);
  if (!span) return null;
  const from = Math.max(span.from, seg.from);
  const to = Math.min(span.to, seg.to);
  return from >= to ? null : { from, to };
}

/** One caret move over the WRAPPED layout: Left/Right stay logical
 *  (applyMove), Up/Down step visual rows keeping the x offset, Home/End go
 *  to the visual row's bounds (End takes wrap affinity on soft-wrapped
 *  rows). Selection semantics mirror applyMove: shift extends from the
 *  anchor, a plain move over a selection collapses to the matching edge
 *  first. With one segment per line (wrap off) this IS the logical move. */
export function applyMoveWrapped(
  doc: Doc,
  key: CaretMove,
  extend: boolean,
  segs: VSeg[],
  width: (s: string) => number,
): Doc {
  if (key === "Left" || key === "Right") return applyMove(doc, key, extend);
  const lines = doc.lines;
  const r = selRange(doc);
  const base = !extend && r ? (key === "Up" || key === "Home" ? r.from : r.to) : doc.caret;
  const anchor = extend ? (doc.anchor ?? doc.caret) : null;
  const vi = vrowOf(segs, base);
  let caret: Caret;
  if (vi < 0) caret = base;
  else if (key === "Home") caret = { row: segs[vi].row, col: segs[vi].from };
  else if (key === "End") {
    const s = segs[vi];
    caret =
      s.to < lines[s.row].length ? { row: s.row, col: s.to, end: true } : { row: s.row, col: s.to };
  } else {
    const target = key === "Up" ? vi - 1 : vi + 1;
    if (target < 0 || target >= segs.length) caret = base;
    else {
      const s0 = segs[vi];
      const x = width(lines[base.row].slice(s0.from, base.col));
      caret = caretAtPoint(segs, lines, target, x, width);
    }
  }
  return extend ? { lines, caret, anchor } : { lines, caret };
}

/** Caret column from a click x, given per-prefix pixel widths. `measure`
 *  returns the width of a string prefix; binary-search-free linear scan is
 *  fine at Notepad line lengths. */
export function colFromX(line: string, x: number, measure: (s: string) => number): number {
  if (x <= 0) return 0;
  let prev = 0;
  for (let i = 1; i <= line.length; i++) {
    const w = measure(line.slice(0, i));
    if (x < (prev + w) / 2) return i - 1;
    prev = w;
  }
  return x >= prev ? line.length : line.length;
}
