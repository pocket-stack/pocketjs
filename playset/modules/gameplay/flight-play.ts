// playset/modules/gameplay/flight-play.ts — flight crash referee: marks a
// player finished when their height drops to the terrain crash height.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/FlightPlay.js. Verbatim semantics.

import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../math/world-basis.ts";

export const FLIGHT_PLAY_EVENTS = Object.freeze({
  PLAYER_HIT_GROUND: "flight.player.hitGround",
} as const);

export interface FlightPosition {
  x: number;
  y: number;
  z: number;
}

export interface FlightPlayerState {
  playerId: string;
  position: FlightPosition;
  finished: boolean;
}

export type FlightPlayEvent = {
  type: typeof FLIGHT_PLAY_EVENTS.PLAYER_HIT_GROUND;
  playerId: string;
  position: FlightPosition;
  height: number;
  crashHeight: number;
};

export type CrashHeightFn = (right: number, forward: number) => number;

export interface FlightPlayOptions {
  crashHeightAt: CrashHeightFn;
  basis?: WorldBasis;
}

function clonePosition(position: FlightPosition): FlightPosition {
  return { x: position.x, y: position.y, z: position.z };
}

function clonePlayer(player: FlightPlayerState): FlightPlayerState {
  return {
    playerId: player.playerId,
    position: clonePosition(player.position),
    finished: player.finished,
  };
}

function createPlayer({ playerId, position }: { playerId: string; position: FlightPosition }): FlightPlayerState {
  return {
    playerId,
    position: clonePosition(position),
    finished: false,
  };
}

export class FlightPlay {
  crashHeightAt: CrashHeightFn;
  basis: WorldBasis;
  players: Map<string, FlightPlayerState>;
  private _events: FlightPlayEvent[];

  constructor({ crashHeightAt, basis = DEFAULT_WORLD_BASIS }: FlightPlayOptions) {
    if (typeof crashHeightAt !== "function") {
      throw new Error("FlightPlay requires crashHeightAt");
    }

    this.crashHeightAt = crashHeightAt;
    this.basis = basis;
    this.players = new Map();
    this._events = [];
  }

  addPlayer({ playerId, position }: { playerId: string; position: FlightPosition }): void {
    if (this.players.has(playerId)) {
      throw new Error(`player already exists: ${playerId}`);
    }
    this.players.set(playerId, createPlayer({ playerId, position }));
  }

  movePlayer(playerId: string, position: FlightPosition): void {
    this._getPlayer(playerId).position = clonePosition(position);
  }

  startGame(): void {
    if (this.players.size === 0) {
      throw new Error("flight requires at least one player");
    }

    for (const player of this.players.values()) {
      player.finished = false;
    }
  }

  reset(): void {
    this._clearEvents();
    for (const player of this.players.values()) {
      player.finished = false;
    }
  }

  getPlayer(playerId: string): FlightPlayerState {
    return clonePlayer(this._getPlayer(playerId));
  }

  private _getPlayer(playerId: string): FlightPlayerState {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`unknown player: ${playerId}`);
    return player;
  }

  private _queueEvent(event: FlightPlayEvent): void {
    this._events.push(event);
  }

  private _clearEvents(): void {
    this._events = [];
  }

  private _drainEvents(): FlightPlayEvent[] {
    const events = this._events;
    this._events = [];
    return events;
  }

  step(): FlightPlayEvent[] {
    for (const player of this.players.values()) {
      if (player.finished) continue;

      const planar = this.basis.toPlanar(player.position);
      const crashHeight = this.crashHeightAt(planar.right, planar.forward);
      const playerHeight = this.basis.upComponent(player.position);
      if (playerHeight > crashHeight) continue;

      player.finished = true;
      this._queueEvent({
        type: FLIGHT_PLAY_EVENTS.PLAYER_HIT_GROUND,
        playerId: player.playerId,
        position: clonePosition(player.position),
        height: playerHeight,
        crashHeight,
      });
    }

    return this._drainEvents();
  }
}
