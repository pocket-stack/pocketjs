// playset/modules/gameplay/snake-play.ts — grid-snake referee: wall / self /
// snake-vs-snake collisions and item pickups on a right/forward cell grid.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/SnakePlay.js. Verbatim semantics.

export const SNAKE_PLAY_EVENTS = Object.freeze({
  ITEM_PICKED_UP: "snake.item.picked-up",
  PLAYER_DIED: "snake.died",
} as const);

export const SNAKE_DEATH_REASONS = Object.freeze({
  WALL: "wall",
  SELF: "self",
  SNAKE: "snake",
} as const);

export type SnakeDeathReason = (typeof SNAKE_DEATH_REASONS)[keyof typeof SNAKE_DEATH_REASONS];

export interface SnakeCell {
  right: number;
  forward: number;
}

export interface SnakePlayerState {
  playerId: string;
  segments: SnakeCell[];
  alive: boolean;
}

export interface SnakeItemState {
  cell: SnakeCell;
  growth: number;
}

export type SnakePlayEvent =
  | {
      type: typeof SNAKE_PLAY_EVENTS.PLAYER_DIED;
      playerId: string;
      reason: SnakeDeathReason;
      cell: SnakeCell | null;
      hitPlayerId?: string;
    }
  | {
      type: typeof SNAKE_PLAY_EVENTS.ITEM_PICKED_UP;
      playerId: string;
      cell: SnakeCell;
      growBy: number;
    };

export interface SnakePlayOptions {
  minRight: number;
  maxRight: number;
  minForward: number;
  maxForward: number;
}

function cloneCell(cell: SnakeCell): SnakeCell {
  return {
    right: Math.floor(cell.right),
    forward: Math.floor(cell.forward),
  };
}

function cloneCells(cells: SnakeCell[]): SnakeCell[] {
  return cells.map(cloneCell);
}

function cellKey(cell: SnakeCell): string {
  return `${cell.right}:${cell.forward}`;
}

function clonePlayer(player: SnakePlayerState): SnakePlayerState {
  return {
    playerId: player.playerId,
    segments: cloneCells(player.segments),
    alive: player.alive,
  };
}

function createPlayer({ playerId, segments }: { playerId: string; segments: SnakeCell[] }): SnakePlayerState {
  return {
    playerId,
    segments: cloneCells(segments),
    alive: true,
  };
}

export class SnakePlay {
  minRight: number;
  maxRight: number;
  minForward: number;
  maxForward: number;
  players: Map<string, SnakePlayerState>;
  items: Map<string, SnakeItemState>;

  constructor({ minRight, maxRight, minForward, maxForward }: SnakePlayOptions) {
    this.minRight = Math.floor(minRight);
    this.maxRight = Math.floor(maxRight);
    this.minForward = Math.floor(minForward);
    this.maxForward = Math.floor(maxForward);
    this.players = new Map();
    this.items = new Map();
  }

  addPlayer({ playerId, segments }: { playerId: string; segments: SnakeCell[] }): void {
    if (this.players.has(playerId)) {
      throw new Error(`player already exists: ${playerId}`);
    }

    this.players.set(playerId, createPlayer({ playerId, segments }));
  }

  movePlayer({ playerId, segments }: { playerId: string; segments: SnakeCell[] }): void {
    const player = this._getPlayer(playerId);
    player.segments = cloneCells(segments);
  }

  addItem({ cell, growth = 1 }: { cell: SnakeCell; growth?: number }): void {
    const nextItem = {
      cell: cloneCell(cell),
      growth: Math.max(0, Math.floor(growth)),
    };
    const key = cellKey(nextItem.cell);
    if (this.items.has(key)) {
      throw new Error(`item already exists at cell: ${key}`);
    }

    this.items.set(key, nextItem);
  }

  step(): SnakePlayEvent[] {
    const events: SnakePlayEvent[] = [];
    const alivePlayerIds = new Set(
      Array.from(this.players.values())
        .filter((player) => player.alive)
        .map((player) => player.playerId),
    );

    for (const player of this.players.values()) {
      if (!alivePlayerIds.has(player.playerId)) continue;

      const head = player.segments[0] ? cloneCell(player.segments[0]) : null;
      if (!head || this._isWall(head)) {
        player.alive = false;
        events.push(this._createDeathEvent(player, SNAKE_DEATH_REASONS.WALL, head));
        continue;
      }

      if (this._hitsSelf(player)) {
        player.alive = false;
        events.push(this._createDeathEvent(player, SNAKE_DEATH_REASONS.SELF, head));
        continue;
      }

      const hitPlayer = this._playerAt(head, player.playerId, alivePlayerIds);
      if (hitPlayer) {
        player.alive = false;
        events.push(this._createDeathEvent(player, SNAKE_DEATH_REASONS.SNAKE, head, hitPlayer.playerId));
        continue;
      }

      const itemKey = cellKey(head);
      const item = this.items.get(itemKey);
      if (!item) continue;

      this.items.delete(itemKey);
      const growBy = item.growth;
      events.push({
        type: SNAKE_PLAY_EVENTS.ITEM_PICKED_UP,
        playerId: player.playerId,
        cell: cloneCell(item.cell),
        growBy,
      });
    }

    return events;
  }

  getPlayerState(playerId: string): SnakePlayerState {
    return clonePlayer(this._getPlayer(playerId));
  }

  getItemState(): SnakeItemState[] {
    return Array.from(this.items.values()).map((item) => {
      return {
        cell: cloneCell(item.cell),
        growth: item.growth,
      };
    });
  }

  private _createDeathEvent(
    player: SnakePlayerState,
    reason: SnakeDeathReason,
    cell: SnakeCell | null,
    hitPlayerId: string | null = null,
  ): SnakePlayEvent {
    const event: SnakePlayEvent = {
      type: SNAKE_PLAY_EVENTS.PLAYER_DIED,
      playerId: player.playerId,
      reason,
      cell: cell ? cloneCell(cell) : null,
    };
    if (hitPlayerId) event.hitPlayerId = hitPlayerId;

    return event;
  }

  private _isWall(cell: SnakeCell): boolean {
    return (
      cell.right < this.minRight ||
      cell.right > this.maxRight ||
      cell.forward < this.minForward ||
      cell.forward > this.maxForward
    );
  }

  private _hitsSelf(player: SnakePlayerState): boolean {
    if (player.segments.length <= 1) return false;
    const headKey = cellKey(player.segments[0]);
    return player.segments.slice(1).some((segment) => cellKey(segment) === headKey);
  }

  private _playerAt(
    cell: SnakeCell,
    excludePlayerId: string,
    alivePlayerIds: Set<string> | null = null,
  ): SnakePlayerState | null {
    const key = cellKey(cell);
    for (const player of this.players.values()) {
      if (player.playerId === excludePlayerId) continue;
      if (alivePlayerIds ? !alivePlayerIds.has(player.playerId) : !player.alive) continue;
      if (player.segments.some((segment) => cellKey(segment) === key)) return player;
    }
    return null;
  }

  private _getPlayer(playerId: string): SnakePlayerState {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`unknown player: ${playerId}`);
    return player;
  }
}
