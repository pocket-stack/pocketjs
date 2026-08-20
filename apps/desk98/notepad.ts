// apps/desk98/notepad.ts — pure Notepad line-editing rules (wrap off, like
// the 98 default): insertion, deletion, caret movement and the selection
// model (anchor + caret). No framework imports — unit-tested directly.

export interface Caret {
  row: number;
  col: number;
}

export interface Doc {
  lines: string[];
  caret: Caret;
  /** Selection anchor (the other end of the range); null/absent = none.
   *  Every edit collapses it — edited Docs never carry a stale anchor. */
  anchor?: Caret | null;
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
