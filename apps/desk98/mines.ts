// apps/desk98/mines.ts — pure Minesweeper rules (beginner 9×9, 10 mines).
// No Solid, no framework imports — unit-tested directly. First reveal is
// always safe: mines place after it, excluding the clicked cell.

export const MINES_W = 9;
export const MINES_H = 9;
export const MINES_N = 10;

export type CellState = "hidden" | "flag" | "revealed";

export interface Cell {
  mine: boolean;
  adj: number;
  state: CellState;
}

export type Phase = "ready" | "playing" | "won" | "lost";

export interface Mines {
  cells: Cell[]; // row-major MINES_W × MINES_H
  phase: Phase;
  flags: number;
  revealed: number;
  /** Index of the mine that ended the game (drawn red), -1 otherwise. */
  bust: number;
  seed: number;
}

/** mulberry32 — deterministic placement from a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newMines(seed: number): Mines {
  return {
    cells: Array.from({ length: MINES_W * MINES_H }, () => ({
      mine: false,
      adj: 0,
      state: "hidden" as CellState,
    })),
    phase: "ready",
    flags: 0,
    revealed: 0,
    bust: -1,
    seed,
  };
}

function neighbors(i: number): number[] {
  const x = i % MINES_W;
  const y = (i / MINES_W) | 0;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < MINES_W && ny >= 0 && ny < MINES_H) out.push(ny * MINES_W + nx);
    }
  }
  return out;
}

function place(m: Mines, safe: number): void {
  const rand = rng(m.seed);
  let planted = 0;
  while (planted < MINES_N) {
    const i = Math.floor(rand() * MINES_W * MINES_H);
    if (i === safe || m.cells[i].mine) continue;
    m.cells[i].mine = true;
    planted++;
  }
  for (let i = 0; i < m.cells.length; i++) {
    m.cells[i].adj = neighbors(i).filter((n) => m.cells[n].mine).length;
  }
}

/** Reveal a cell (mutates and returns m). Floods zero-adjacency regions. */
export function reveal(m: Mines, i: number): Mines {
  if (m.phase === "won" || m.phase === "lost") return m;
  const c = m.cells[i];
  if (c.state !== "hidden") return m;
  if (m.phase === "ready") {
    place(m, i);
    m.phase = "playing";
  }
  if (c.mine) {
    m.phase = "lost";
    m.bust = i;
    for (const cell of m.cells) {
      if (cell.mine && cell.state !== "flag") cell.state = "revealed";
    }
    return m;
  }
  const stack = [i];
  while (stack.length > 0) {
    const j = stack.pop()!;
    const cj = m.cells[j];
    if (cj.state === "revealed" || cj.state === "flag" || cj.mine) continue;
    cj.state = "revealed";
    m.revealed++;
    if (cj.adj === 0) for (const n of neighbors(j)) stack.push(n);
  }
  if (m.revealed === MINES_W * MINES_H - MINES_N) {
    m.phase = "won";
    // Convention: flag every remaining mine on a win.
    for (const cell of m.cells) if (cell.mine) cell.state = "flag";
    m.flags = MINES_N;
  }
  return m;
}

/** Toggle a flag (right-click). */
export function toggleFlag(m: Mines, i: number): Mines {
  if (m.phase === "won" || m.phase === "lost") return m;
  const c = m.cells[i];
  if (c.state === "revealed") return m;
  if (c.state === "flag") {
    c.state = "hidden";
    m.flags--;
  } else {
    c.state = "flag";
    m.flags++;
  }
  return m;
}
