// apps/desk98/notepad.ts — pure Notepad line-editing rules (wrap off, like
// the 98 default). No Solid, no framework imports — unit-tested directly.

export interface Caret {
  row: number;
  col: number;
}

export interface Doc {
  lines: string[];
  caret: Caret;
}

function clampCaret(lines: string[], caret: Caret): Caret {
  const row = Math.max(0, Math.min(caret.row, lines.length - 1));
  const col = Math.max(0, Math.min(caret.col, lines[row].length));
  return { row, col };
}

/** Insert typed text at the caret; \n splits the line. */
export function insertText(doc: Doc, s: string): Doc {
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
