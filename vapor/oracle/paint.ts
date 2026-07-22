// vapor/oracle/paint.ts — interpret a micro-DOM tree as the 30x20 cell grid.
//
// The painter is the oracle's "video chip": it walks <row> elements in
// document order and composes the same cell grid the GBA runtime keeps in
// its shadow buffer — chars padded with spaces to the right edge, palette
// per cell, later rows overwriting earlier ones.

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

export function paintGrid(root: VaporElement, width = GRID_W, height = GRID_H): CellGrid {
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
    const pal = Number(row.getAttribute("pal") ?? 0) | 0;
    const text = rowText(row);
    for (let col = x; col < width; col++) {
      const ch = text[col - x] ?? " ";
      const code = ch.charCodeAt(0);
      chars[y][col] = code >= 0x20 && code <= 0x7e ? ch : "?";
      pals[y][col] = pal;
    }
  }

  return { chars: chars.map((line) => line.join("")), pals };
}
