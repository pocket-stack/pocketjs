// playset/modules/gameplay/combat-play.ts — team-combat state machine:
// health/armor bookkeeping, kill events, winner resolution.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/CombatPlay.js. Verbatim semantics.

export const COMBAT_STATES = Object.freeze({
  WAITING: "WAITING",
  STARTED: "STARTED",
  FINISHED: "FINISHED",
} as const);

export type CombatState = (typeof COMBAT_STATES)[keyof typeof COMBAT_STATES];

export const COMBAT_PLAY_EVENTS = Object.freeze({
  COMBAT_FINISHED: "combat.finished",
  PLAYER_KILLED: "combat.player.killed",
} as const);

export interface CombatPlayerState {
  playerId: string;
  teamId: string;
  maxHealth: number;
  health: number;
  maxArmor: number;
  armor: number;
  alive: boolean;
}

export type CombatPlayEvent =
  | {
      type: typeof COMBAT_PLAY_EVENTS.PLAYER_KILLED;
      playerId: string;
      sourceId: string | null;
    }
  | {
      type: typeof COMBAT_PLAY_EVENTS.COMBAT_FINISHED;
      winnerTeamId: string | null;
    };

export interface CombatPlayOptions {
  maxHealth?: number;
  maxArmor?: number;
  armorAbsorption?: number;
}

export interface AddCombatPlayerOptions {
  playerId: string;
  teamId: string;
  health?: number;
  armor?: number;
}

export interface UpdateCombatPlayerOptions {
  playerId: string;
  health?: number;
  armor?: number;
}

export interface CombatDamageOptions {
  playerId: string;
  amount: number;
  sourceId?: string | null;
  bypassArmor?: boolean;
}

function clonePlayer(player: CombatPlayerState): CombatPlayerState {
  return {
    playerId: player.playerId,
    teamId: player.teamId,
    maxHealth: player.maxHealth,
    health: player.health,
    maxArmor: player.maxArmor,
    armor: player.armor,
    alive: player.alive,
  };
}

function createPlayer({
  playerId,
  teamId,
  maxHealth,
  health,
  maxArmor,
  armor,
}: {
  playerId: string;
  teamId: string;
  maxHealth: number;
  health: number;
  maxArmor: number;
  armor: number;
}): CombatPlayerState {
  return {
    playerId,
    teamId,
    maxHealth,
    health,
    maxArmor,
    armor,
    alive: health > 0,
  };
}

export class CombatPlay {
  maxHealth: number;
  maxArmor: number;
  armorAbsorption: number;
  players: Map<string, CombatPlayerState>;
  combatState: CombatState;
  winnerTeamId: string | null;
  private _events: CombatPlayEvent[];

  constructor({ maxHealth = 100, maxArmor = 100, armorAbsorption = 0.6 }: CombatPlayOptions) {
    this.maxHealth = maxHealth;
    this.maxArmor = maxArmor;
    this.armorAbsorption = armorAbsorption;

    this.players = new Map();
    this.combatState = COMBAT_STATES.WAITING;
    this.winnerTeamId = null;
    this._events = [];
  }

  addPlayer({ playerId, teamId, health = this.maxHealth, armor = 0 }: AddCombatPlayerOptions): void {
    if (this.combatState !== COMBAT_STATES.WAITING) {
      throw new Error("players can only be added while combat is waiting");
    }
    if (this.players.has(playerId)) {
      throw new Error(`player already exists: ${playerId}`);
    }

    this.players.set(
      playerId,
      createPlayer({
        playerId,
        teamId,
        maxHealth: this.maxHealth,
        health: health,
        maxArmor: this.maxArmor,
        armor: armor,
      }),
    );
  }

  removePlayer(playerId: string): void {
    if (!this.players.delete(playerId)) {
      throw new Error(`unknown player: ${playerId}`);
    }
  }

  updatePlayer({ playerId, health, armor }: UpdateCombatPlayerOptions): void {
    const player = this._getPlayer(playerId);
    if (health !== undefined) {
      player.health = Math.min(health, player.maxHealth);
      player.alive = player.health > 0;
    }
    if (armor !== undefined) {
      player.armor = Math.min(armor, player.maxArmor);
    }
  }

  startGame(): void {
    if (this.combatState !== COMBAT_STATES.WAITING) {
      throw new Error("combat can only be started from WAITING");
    }
    if (this.players.size === 0) {
      throw new Error("combat requires at least one player");
    }

    this.winnerTeamId = null;
    this.combatState = COMBAT_STATES.STARTED;
  }

  reset(): void {
    this._resetPlayers();
    this._clearEvents();
    this.combatState = COMBAT_STATES.WAITING;
  }

  getPlayer(playerId: string): CombatPlayerState {
    return clonePlayer(this._getPlayer(playerId));
  }

  getCombatState(): CombatState {
    return this.combatState;
  }

  getAliveTeamIds(): string[] {
    return Array.from(
      new Set(
        Array.from(this.players.values())
          .filter((player) => player.alive)
          .map((player) => player.teamId),
      ),
    );
  }

  private _getPlayer(playerId: string): CombatPlayerState {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`unknown player: ${playerId}`);
    return player;
  }

  private _resetPlayers(): void {
    this.winnerTeamId = null;
    for (const player of this.players.values()) {
      player.health = this.maxHealth;
      player.armor = 0;
      player.alive = player.health > 0;
    }
  }

  private _queueEvent(event: CombatPlayEvent): void {
    this._events.push(event);
  }

  private _clearEvents(): void {
    this._events = [];
  }

  private _drainEvents(): CombatPlayEvent[] {
    const events = this._events;
    this._events = [];
    return events;
  }

  damage({ playerId, amount, sourceId = null, bypassArmor = false }: CombatDamageOptions): void {
    if (this.combatState !== COMBAT_STATES.STARTED) return;

    const player = this._getPlayer(playerId);
    if (!player.alive) {
      return;
    }

    const armorDamage = bypassArmor ? 0 : Math.min(player.armor, amount * this.armorAbsorption);
    const healthDamage = Math.min(player.health, amount - armorDamage);

    player.armor -= armorDamage;
    player.health -= healthDamage;
    player.alive = player.health > 0;

    if (!player.alive) {
      this._queueEvent({
        type: COMBAT_PLAY_EVENTS.PLAYER_KILLED,
        playerId,
        sourceId,
      });
    }
  }

  heal({ playerId, amount }: { playerId: string; amount: number }): void {
    if (this.combatState !== COMBAT_STATES.STARTED) return;

    const player = this._getPlayer(playerId);
    if (!player.alive) {
      return;
    }

    player.health = Math.min(player.maxHealth, player.health + amount);
  }

  addArmor({ playerId, amount }: { playerId: string; amount: number }): void {
    if (this.combatState !== COMBAT_STATES.STARTED) return;

    const player = this._getPlayer(playerId);
    player.armor = Math.min(player.maxArmor, player.armor + amount);
  }

  step(): CombatPlayEvent[] {
    this._finishCombatIfResolved();
    return this._drainEvents();
  }

  private _finishCombatIfResolved(): void {
    if (this.combatState !== COMBAT_STATES.STARTED) return;

    const aliveTeamIds = this.getAliveTeamIds();
    if (aliveTeamIds.length > 1) return;

    this.combatState = COMBAT_STATES.FINISHED;
    this.winnerTeamId = aliveTeamIds[0] ?? null;
    this._queueEvent({
      type: COMBAT_PLAY_EVENTS.COMBAT_FINISHED,
      winnerTeamId: this.winnerTeamId,
    });
  }
}
