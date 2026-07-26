// vapor/oracle/paint.ts — interpret a micro-DOM tree as the 30x20 cell grid.
//
// The painter is the oracle's "video chip": it walks <row> elements in
// document order and composes the same cell grid the GBA runtime keeps in
// its shadow buffer — chars padded with spaces to the right edge, palette
// per cell, later rows overwriting earlier ones.

import { parseRowClass, StyleTable } from "../compiler/styles.ts";
import { VaporComment, VaporElement, VaporText, type VaporNode } from "./dom.ts";

export const GRID_W = 30;
export const GRID_H = 20;

export interface CellGrid {
  /** GRID_H strings of GRID_W chars. */
  chars: string[];
  /** GRID_H rows of GRID_W palette ids. */
  pals: number[][];
}

function rowText(el: VaporElement): string {
  let out = "";
  const walk = (node: VaporNode): void => {
    if (node instanceof VaporText) out += node.text;
    else if (node instanceof VaporComment) return;
    else if (node instanceof VaporElement) for (const child of node.children) walk(child);
  };
  for (const child of el.children) walk(child);
  return out;
}

function collectRows(root: VaporElement, out: VaporElement[]): void {
  for (const child of root.children) {
    if (!(child instanceof VaporElement)) continue;
    if (child.tag === "row") out.push(child);
    else collectRows(child, out);
  }
}

export function paintGrid(
  root: VaporElement,
  width = GRID_W,
  height = GRID_H,
  styles?: StyleTable,
): CellGrid {
  const chars: string[][] = [];
  const pals: number[][] = [];
  for (let y = 0; y < height; y++) {
    chars.push(new Array<string>(width).fill(" "));
    pals.push(new Array<number>(width).fill(0));
  }

  const rows: VaporElement[] = [];
  collectRows(root, rows);
  for (const row of rows) {
    const y = Number(row.getAttribute("y") ?? -1) | 0;
    if (y < 0 || y >= height) throw new Error(`row y out of range: ${row.getAttribute("y")}`);
    const x = Number(row.getAttribute("x") ?? 0) | 0;
    const cls = (row.getAttribute("class") ?? "").trim().replace(/\s+/g, " ");
    let pal = 0;
    let align = 0;
    if (styles) {
      const hit = styles.byClass.get(cls);
      if (hit) {
        pal = hit.id;
        align = hit.align;
      } else {
        // vapor's classList diffing may reorder tokens vs the literal:
        // resolve by parsing, then find the (already interned) pair
        const { style, issues } = parseRowClass(cls);
        if (issues.length) throw new Error(`oracle painter: bad class "${cls}": ${issues[0].message}`);
        const id = styles.pairs.findIndex((p) => p.ink === style.ink && p.paper === style.paper);
        if (id < 0) throw new Error(`oracle painter: class "${cls}" resolves to a pair the compile never interned`);
        pal = id;
        align = style.align;
      }
    }
    const text = rowText(row).slice(0, width);
    const start = align === 1 ? (width - text.length) >> 1 : align === 2 ? width - text.length : x;
    // a row owns its whole line: full-width fill in the row's pair
    for (let col = 0; col < width; col++) {
      const ch = col >= start && col - start < text.length ? text[col - start] : " ";
      const code = ch.charCodeAt(0);
      chars[y][col] = code >= 0x20 && code <= 0x7e ? ch : "?";
      pals[y][col] = pal;
    }
  }

  return { chars: chars.map((line) => line.join("")), pals };
}
