// playset/modules/behavior/grid-path-planner.ts — A* routes and flood-fill
// reachability on a grid board with blocked cells and wrapping or bounded
// edges.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/behavior/GridPathPlanner.js. Verbatim semantics.

export interface GridCell {
  right: number;
  forward: number;
}

/** Injected movement model: per-direction step vectors + expansion order. */
export interface GridNavigation {
  vectors: Readonly<Record<string, GridCell>>;
  neighborOrder: readonly string[];
}

export type BlockedCellsInput =
  | ReadonlySet<string>
  | ReadonlyArray<GridCell | string | null | undefined>
  | null
  | undefined;

export interface GridNeighbor {
  cell: GridCell;
  direction: string;
}

interface OpenEntry {
  key: string;
  cell: GridCell;
  f: number;
}

function cloneCell(cell: GridCell): GridCell {
  return {
    right: Math.floor(cell.right),
    forward: Math.floor(cell.forward),
  };
}

export function gridCellKey(cell: GridCell): string {
  return `${Math.floor(cell.right)}:${Math.floor(cell.forward)}`;
}

export function normalizeBlockedCells(blocked: BlockedCellsInput = []): Set<string> {
  if (blocked instanceof Set) return new Set(blocked);
  const keys = new Set<string>();
  for (const cell of (blocked as ReadonlyArray<GridCell | string | null | undefined>) ?? []) {
    if (!cell) continue;
    if (typeof cell === "string") {
      keys.add(cell);
    } else {
      keys.add(gridCellKey(cell));
    }
  }
  return keys;
}

function wrapDelta(delta: number, size: number): number {
  return Math.min(Math.abs(delta), size - Math.abs(delta));
}

function priorityInsert(open: OpenEntry[], entry: OpenEntry): void {
  let index = open.length;
  while (index > 0 && open[index - 1].f > entry.f) {
    index -= 1;
  }
  open.splice(index, 0, entry);
}

function stepCell(
  cell: GridCell,
  direction: string,
  board: { columns: number; rows: number },
  wrap: boolean,
  navigation: GridNavigation,
): GridCell | null {
  const vector = navigation.vectors[direction];
  const next = {
    right: cell.right + vector.right,
    forward: cell.forward + vector.forward,
  };

  if (wrap) {
    if (next.right < 0) next.right = board.columns - 1;
    if (next.right >= board.columns) next.right = 0;
    if (next.forward < 0) next.forward = board.rows - 1;
    if (next.forward >= board.rows) next.forward = 0;
    return next;
  }

  if (
    next.right < 0 ||
    next.right >= board.columns ||
    next.forward < 0 ||
    next.forward >= board.rows
  ) {
    return null;
  }

  return next;
}

export interface GridPathPlannerOptions {
  navigation: GridNavigation;
  columns?: number;
  rows?: number;
  wrap?: boolean;
  neighborOrder?: readonly string[] | null;
}

export class GridPathPlanner {
  navigation: GridNavigation;
  columns: number;
  rows: number;
  wrap: boolean;
  neighborOrder: string[];

  constructor({ navigation, columns = 20, rows = 20, wrap = true, neighborOrder = null }: GridPathPlannerOptions) {
    this.navigation = navigation;
    this.columns = Math.floor(columns);
    this.rows = Math.floor(rows);
    this.wrap = wrap !== false;
    this.neighborOrder = [...(neighborOrder ?? this.navigation.neighborOrder)];
  }

  setBoard(columns: number = this.columns, rows: number = this.rows, wrap: boolean = this.wrap): this {
    this.columns = Math.floor(columns);
    this.rows = Math.floor(rows);
    this.wrap = wrap !== false;
    return this;
  }

  heuristic(a: GridCell, b: GridCell): number {
    const dRight = this.wrap
      ? wrapDelta(a.right - b.right, this.columns)
      : Math.abs(a.right - b.right);
    const dForward = this.wrap
      ? wrapDelta(a.forward - b.forward, this.rows)
      : Math.abs(a.forward - b.forward);
    return dRight + dForward;
  }

  getNeighbors(cell: GridCell, wrap: boolean = this.wrap): GridNeighbor[] {
    const neighbors: GridNeighbor[] = [];
    for (const direction of this.neighborOrder) {
      const next = stepCell(cell, direction, this, wrap, this.navigation);
      if (!next) continue;
      neighbors.push({
        cell: next,
        direction,
      });
    }
    return neighbors;
  }

  findPath(
    start: GridCell | null | undefined,
    goal: GridCell | null | undefined,
    blocked: BlockedCellsInput = [],
    allowStartOccupied = true,
    allowGoalOccupied = true,
    wrap: boolean = this.wrap,
  ): GridCell[] | null {
    if (!start || !goal) return null;

    const startCell = cloneCell(start);
    const goalCell = cloneCell(goal);
    const startKey = gridCellKey(startCell);
    const goalKey = gridCellKey(goalCell);
    const blockedKeys = normalizeBlockedCells(blocked);
    if (allowStartOccupied) blockedKeys.delete(startKey);
    if (allowGoalOccupied) blockedKeys.delete(goalKey);

    if (startKey === goalKey) {
      return [startCell];
    }

    const open: OpenEntry[] = [];
    const cameFrom = new Map<string, { key: string; cell: GridCell; direction: string }>();
    const costSoFar = new Map<string, number>();

    costSoFar.set(startKey, 0);
    priorityInsert(open, {
      key: startKey,
      cell: startCell,
      f: this.heuristic(startCell, goalCell),
    });

    while (open.length > 0) {
      const current = open.shift()!;
      if (current.key === goalKey) {
        const path = [goalCell];
        let cursorKey = goalKey;
        while (cursorKey !== startKey) {
          const prev = cameFrom.get(cursorKey);
          if (!prev) return null;
          path.push(prev.cell);
          cursorKey = prev.key;
        }
        path.reverse();
        return path;
      }

      const currentCost = costSoFar.get(current.key) ?? 0;
      for (const neighbor of this.getNeighbors(current.cell, wrap)) {
        const neighborKey = gridCellKey(neighbor.cell);
        if (blockedKeys.has(neighborKey)) continue;

        const nextCost = currentCost + 1;
        if (nextCost >= (costSoFar.get(neighborKey) ?? Infinity)) continue;

        costSoFar.set(neighborKey, nextCost);
        cameFrom.set(neighborKey, {
          key: current.key,
          cell: current.cell,
          direction: neighbor.direction,
        });
        priorityInsert(open, {
          key: neighborKey,
          cell: neighbor.cell,
          f: nextCost + this.heuristic(neighbor.cell, goalCell),
        });
      }
    }

    return null;
  }

  floodFill(
    start: GridCell | null | undefined,
    blocked: BlockedCellsInput = [],
    allowStartOccupied = true,
    wrap: boolean = this.wrap,
    limit = Infinity,
  ): { count: number; cells: GridCell[] } {
    if (!start) {
      return { count: 0, cells: [] };
    }

    const startCell = cloneCell(start);
    const startKey = gridCellKey(startCell);
    const blockedKeys = normalizeBlockedCells(blocked);
    if (allowStartOccupied) blockedKeys.delete(startKey);

    if (blockedKeys.has(startKey)) {
      return { count: 0, cells: [] };
    }

    const queue = [startCell];
    const seen = new Set([startKey]);
    const cells: GridCell[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      cells.push(current);
      if (cells.length >= limit) break;

      for (const neighbor of this.getNeighbors(current, wrap)) {
        const neighborKey = gridCellKey(neighbor.cell);
        if (seen.has(neighborKey) || blockedKeys.has(neighborKey)) continue;
        seen.add(neighborKey);
        queue.push(neighbor.cell);
      }
    }

    return {
      count: cells.length,
      cells,
    };
  }
}
