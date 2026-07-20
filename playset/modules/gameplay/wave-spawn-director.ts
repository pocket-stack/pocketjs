// playset/modules/gameplay/wave-spawn-director.ts — enemy-wave pacing: wave
// sizing, unlock rules, weighted type selection, spawn planning per step.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/gameplay/WaveSpawnDirector.js. Verbatim semantics.

import { clamp } from "../math/scalar-utils.ts";
import { DEFAULT_PRNG } from "../math/random-utils.ts";

export interface WaveUnlockRule {
  waveNumber: number;
  type: string;
}

export type WaveTypeWeight = number | ((waveNumber: number) => number);

export interface WavePrng {
  random(): number;
}

export interface WaveSpawn {
  /** Undefined when no unlock rule is live yet (original behavior). */
  type: string | undefined;
  waveNumber: number;
  spawnIndex: number;
  spawnCount: number;
}

export interface WaveStartInfo {
  waveNumber: number;
  unitsToSpawn: number;
  availableTypes: string[];
}

export interface WaveStepResult {
  spawns: WaveSpawn[];
}

export interface WaveCompletion {
  completedWaveNumber: number;
  nextWaveNumber: number;
}

export interface WaveSnapshot {
  waveNumber: number;
  inProgress: boolean;
  unitsToSpawn: number;
  unitsSpawned: number;
  pending: number;
  activeUnits: number;
  lastSpawnedType: string | null | undefined;
}

export interface WaveSpawnDirectorOptions {
  baseWaveSize?: number;
  growthPerWave?: number;
  maxWaveSize?: number;
  unlockRules?: WaveUnlockRule[];
  typeWeights?: Record<string, WaveTypeWeight>;
  maxSpawnsPerStep?: number;
  startWaveNumber?: number;
  waveAutoStart?: boolean;
  prng?: WavePrng;
}

const DEFAULT_UNLOCK_RULES: WaveUnlockRule[] = [{ waveNumber: 1, type: "DEFAULT" }];

const DEFAULT_TYPE_WEIGHTS: Record<string, WaveTypeWeight> = {
  DEFAULT: 1,
};

const resolveWeight = (value: WaveTypeWeight, waveNumber: number): number =>
  typeof value === "function" ? value(waveNumber) : value;

export class WaveSpawnDirector {
  baseWaveSize: number;
  growthPerWave: number;
  maxWaveSize: number;
  unlockRules: WaveUnlockRule[];
  typeWeights: Record<string, WaveTypeWeight>;
  maxSpawnsPerStep: number;
  startWaveNumber: number;
  waveAutoStart: boolean;
  prng: WavePrng;
  activeUnits: number;
  // Assigned via reset() in the constructor.
  waveNumber!: number;
  inProgress!: boolean;
  unitsToSpawn!: number;
  unitsSpawned!: number;
  lastSpawnedType!: string | null | undefined;

  constructor({
    baseWaveSize = 3,
    growthPerWave = 1.5,
    maxWaveSize = 500,
    unlockRules = DEFAULT_UNLOCK_RULES,
    typeWeights = DEFAULT_TYPE_WEIGHTS,
    maxSpawnsPerStep = 100,
    startWaveNumber = 1,
    waveAutoStart = true,
    prng = DEFAULT_PRNG,
  }: WaveSpawnDirectorOptions) {
    this.baseWaveSize = baseWaveSize;
    this.growthPerWave = growthPerWave;
    this.maxWaveSize = maxWaveSize;
    this.unlockRules = [...unlockRules].sort((a, b) => a.waveNumber - b.waveNumber);
    this.typeWeights = { ...typeWeights };
    this.maxSpawnsPerStep = maxSpawnsPerStep;
    this.startWaveNumber = startWaveNumber;
    this.waveAutoStart = waveAutoStart;
    this.prng = prng;
    this.activeUnits = 0;

    this.reset(this.startWaveNumber);
    if (this.waveAutoStart) this.startWave(this.startWaveNumber);
  }

  reset(startWaveNumber: number = this.startWaveNumber): void {
    this.waveNumber = startWaveNumber;
    this.inProgress = false;
    this.unitsToSpawn = 0;
    this.unitsSpawned = 0;
    this.lastSpawnedType = null;
    this.activeUnits = 0;
  }

  startWave(waveNumber: number = this.waveNumber): WaveStartInfo {
    this.waveNumber = waveNumber;
    this.unitsToSpawn = this.getWaveSize(waveNumber);
    this.unitsSpawned = 0;
    this.lastSpawnedType = null;
    this.inProgress = true;

    return {
      waveNumber: this.waveNumber,
      unitsToSpawn: this.unitsToSpawn,
      availableTypes: this.getAvailableTypes(this.waveNumber),
    };
  }

  step({ activeUnits }: { activeUnits: number }): WaveStepResult {
    this.activeUnits = activeUnits;

    this.completeIfDone(activeUnits);
    if (!this.inProgress && this.waveAutoStart) this.startWave(this.waveNumber);

    return {
      spawns: this.planSpawns(),
    };
  }

  setActiveUnits(activeUnits: number): void {
    this.activeUnits = activeUnits;
  }

  getWaveSize(waveNumber: number = this.waveNumber): number {
    const raw = this.baseWaveSize + (waveNumber - 1) * this.growthPerWave;
    return clamp(Math.floor(raw), 1, this.maxWaveSize);
  }

  getAvailableTypes(waveNumber: number = this.waveNumber): string[] {
    return this.unlockRules.filter((rule) => waveNumber >= rule.waveNumber).map((rule) => rule.type);
  }

  selectType(waveNumber: number = this.waveNumber): string | undefined {
    const available = this.getAvailableTypes(waveNumber);
    const entries: Array<{ type: string; weight: number }> = [];
    let total = 0;

    for (const type of available) {
      const weight = resolveWeight(this.typeWeights[type] ?? 0, waveNumber);
      if (weight <= 0) continue;
      entries.push({ type, weight });
      total += weight;
    }

    if (entries.length === 0) return available[0];

    let pick = this.prng.random() * total;
    for (const entry of entries) {
      pick -= entry.weight;
      if (pick <= 0) return entry.type;
    }
    return entries[entries.length - 1].type;
  }

  planSpawns(): WaveSpawn[] {
    if (!this.inProgress || this.unitsSpawned >= this.unitsToSpawn) return [];

    const spawns: WaveSpawn[] = [];
    let guard = this.maxSpawnsPerStep;

    while (this.unitsSpawned < this.unitsToSpawn && guard > 0) {
      const type = this.selectType(this.waveNumber);
      const spawn = {
        type,
        waveNumber: this.waveNumber,
        spawnIndex: this.unitsSpawned,
        spawnCount: this.unitsToSpawn,
      };

      this.unitsSpawned += 1;
      this.lastSpawnedType = type;
      spawns.push(spawn);
      guard -= 1;
    }

    return spawns;
  }

  completeIfDone(activeUnits: number): WaveCompletion | null {
    if (!this.inProgress || this.unitsSpawned < this.unitsToSpawn || activeUnits > 0) return null;

    const completedWaveNumber = this.waveNumber;
    this.inProgress = false;
    this.waveNumber += 1;

    return {
      completedWaveNumber,
      nextWaveNumber: this.waveNumber,
    };
  }

  snapshot(): WaveSnapshot {
    return {
      waveNumber: this.waveNumber,
      inProgress: this.inProgress,
      unitsToSpawn: this.unitsToSpawn,
      unitsSpawned: this.unitsSpawned,
      pending: 0,
      activeUnits: this.activeUnits,
      lastSpawnedType: this.lastSpawnedType,
    };
  }
}
