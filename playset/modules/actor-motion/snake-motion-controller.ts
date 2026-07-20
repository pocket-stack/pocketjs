// playset/modules/actor-motion/snake-motion-controller.ts — grid snake body:
// segment queue, pending growth, and cardinal/chase turning (reversals are
// structurally impossible).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/actor-motion/SnakeMotionController.js. Verbatim semantics.

export interface SnakeCell {
  right: number;
  forward: number;
}

export type SnakeMode = "cardinal" | "chase";

export interface SnakeMotionControllerOptions {
  initialLength?: number;
  initialDirection?: SnakeCell;
  startCell?: SnakeCell;
  segments?: SnakeCell[] | null;
  pendingGrowth?: number;
  mode?: SnakeMode;
}

export interface SnakeResetOptions {
  segments?: SnakeCell[] | null;
  initialLength?: number;
  direction?: SnakeCell;
  startCell?: SnakeCell;
  pendingGrowth?: number;
}

export interface SnakeMoveOptions {
  left?: boolean;
  right?: boolean;
  forward?: boolean;
  backward?: boolean;
}

export interface SnakeMoveResult {
  direction: SnakeCell;
  segments: SnakeCell[];
}

const cloneCell = (cell: SnakeCell): SnakeCell => {
  return {
    right: Math.floor(cell.right),
    forward: Math.floor(cell.forward),
  };
};

const cloneCells = (cells: SnakeCell[] = []): SnakeCell[] => cells.map(cloneCell);

const CARDINAL_DIRECTIONS: readonly SnakeCell[] = [
  { right: 0, forward: 1 },
  { right: 1, forward: 0 },
  { right: 0, forward: -1 },
  { right: -1, forward: 0 },
];

function turnRelativeLeft(direction: SnakeCell): SnakeCell {
  const index = CARDINAL_DIRECTIONS.findIndex((item) =>
    item.right === direction.right && item.forward === direction.forward,
  );

  return CARDINAL_DIRECTIONS[(index + 3) % 4];
}

function turnRelativeRight(direction: SnakeCell): SnakeCell {
  const index = CARDINAL_DIRECTIONS.findIndex((item) =>
    item.right === direction.right && item.forward === direction.forward,
  );

  return CARDINAL_DIRECTIONS[(index + 1) % 4];
}

export function stepSnakeCell(cell: SnakeCell, direction: SnakeCell): SnakeCell {
  const current = cloneCell(cell);
  const vector = direction;

  return {
    right: current.right + vector.right,
    forward: current.forward + vector.forward,
  };
}

function createDefaultSegments(
  initialLength: number,
  direction: SnakeCell,
  startCell: SnakeCell,
): SnakeCell[] {
  const head = cloneCell(startCell);
  const segments = [head];
  let cursor = head;
  const reverseDirection = {
    right: -direction.right,
    forward: -direction.forward,
  };

  for (let index = 1; index < initialLength; index += 1) {
    cursor = stepSnakeCell(cursor, reverseDirection);
    segments.push(cursor);
  }

  return segments;
}

export class SnakeMotionController {
  mode: SnakeMode;
  initialLength: number;
  initialDirection: SnakeCell;
  startCell: SnakeCell;
  pendingGrowth: number;
  segments: SnakeCell[];
  direction!: SnakeCell; // assigned by reset() in the constructor

  constructor({
    initialLength = 4,
    initialDirection = { forward: 1, right: 0 },
    startCell = { forward: 0, right: 0 },
    segments = null,
    pendingGrowth = 0,
    mode = "cardinal",
  }: SnakeMotionControllerOptions) {
    this.mode = mode;
    this.initialLength = Math.max(2, Math.floor(initialLength));
    this.initialDirection = {
      right: initialDirection.right,
      forward: initialDirection.forward,
    };
    this.startCell = cloneCell(startCell);

    this.pendingGrowth = 0;
    this.segments = [];

    this.reset({
      segments,
      pendingGrowth,
    });
  }

  get head(): SnakeCell | null {
    return this.segments[0] ? cloneCell(this.segments[0]) : null;
  }

  get tail(): SnakeCell | null {
    return this.segments.length > 0 ? cloneCell(this.segments[this.segments.length - 1]) : null;
  }

  get length(): number {
    return this.segments.length;
  }

  getDirection(): SnakeCell {
    return {
      right: this.direction.right,
      forward: this.direction.forward,
    };
  }

  reset({
    segments = null,
    initialLength = this.initialLength,
    direction = this.initialDirection,
    startCell = this.startCell,
    pendingGrowth = 0,
  }: SnakeResetOptions): SnakeCell[] {
    this.direction = {
      right: direction.right,
      forward: direction.forward,
    };
    this.segments = segments
      ? cloneCells(segments)
      : createDefaultSegments(initialLength, direction, startCell);
    this.pendingGrowth = Math.max(0, Math.floor(pendingGrowth));
    return this.getSegments();
  }

  grow(amount = 1): number {
    this.pendingGrowth += Math.max(0, Math.floor(amount));
    return this.pendingGrowth;
  }

  // left/right: true turns toward the relative left/right directions in chase mode.
  // left/right/forward/backward: true moves toward allowed basis-cardinal directions in cardinal mode.
  move({
    left = false,
    right = false,
    forward = false,
    backward = false,
  }: SnakeMoveOptions): SnakeMoveResult {
    let direction: SnakeCell = {
      right: this.direction.right,
      forward: this.direction.forward,
    };

    if (this.mode === "chase") {
      if (left && !right) {
        direction = turnRelativeLeft(direction);
      } else if (right && !left) {
        direction = turnRelativeRight(direction);
      }
    } else if (direction.forward !== 0) {
      if (left && !right) {
        direction = CARDINAL_DIRECTIONS[3];
      } else if (right && !left) {
        direction = CARDINAL_DIRECTIONS[1];
      }
    } else if (direction.right !== 0) {
      if (forward && !backward) {
        direction = CARDINAL_DIRECTIONS[0];
      } else if (backward && !forward) {
        direction = CARDINAL_DIRECTIONS[2];
      }
    }

    const head = this.head!;
    const nextHead = stepSnakeCell(head, direction);
    const isGrowing = this.pendingGrowth > 0;
    const pendingGrowth = this.pendingGrowth;
    const pendingGrowthAfter = Math.max(0, pendingGrowth - (isGrowing ? 1 : 0));
    const segments = [
      nextHead,
      ...this.segments.slice(0, isGrowing ? this.segments.length : -1),
    ];

    this.direction = {
      right: direction.right,
      forward: direction.forward,
    };
    this.pendingGrowth = pendingGrowthAfter;
    this.segments = cloneCells(segments);

    return {
      direction: {
        right: direction.right,
        forward: direction.forward,
      },
      segments: this.getSegments(),
    };
  }

  getSegments(): SnakeCell[] {
    return cloneCells(this.segments);
  }
}
