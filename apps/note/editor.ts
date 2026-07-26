// apps/note/editor.ts — the text-editing model: offset-preserving soft
// wrap and caret math over a plain string document.
//
// Deliberately framework-free and measure-injected: the widget passes the
// measureText-backed body font measure, bun tests pass a fake — the entire
// editor (wrap positions, caret movement, click placement, edits) is
// deterministic pure math, testable without a host. The display contract:
// a document is wrapped into DLines, each an exact [start, end) slice of
// the source (soft breaks land after a space when one fits; explicit '\n'
// separates source lines and is owned by the line it terminates).

export type Measure = (text: string) => number;

export interface DLine {
  /** Global char offset of the first char on this display line. */
  start: number;
  /** Global char offset one past the last char (excludes the '\n'). */
  end: number;
  /** True when this line ends with a soft (wrap) break, not a '\n'. */
  soft: boolean;
}

/**
 * Wrap `doc` at `maxW` px. Greedy over chars with word-boundary backtrack:
 * a line breaks after the last space that fits; a spaceless overflow breaks
 * mid-word. Every char of the source lands on exactly one line, so
 * caret ↔ (line, x) mapping is total and unambiguous.
 */
export function layoutDoc(doc: string, maxW: number, measure: Measure): DLine[] {
  const lines: DLine[] = [];
  let offset = 0;
  for (const src of doc.split("\n")) {
    let start = 0; // relative to src
    while (src.length - start > 0) {
      let w = 0;
      let lastSpace = -1;
      let i = start;
      for (; i < src.length; i++) {
        const cw = measure(src[i]);
        if (i > start && w + cw > maxW) break;
        w += cw;
        if (src[i] === " ") lastSpace = i;
      }
      if (i >= src.length) {
        lines.push({ start: offset + start, end: offset + src.length, soft: false });
        start = src.length;
      } else {
        // Break after the last space that fit, else mid-word at i.
        const cut = lastSpace >= start ? lastSpace + 1 : i;
        lines.push({ start: offset + start, end: offset + cut, soft: true });
        start = cut;
      }
    }
    if (src.length === 0) {
      lines.push({ start: offset, end: offset, soft: false });
    }
    offset += src.length + 1; // + '\n'
  }
  if (lines.length === 0) lines.push({ start: 0, end: 0, soft: false });
  return lines;
}

/**
 * The display line a caret sits on. A caret at a soft break boundary
 * belongs to the NEXT line (after the space, start of the wrapped word);
 * at a hard '\n' it belongs to the line before (end of that line).
 */
export function caretLine(lines: DLine[], caret: number): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (caret < line.end) return i;
    if (caret === line.end) {
      return line.soft && i + 1 < lines.length ? i + 1 : i;
    }
  }
  return lines.length - 1;
}

/** Caret x in px on its display line. */
export function caretX(doc: string, lines: DLine[], caret: number, measure: Measure): number {
  const line = lines[caretLine(lines, caret)];
  return measure(doc.slice(line.start, Math.max(line.start, Math.min(caret, line.end))));
}

/**
 * Place a caret from a click at (x, lineIndex): the nearest char boundary
 * by midpoint. Clicks past the end land at the line end (before any '\n').
 */
export function caretFromX(
  doc: string,
  lines: DLine[],
  lineIndex: number,
  x: number,
  measure: Measure,
): number {
  const line = lines[Math.max(0, Math.min(lineIndex, lines.length - 1))];
  let acc = 0;
  for (let i = line.start; i < line.end; i++) {
    const cw = measure(doc[i]);
    if (x < acc + cw / 2) return i;
    acc += cw;
  }
  // A caret at the end of a soft line sits *before* its trailing space —
  // after it, it would render at the start of the next line.
  if (line.soft && line.end > line.start && doc[line.end - 1] === " ") {
    return line.end - 1;
  }
  return line.end;
}

export interface EditState {
  doc: string;
  caret: number;
}

export function insertAt(state: EditState, text: string): EditState {
  return {
    doc: state.doc.slice(0, state.caret) + text + state.doc.slice(state.caret),
    caret: state.caret + text.length,
  };
}

export function backspace(state: EditState): EditState {
  if (state.caret === 0) return state;
  return {
    doc: state.doc.slice(0, state.caret - 1) + state.doc.slice(state.caret),
    caret: state.caret - 1,
  };
}

export function del(state: EditState): EditState {
  if (state.caret >= state.doc.length) return state;
  return {
    doc: state.doc.slice(0, state.caret) + state.doc.slice(state.caret + 1),
    caret: state.caret,
  };
}

/** Vertical caret move with a sticky goal x (the column you came from). */
export function moveVertical(
  doc: string,
  lines: DLine[],
  caret: number,
  dir: -1 | 1,
  goalX: number,
  measure: Measure,
): number {
  const line = caretLine(lines, caret);
  const target = line + dir;
  if (target < 0) return 0;
  if (target >= lines.length) return doc.length;
  return caretFromX(doc, lines, target, goalX, measure);
}

export function lineStart(lines: DLine[], caret: number): number {
  return lines[caretLine(lines, caret)].start;
}

export function lineEnd(lines: DLine[], caret: number): number {
  const line = lines[caretLine(lines, caret)];
  if (line.soft && line.end > line.start) return line.end - 1;
  return line.end;
}

// ---------------------------------------------------------------------------
// Selection: {doc, caret, anchor} — anchor == caret means no selection.
// Every mutation collapses the selection; the app renders [lo, hi) rects.
// ---------------------------------------------------------------------------

export interface SelEdit {
  doc: string;
  caret: number;
  anchor: number;
}

/** Normalized [lo, hi) selection bounds. */
export function selBounds(s: SelEdit): [number, number] {
  return s.caret <= s.anchor ? [s.caret, s.anchor] : [s.anchor, s.caret];
}

export function hasSelection(s: SelEdit): boolean {
  return s.caret !== s.anchor;
}

/** Replace the selection (or insert at the caret) with `text`. */
export function typeText(s: SelEdit, text: string): SelEdit {
  const [lo, hi] = selBounds(s);
  const caret = lo + text.length;
  return { doc: s.doc.slice(0, lo) + text + s.doc.slice(hi), caret, anchor: caret };
}

/** Backspace: selection deletes it; a bare caret eats one char left. */
export function backspaceSel(s: SelEdit): SelEdit {
  if (hasSelection(s)) return typeText(s, "");
  if (s.caret === 0) return s;
  return {
    doc: s.doc.slice(0, s.caret - 1) + s.doc.slice(s.caret),
    caret: s.caret - 1,
    anchor: s.caret - 1,
  };
}

/** Forward delete: selection deletes it; a bare caret eats one char right. */
export function deleteSel(s: SelEdit): SelEdit {
  if (hasSelection(s)) return typeText(s, "");
  if (s.caret >= s.doc.length) return s;
  return { doc: s.doc.slice(0, s.caret) + s.doc.slice(s.caret + 1), caret: s.caret, anchor: s.caret };
}

// ---------------------------------------------------------------------------
// Undo/redo: snapshot stack with run coalescing. Documents are note-sized,
// so whole-doc snapshots beat operational inverses on every axis that
// matters here (simplicity, correctness under selection edits).
// ---------------------------------------------------------------------------

/** Coalescing class of an edit: consecutive "type"s (typing a run) and
 *  consecutive "delete"s (holding backspace) merge into one undo step;
 *  "other" never merges. */
export type EditKind = "type" | "delete" | "other";

export interface History {
  past: SelEdit[];
  future: SelEdit[];
  /** The kind of the edit that produced the CURRENT state (coalescing). */
  last: EditKind | null;
}

export const HISTORY_LIMIT = 200;

export function emptyHistory(): History {
  return { past: [], future: [], last: null };
}

/** Record `before` as an undo point for an edit of `kind`. Coalesces runs:
 *  if the previous edit had the same mergeable kind, the earlier snapshot
 *  already covers this run. Any edit clears the redo stack. */
export function recordEdit(h: History, before: SelEdit, kind: EditKind): void {
  h.future.length = 0;
  const merge = kind !== "other" && h.last === kind;
  if (!merge) {
    h.past.push(before);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
  }
  h.last = kind;
}

/** Caret moved by navigation/click — the next typed char starts a new run. */
export function breakRun(h: History): void {
  h.last = null;
}

export function undo(h: History, current: SelEdit): SelEdit | null {
  const state = h.past.pop();
  if (!state) return null;
  h.future.push(current);
  h.last = null;
  return state;
}

export function redo(h: History, current: SelEdit): SelEdit | null {
  const state = h.future.pop();
  if (!state) return null;
  h.past.push(current);
  h.last = null;
  return state;
}
