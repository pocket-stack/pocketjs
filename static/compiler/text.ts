// static/compiler/text.ts — compile-time text layout. The runtime never
// measures: every SAY page and CHOICE option arrives pre-wrapped for the
// target, as a token stream (spec/isa.ts TOK_*).
//
// A page "atom" is either an ASCII char or a FMT slot (which reserves
// FMT_CELLS columns). Wrapping is greedy word-wrap on spaces; explicit \n
// forces a line break; a word longer than a line hard-breaks.

import { FMT_CELLS, TOK_ASCII_MAX, TOK_ASCII_MIN, TOK_END, TOK_FMT, TOK_NEWLINE, type TargetSpec } from "../spec/isa.ts";

export type TextAtom = { ch: string } | { fmtVar: number };

/** A logical text: literal runs + runtime format slots. */
export type RichText = TextAtom[];

export function richFromString(s: string): RichText {
  const out: RichText = [];
  for (const ch of s) out.push({ ch });
  return out;
}

export function richToDebugString(rt: RichText): string {
  return rt.map((a) => ("ch" in a ? a.ch : `{v${a.fmtVar}}`)).join("");
}

const atomCells = (a: TextAtom): number => ("ch" in a ? 1 : FMT_CELLS);

function checkAscii(a: TextAtom, context: string): void {
  if ("ch" in a && a.ch !== "\n") {
    const c = a.ch.charCodeAt(0);
    if (c < TOK_ASCII_MIN || c > TOK_ASCII_MAX) {
      throw new Error(`non-ASCII character ${JSON.stringify(a.ch)} in ${context} — v1 text is ASCII-only`);
    }
  }
}

/** Split a RichText into lines of at most `cols` cells (no pagination). */
export function wrapLines(rt: RichText, cols: number, context = "text"): RichText[] {
  // Tokenize into words (runs of non-space atoms) and explicit breaks.
  type Word = { atoms: RichText; cells: number };
  const lines: RichText[] = [];
  let line: RichText = [];
  let lineCells = 0;
  let word: Word = { atoms: [], cells: 0 };

  const flushWord = (): void => {
    if (word.atoms.length === 0) return;
    if (word.cells > cols) {
      // Hard-break an over-long word cell by cell.
      for (const a of word.atoms) {
        if (lineCells + atomCells(a) > cols) {
          lines.push(line);
          line = [];
          lineCells = 0;
        }
        line.push(a);
        lineCells += atomCells(a);
      }
      word = { atoms: [], cells: 0 };
      return;
    }
    const sep = line.length > 0 ? 1 : 0;
    if (lineCells + sep + word.cells > cols) {
      lines.push(line);
      line = [];
      lineCells = 0;
    } else if (sep) {
      line.push({ ch: " " });
      lineCells += 1;
    }
    line.push(...word.atoms);
    lineCells += word.cells;
    word = { atoms: [], cells: 0 };
  };

  for (const a of rt) {
    checkAscii(a, context);
    if ("ch" in a && a.ch === "\n") {
      flushWord();
      lines.push(line);
      line = [];
      lineCells = 0;
      continue;
    }
    if ("ch" in a && a.ch === " ") {
      flushWord();
      continue;
    }
    word.atoms.push(a);
    word.cells += atomCells(a);
  }
  flushWord();
  lines.push(line);
  // Drop a single trailing empty line produced by a trailing \n, keep
  // intentional blank lines elsewhere.
  while (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

/** Wrap + paginate for a target's textbox. Returns pages of lines. */
export function wrapPages(rt: RichText, t: TargetSpec, context = "text"): RichText[][] {
  const lines = wrapLines(rt, t.textCols, context);
  const pages: RichText[][] = [];
  for (let i = 0; i < lines.length; i += t.textLines) {
    pages.push(lines.slice(i, i + t.textLines));
  }
  return pages;
}

/** Encode one page (lines joined by TOK_NEWLINE) as a token stream. */
export function encodePage(lines: RichText[]): Uint8Array {
  const bytes: number[] = [];
  lines.forEach((line, i) => {
    if (i > 0) bytes.push(TOK_NEWLINE);
    for (const a of line) {
      if ("ch" in a) bytes.push(a.ch.charCodeAt(0));
      else bytes.push(TOK_FMT, a.fmtVar);
    }
  });
  bytes.push(TOK_END);
  return Uint8Array.from(bytes);
}

/** A single-line text (choice options): must fit `cols`, no newlines. */
export function encodeOption(rt: RichText, cols: number, context: string): Uint8Array {
  let cells = 0;
  for (const a of rt) {
    checkAscii(a, context);
    if ("ch" in a && a.ch === "\n") throw new Error(`${context}: choice options are single-line`);
    cells += atomCells(a);
  }
  if (cells > cols) throw new Error(`${context}: option is ${cells} cells, max ${cols}`);
  const bytes: number[] = [];
  for (const a of rt) {
    if ("ch" in a) bytes.push(a.ch.charCodeAt(0));
    else bytes.push(TOK_FMT, a.fmtVar);
  }
  bytes.push(TOK_END);
  return Uint8Array.from(bytes);
}
