// demos/dogfight/game.ts — "Pocket Dogfight": the pure jet-combat sim,
// composed from playset flight + combat modules.
//
// Reference: the GameBlocks demo "jet-dogfight" (https://gb-jet-dogfight.vercel.app/,
// unbundled sources under /src/). The library modules it composes are the MIT
// GameBlocks modules already ported as playset/modules/. This file is fresh
// Pocket-shaped glue derived from the demo's game.js/main.js/terrain.js —
// flight envelope, terrain function, enemy wave/AI/weapon balance numbers and
// visual palette transfer directly; the composition is rebuilt on scene3d,
// PSP buttons, and the deterministic fixed-step loop (DETERMINISM.md).
//
// Everything is deterministic fixed-step state: inputs are the per-step
// button mask + analog nub and FIXED_DT — no wall clock (one manual Clock
// advanced by the sim feeds weapon cooldowns), no Math.random (one seeded
// RandomGenerator drives waves/spawns/cooldowns; two more drive cloud
// placement and burst-particle scatter). The composition under test:
//
//   terrainHeightAt + createTerrainMesh        the demo's analytic mountain
//                                              range baked to a heightfield
//   AirplaneMotionController ×N                player (buttons/nub) + bandits
//   ProjectileWeaponSystem                     player fire control: gun heat,
//                                              missile lock-on (boresight)
//   ProjectileManager + ProjectileObject       bullets + homing missiles,
//                                              per-team target lists
//   WaveSpawnDirector                          fighter/ace wave escalation
//   CombatPlay                                 player health/armor referee
//   FlightPlay                                 terrain-crash referee (the
//                                              demo's soft altitude floor
//                                              becomes real mountain impact)
//   AirplaneVisualFactory + AirplaneModelController + JetFlame
//   WeaponEffectsSystem                        tracers + hit/explosion bursts
//   PoseFollowCameraRig                        chase camera
//
// Controls: nub/d-pad = pitch + bank (hold L: left/right becomes rudder yaw,
// the demo's 0.78 rad/s coefficient), CROSS = gun, SQUARE = missile (selects
// + holds lock, fires when LOCKED), TRIANGLE/CIRCLE = throttle, R = boost.
//
// A debug probe rides on globalThis.__dogfightProbe so the headless E2E
// (playset/test/dogfight-sim.test.ts) can assert combat + crash progress
// without scraping HUD pixels.

import { BTN } from "@pocketjs/framework/input";
import { Vector3 } from "../../playset/math/index.ts";
import { MAT, Scene3D } from "../../playset/scene3d/client.ts";
import type { GameInput } from "../../playset/loop.ts";
import { RandomGenerator } from "../../playset/modules/math/random-utils.ts";
import { Clock } from "../../playset/modules/math/time-utils.ts";
import { clamp, clamp01, lerp, smoothToward, toDeg } from "../../playset/modules/math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS } from "../../playset/modules/math/world-basis.ts";
import { rgbToAbgr } from "../../playset/modules/world/color-utils.ts";
import { createTerrainMesh } from "../../playset/modules/world/environment/terrain-mesh-factory.ts";
import { AirplaneMotionController } from "../../playset/modules/actor-motion/aircraft/airplane-motion-controller.ts";
import { AirplaneModelController } from "../../playset/modules/actor-motion/aircraft/airplane-model-controller.ts";
import {
  createAirplaneVisual,
  type AirplaneVisual,
} from "../../playset/modules/world/object/factory/airplane-visual-factory.ts";
import {
  createBulletProjectileVisual,
  createMissileProjectileVisual,
} from "../../playset/modules/world/object/factory/projectile-visual-factory.ts";
import {
  ProjectileObject,
  type ProjectileObjectOptions,
} from "../../playset/modules/world/object/projectile-object.ts";
import { ProjectileManager } from "../../playset/modules/gameplay/combat/projectile-manager.ts";
import {
  MISSILE_LOCK_STATUS,
  ProjectileWeaponSystem,
  WEAPON_AIM_MODES,
  WEAPON_DECISIONS,
  WEAPON_TYPES,
  type MissileLockStatus,
  type WeaponFireDecision,
} from "../../playset/modules/gameplay/combat/projectile-weapon-system.ts";
import { WaveSpawnDirector } from "../../playset/modules/gameplay/wave-spawn-director.ts";
import { COMBAT_PLAY_EVENTS, CombatPlay } from "../../playset/modules/gameplay/combat-play.ts";
import { FlightPlay } from "../../playset/modules/gameplay/flight-play.ts";
import { WeaponEffectsSystem } from "../../playset/modules/world/visual-effects/weapon-effects-system.ts";
import { PoseFollowCameraRig } from "../../playset/modules/camera/pose-follow-camera-rig.ts";

const BASIS = DEFAULT_WORLD_BASIS;
export const PLAYER_ID = "player";

// ---------------------------------------------------------------------------
// Terrain — the demo's analytic mountain range (terrain.js), verbatim math.
// Planar (right, forward) in, height up. Pure function; the FlightPlay crash
// referee and the enemy terrain floor sample it directly.
// ---------------------------------------------------------------------------

function mountainMass(
  right: number,
  forward: number,
  centerRight: number,
  centerForward: number,
  radiusRight: number,
  radiusForward: number,
  height: number,
): number {
  const nr = (right - centerRight) / radiusRight;
  const nf = (forward - centerForward) / radiusForward;
  return Math.exp(-(nr * nr + nf * nf)) * height;
}

export function terrainHeightAt(right: number, forward: number): number {
  const broadRidges =
    Math.sin(right * 0.00074 + forward * 0.00038) * 320 +
    Math.cos(forward * 0.00068 - right * 0.00031) * 270;
  const brokenHills =
    Math.sin((right + forward) * 0.00162) * 155 +
    Math.cos((right - forward) * 0.00132) * 130 +
    Math.sin(right * 0.0042) * Math.cos(forward * 0.0034) * 82;
  const peaks =
    mountainMass(right, forward, -4200, 2600, 1500, 1350, 630) +
    mountainMass(right, forward, 3600, 3100, 1450, 1300, 590) +
    mountainMass(right, forward, 0, 3600, 1300, 1500, 750) +
    mountainMass(right, forward, -900, 4700, 2100, 1250, 510) +
    mountainMass(right, forward, 2900, -3200, 1300, 1550, 490) +
    mountainMass(right, forward, -4200, 2600, 620, 540, 260) +
    mountainMass(right, forward, 3600, 3100, 560, 520, 230) +
    mountainMass(right, forward, 0, 3600, 520, 560, 310);
  return (-740 + broadRidges + brokenHills + peaks) * 0.5;
}

/** Height→color ramp from the demo's terrain vertex-color bake (main.js). */
interface RGB {
  r: number;
  g: number;
  b: number;
}

function hexRgb(hex: number): RGB {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

const VALLEY = hexRgb(0x31592f);
const GRASS = hexRgb(0x6d823f);
const EARTH = hexRgb(0x8a7651);
const ROCK = hexRgb(0x69717c);
const SNOW = hexRgb(0xf2f7fb);

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

export function terrainColorAt(height: number): RGB {
  if (height < -560) return lerpRgb(VALLEY, GRASS, clamp01((height + 900) / 340));
  if (height < -120) return lerpRgb(GRASS, EARTH, clamp01((height + 560) / 440));
  if (height < 220) return lerpRgb(EARTH, ROCK, clamp01((height + 120) / 340));
  return lerpRgb(ROCK, SNOW, clamp01((height - 220) / 360));
}

// ---------------------------------------------------------------------------
// Balance — the demo's tuning tables (game.js), numbers verbatim.
// ---------------------------------------------------------------------------

const GAME_SEED = 20260616;
const CLOUD_SEED = 20260616;
const EFFECTS_SEED = 20260617;

const PLAYER_TUNING = Object.freeze({
  minSpeed: 88,
  maxSpeed: 260,
  pitchRate: 1.35,
  bankTurnRate: 0.56,
  throttleRate: 0.55,
  initialSpeed: 150,
  initialThrottle: 0.55,
  initialAltitude: 520,
  yawRate: 0.78, // rad/s at full rudder (the demo's intent.yaw coefficient)
  radius: 30,
  health: 100,
  armor: 16,
});

const PLAYER_GUN = Object.freeze({
  fireRate: 0.055,
  speed: 1650,
  launchOffset: { right: 0, up: -1.2, forward: 18 },
  damage: 10,
  lifetimeSeconds: 1.05,
  hitRadius: 30,
});

const PLAYER_MISSILE = Object.freeze({
  ammo: 6,
  fireRate: 0.9,
  speed: 620,
  launchOffset: { right: 6, up: -2.3, forward: 12 },
  damage: 62,
  lifetimeSeconds: 8,
  hitRadius: 55,
  turnResponse: 1.8,
});

const LOCK = Object.freeze({
  lockRequiredSeconds: 0.75,
  targetAimDotMin: 0.955,
  targetMaxDistance: 4200,
});

const ENEMY_BALANCE = Object.freeze({
  baseWaveSize: 2,
  growthPerWave: 1.125,
  maxWaveSize: 9,
  maxSpawnsPerStep: 2,
  aceUnlockWave: 3,
  aceWeightPerWaveAfterUnlock: 0.27,
  fighterHealth: 105,
  aceHealth: 123,
  fighterRadius: 30,
  aceRadius: 39,
  minSpeed: 88,
  maxSpeed: 225,
  pitchRate: 1.0,
  bankTurnRate: 0.52,
  initialSpeed: 135,
  initialThrottle: 0.45,
  initialGunCooldownMin: 0.67,
  initialGunCooldownMax: 1.6,
  initialMissileCooldownMin: 6.7,
  initialMissileCooldownMax: 10,
  fighterAggression: 1.02,
  aceAggression: 1.29,
  spawnDistanceMin: 2000,
  spawnDistanceMax: 3100,
  spawnAltitudeMin: 430,
  spawnAltitudeMax: 980,
  gunAimDotMin: 0.979,
  gunRange: 2625,
  gunProjectileSpeed: 1950,
  gunDamage: 5.25,
  gunCooldownMin: 0.43,
  gunCooldownMax: 0.73,
  missileMinRange: 700,
  missileProjectileSpeed: 645,
  missileDamage: 21,
  missileCooldownMin: 8,
  missileCooldownMax: 12,
  minPlayerDistance: 500,
  breakawayDistance: 700,
  breakawayLeadDistance: 900,
  terrainClearance: 240,
});

/** Gun bullets inherit this fraction of the shooter's airspeed (game.js). */
const GUN_SPEED_INHERIT = 0.55;
/** Gun tracer flash: 250 units long, 0.07 s (game.js TRACER event). */
const TRACER_LENGTH = 250;
const TRACER_TTL = 0.07;
const TRACER_COLOR = 0xfff0a0;
/** AGL under which the HUD shows PULL UP (port-native; the demo's fixed
 *  altitude-70 soft floor becomes a hard terrain crash via FlightPlay). */
const PULL_UP_AGL = 150;

const KILL_SCORE = 100;
const KILL_HEAL = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Aircraft {
  id: string;
  motion: AirplaneMotionController;
  /** Live reference to motion.position (WeaponTarget/ProjectileTarget shape). */
  position: Vector3;
  health: number;
  maxHealth: number;
  radius: number;
  destroyed: boolean;
  enemy: boolean;
  ace: boolean;
  gunCooldown: number;
  missileCooldown: number;
  aiSeed: number;
  visual: AirplaneVisual;
  model: AirplaneModelController;
}

interface ProjectileMeta {
  weaponId: string;
  damage: number;
  sourceId: string;
}

export interface DogfightProbe {
  /** scene3d handle of the game's one scene (0 in pure-mirror mode). */
  sceneId: number;
  /** Player airframe group node id — the test reads its serialized pose. */
  playerNodeId: number;
  steps: number;
  waveNumber: number;
  enemiesSpawned: number;
  enemiesDestroyed: number;
  playerGunShots: number;
  playerMissileShots: number;
  /** Player projectile hit events (gun + missile) that landed on a bandit. */
  playerHitsLanded: number;
  playerHealth: number;
  score: number;
  /** FlightPlay hit-ground events (terrain crash referee). */
  crashes: number;
  playerDestroyed: boolean;
  lockStatus: MissileLockStatus;
  playerPosition: { x: number; y: number; z: number };
}

/** Radar contact rows (heading-relative-radar's loose RadarContact shape). */
export interface RadarContactState extends Record<string, unknown> {
  position: { x: number; y: number; z: number };
  color: number;
  size: number;
}

export interface DogfightHudState {
  speed: number;
  altitude: number;
  agl: number;
  health: number;
  score: number;
  waveNumber: number;
  banditsAlive: number;
  weaponLabel: string;
  lockStatus: MissileLockStatus;
  missiles: number;
  gunHeat: number;
  throttle: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  pullUp: boolean;
  failed: boolean;
  damageFlash: number;
  message: string;
  playerPosition: { x: number; y: number; z: number };
  playerForward: { x: number; y: number; z: number };
  contacts: RadarContactState[];
}

export interface DogfightGame {
  scene: Scene3D;
  /** One fixed 1/60 s simulation step (createGameLoop's `step`). */
  step(dt: number, input: GameInput): void;
  /** Fresh HUD snapshot (call from the loop's `render`). */
  hudState(): DogfightHudState;
}

function vec(v: Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

function shortestAngleDelta(target: number, current: number): number {
  return Math.atan2(Math.sin(target - current), Math.cos(target - current));
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export function createDogfightGame(): DogfightGame {
  const scene = new Scene3D();
  const prng = new RandomGenerator(GAME_SEED);
  const clock = new Clock({ manual: true, nowMs: 0 });

  // -- world: terrain heightfield + sky/fog/light + clouds ---------------------
  createTerrainMesh({
    scene,
    terrainSampler: {
      sample(right: number, forward: number): { height: number; color: RGB } {
        const height = terrainHeightAt(right, forward);
        return { height, color: terrainColorAt(height) };
      },
    },
    size: 14500,
    segments: 180,
  });

  // Demo lighting: sun from basis (1300, 2200, 900), hemisphere 0xbfe8ff over
  // 0x2e4d64, solid 0x8bc6ee sky with FogExp2(0x8bc6ee, 0.00042) — the exp2
  // curve approximated by a linear band (50% fade ≈ 1980 u, 90% ≈ 3610 u).
  scene.sun(new Vector3(-1300, -2200, 900).normalize(), rgbToAbgr(0xfff5d0));
  scene.ambient(rgbToAbgr(0xbfe8ff), rgbToAbgr(0x2e4d64));
  scene.sky(rgbToAbgr(0x8bc6ee), rgbToAbgr(0xd0e8f5));
  scene.fog(rgbToAbgr(0x8bc6ee), 900, 3900);
  scene.camera.fovY = (68 * Math.PI) / 180;
  scene.camera.znear = 1;
  scene.camera.zfar = 18000;

  // Cloud deck (demo counts/draw order; unit sphere scaled per puff — the
  // demo's per-puff SphereGeometry radius folds into the node scale).
  {
    const cloudPrng = new RandomGenerator(CLOUD_SEED);
    const cloudMaterial = scene.material(rgbToAbgr(0xf8fcff, 0.92), MAT.transparent);
    const puffGeom = scene.sphere(1, 10);
    for (let i = 0; i < 72; i += 1) {
      const cloud = scene.node();
      const parts = 4 + cloudPrng.randint(0, 4);
      for (let p = 0; p < parts; p += 1) {
        const radius = cloudPrng.uniform(35, 95);
        const puff = scene.mesh(puffGeom, cloudMaterial, cloud);
        puff.scale.set(
          radius * cloudPrng.uniform(1.4, 3.4),
          radius * cloudPrng.uniform(0.25, 0.55),
          radius * cloudPrng.uniform(0.75, 1.6),
        );
        puff.position.set(
          cloudPrng.uniform(-150, 150),
          cloudPrng.uniform(-12, 18),
          cloudPrng.uniform(-80, 80),
        );
      }
      cloud.position.copy(
        BASIS.fromBasisComponents(
          cloudPrng.uniform(-5200, 5200),
          cloudPrng.uniform(820, 1650),
          cloudPrng.uniform(-5200, 5200),
        ),
      );
    }
  }

  // -- effects ------------------------------------------------------------------
  const effects = new WeaponEffectsSystem({
    scene,
    maxEffects: 72,
    prng: new RandomGenerator(EFFECTS_SEED),
    tracerWidth: 2.5, // world-scale stand-ins for the demo's 1px lines /
    particleSize: 6, // 0.05 points (see module header)
  });

  // -- aircraft -------------------------------------------------------------------
  function makeAircraft(options: {
    id: string;
    enemy: boolean;
    ace: boolean;
    bodyColor: number;
    accentColor: number;
    scale: number;
    position: Vector3;
    yaw: number;
  }): Aircraft {
    const motion = new AirplaneMotionController({
      minSpeed: options.enemy ? ENEMY_BALANCE.minSpeed : PLAYER_TUNING.minSpeed,
      maxSpeed: options.enemy ? ENEMY_BALANCE.maxSpeed : PLAYER_TUNING.maxSpeed,
      pitchRate: options.enemy ? ENEMY_BALANCE.pitchRate : PLAYER_TUNING.pitchRate,
      bankTurnRate: options.enemy ? ENEMY_BALANCE.bankTurnRate : PLAYER_TUNING.bankTurnRate,
      throttleRate: PLAYER_TUNING.throttleRate,
      basis: BASIS,
    });
    motion.reset(options.position);
    motion.setState(
      options.enemy ? ENEMY_BALANCE.initialSpeed : PLAYER_TUNING.initialSpeed,
      options.enemy ? ENEMY_BALANCE.initialThrottle : PLAYER_TUNING.initialThrottle,
      0,
      0,
      options.yaw,
      options.position,
    );
    const visual = createAirplaneVisual(scene, {
      scale: options.scale,
      bodyColor: options.bodyColor,
      accentColor: options.accentColor,
      showTargetRing: options.enemy,
      targetRingColor: options.enemy ? 0xff503d : 0x6cffc7,
    });
    const health = options.enemy
      ? options.ace
        ? ENEMY_BALANCE.aceHealth
        : ENEMY_BALANCE.fighterHealth
      : PLAYER_TUNING.health;
    return {
      id: options.id,
      motion,
      position: motion.position,
      health,
      maxHealth: health,
      radius: options.enemy && options.ace ? ENEMY_BALANCE.aceRadius : ENEMY_BALANCE.fighterRadius,
      destroyed: false,
      enemy: options.enemy,
      ace: options.ace,
      gunCooldown: prng.uniform(
        ENEMY_BALANCE.initialGunCooldownMin,
        ENEMY_BALANCE.initialGunCooldownMax,
      ),
      missileCooldown: prng.uniform(
        ENEMY_BALANCE.initialMissileCooldownMin,
        ENEMY_BALANCE.initialMissileCooldownMax,
      ),
      aiSeed: prng.random() * Math.PI * 2,
      visual,
      model: new AirplaneModelController(visual.group, visual.jetFlames, BASIS),
    };
  }

  const player = makeAircraft({
    id: PLAYER_ID,
    enemy: false,
    ace: false,
    bodyColor: 0xeaf6ff,
    accentColor: 0x31d6ff,
    scale: 10,
    position: BASIS.fromBasisComponents(0, PLAYER_TUNING.initialAltitude, 0),
    yaw: 0,
  });
  const enemies: Aircraft[] = [];
  let nextEnemyId = 1;

  const liveEnemies = (): Aircraft[] => enemies.filter((enemy) => !enemy.destroyed);

  // -- referees ---------------------------------------------------------------------
  const combat = new CombatPlay({ maxHealth: 100, maxArmor: 30, armorAbsorption: 0.45 });
  combat.addPlayer({
    playerId: PLAYER_ID,
    teamId: "blue",
    health: PLAYER_TUNING.health,
    armor: PLAYER_TUNING.armor,
  });
  // The red team is represented by a sentinel so combat never auto-finishes
  // while bandits respawn in waves (the demo does the same).
  combat.addPlayer({ playerId: "red-force", teamId: "red", health: 100, armor: 0 });
  combat.startGame();

  const flight = new FlightPlay({ crashHeightAt: terrainHeightAt, basis: BASIS });
  flight.addPlayer({ playerId: PLAYER_ID, position: vec(player.position) });
  flight.startGame();

  const waves = new WaveSpawnDirector({
    baseWaveSize: ENEMY_BALANCE.baseWaveSize,
    growthPerWave: ENEMY_BALANCE.growthPerWave,
    maxWaveSize: ENEMY_BALANCE.maxWaveSize,
    maxSpawnsPerStep: ENEMY_BALANCE.maxSpawnsPerStep,
    typeWeights: {
      fighter: 1,
      ace: (wave: number): number =>
        Math.max(0, wave - ENEMY_BALANCE.aceUnlockWave + 1) *
        ENEMY_BALANCE.aceWeightPerWaveAfterUnlock,
    },
    unlockRules: [
      { waveNumber: 1, type: "fighter" },
      { waveNumber: ENEMY_BALANCE.aceUnlockWave, type: "ace" },
    ],
    prng,
  });

  // -- player fire control ---------------------------------------------------------
  const weaponSystem = new ProjectileWeaponSystem({
    aimMode: WEAPON_AIM_MODES.BORESIGHT,
    lockRequiredSeconds: LOCK.lockRequiredSeconds,
    targetAimDotMin: LOCK.targetAimDotMin,
    targetMaxDistance: LOCK.targetMaxDistance,
    clock,
  });
  weaponSystem.updateWeaponConfig(WEAPON_TYPES.GUN, {
    ammo: Infinity,
    maxAmmo: Infinity,
    fireRate: PLAYER_GUN.fireRate,
    speed: PLAYER_GUN.speed,
    launchOffset: PLAYER_GUN.launchOffset,
  });
  weaponSystem.updateWeaponConfig(WEAPON_TYPES.MISSILE, {
    ammo: PLAYER_MISSILE.ammo,
    maxAmmo: PLAYER_MISSILE.ammo,
    fireRate: PLAYER_MISSILE.fireRate,
    speed: PLAYER_MISSILE.speed,
    launchOffset: PLAYER_MISSILE.launchOffset,
  });

  // -- projectiles (per-team target lists; ProjectileObject drives visuals) --------
  const makeManager = (): ProjectileManager =>
    new ProjectileManager({
      basis: BASIS,
      // The manager forwards our own spawn options; ProjectileObject's richer
      // visual type is what we actually passed in.
      createProjectile: (config) => new ProjectileObject(config as ProjectileObjectOptions),
    });
  const playerShots = makeManager();
  const enemyShots = makeManager();

  interface SpawnShotOptions {
    manager: ProjectileManager;
    owner: Aircraft;
    weaponId: string;
    damage: number;
    position: Vector3;
    direction: Vector3;
    speed: number;
    target: Aircraft | null;
    lifetimeSeconds: number;
    hitRadius: number;
    turnResponse: number;
  }

  function spawnShot(options: SpawnShotOptions): void {
    const visual =
      options.weaponId === WEAPON_TYPES.MISSILE
        ? createMissileProjectileVisual(scene)
        : createBulletProjectileVisual(scene);
    options.manager.spawnProjectile({
      visual,
      metadata: {
        weaponId: options.weaponId,
        damage: options.damage,
        sourceId: options.owner.id,
      } satisfies ProjectileMeta,
      position: options.position,
      direction: options.direction,
      speed: options.speed,
      target: options.target,
      lifetimeSeconds: options.lifetimeSeconds,
      hitRadius: options.hitRadius,
      turnResponse: options.turnResponse,
      basis: BASIS,
    });
    if (options.weaponId === WEAPON_TYPES.GUN) {
      effects.spawnTracer(
        options.position,
        options.position.clone().addScaledVector(options.direction, TRACER_LENGTH),
        TRACER_COLOR,
        TRACER_TTL,
      );
    }
  }

  // -- chase camera ------------------------------------------------------------------
  const cameraRig = new PoseFollowCameraRig({
    cameraOffset: { forward: -52, up: 16, right: 0 },
    lookAtOffset: { forward: 100, up: 8, right: 0 },
    speedCameraOffset: { forward: -0.05, up: 0.01, right: 0 },
    positionLag: 0.08,
    lookLag: 0.04,
    frameLag: 0.06,
    basis: BASIS,
  });

  // -- hud/message + probe state ---------------------------------------------------------
  let elapsedSeconds = 0;
  let score = 0;
  let damageFlash = 0;
  let message = "WAVE 1 INBOUND";
  let messageTimer = 2;
  let lastWaveNumber = 1;

  const probe: DogfightProbe = {
    sceneId: scene.__scene,
    playerNodeId: player.visual.group.__id,
    steps: 0,
    waveNumber: 1,
    enemiesSpawned: 0,
    enemiesDestroyed: 0,
    playerGunShots: 0,
    playerMissileShots: 0,
    playerHitsLanded: 0,
    playerHealth: player.health,
    score: 0,
    crashes: 0,
    playerDestroyed: false,
    lockStatus: MISSILE_LOCK_STATUS.NONE,
    playerPosition: vec(player.position),
  };
  (globalThis as Record<string, unknown>).__dogfightProbe = probe;

  function showMessage(text: string, seconds: number): void {
    message = text;
    messageTimer = seconds;
  }

  // -- damage / destruction ---------------------------------------------------------------
  function destroyAircraft(target: Aircraft): void {
    target.destroyed = true;
    effects.emitHitBurst(target.position, BASIS.upVector(), 0xff5a22, 48, 120, 2.4, 900);
    target.visual.group.destroy();
    if (target.enemy) {
      score += KILL_SCORE;
      combat.heal({ playerId: PLAYER_ID, amount: KILL_HEAL });
      player.health = combat.getPlayer(PLAYER_ID).health;
      probe.enemiesDestroyed += 1;
      showMessage("SPLASH ONE", 2);
    } else {
      probe.playerDestroyed = true;
    }
  }

  function applyDamage(
    target: Aircraft,
    amount: number,
    sourceId: string,
    bypassArmor = false,
  ): void {
    if (target.destroyed) return;
    target.health = Math.max(0, target.health - amount);
    if (!target.enemy) {
      combat.damage({ playerId: PLAYER_ID, amount, sourceId, bypassArmor });
      target.health = combat.getPlayer(PLAYER_ID).health;
      damageFlash = 1;
    }
    if (target.health > 0) return;
    destroyAircraft(target);
  }

  // -- enemy brain (demo game.js steering, fresh composition) -----------------------------
  const scratchTo = new Vector3();
  const scratchDir = new Vector3();

  function steerEnemyToward(
    enemy: Aircraft,
    targetPosition: Vector3,
    dt: number,
    aggression: number,
  ): number {
    const frame = BASIS.yawPitchRollFrame(enemy.motion.yaw, enemy.motion.pitch, enemy.motion.roll);
    scratchTo.copy(targetPosition).sub(enemy.position);
    const distance = scratchTo.length();
    const desiredYaw = BASIS.forwardToYaw(scratchTo);
    const yawError = shortestAngleDelta(desiredYaw, enemy.motion.yaw);
    scratchDir.copy(scratchTo);
    if (distance > 1e-6) scratchDir.multiplyScalar(1 / distance);
    const desiredPitch = Math.asin(clamp(BASIS.upComponent(scratchDir), -0.85, 0.85));
    const pitchError = clamp(desiredPitch - enemy.motion.pitch, -1, 1);
    enemy.motion.yaw += clamp(yawError, -0.85, 0.85) * 0.42 * aggression * dt;
    enemy.motion.pitch += Math.sin(elapsedSeconds * 0.9 + enemy.aiSeed) * 0.25 * dt;
    enemy.motion.planMovement({
      left: yawError > 0.08 ? 1 : 0,
      right: yawError < -0.08 ? 1 : 0,
      up: pitchError > 0.04 ? 1 : 0,
      down: pitchError < -0.04 ? 1 : 0,
      throttle: distance > 900 ? 1 : -0.25,
      boost: false,
      deltaSeconds: dt,
      commit: true,
    });
    if (BASIS.upComponent(enemy.position) < 120) {
      enemy.motion.pitch = smoothToward(enemy.motion.pitch, 0.28, 0.2, dt);
    }
    return frame.forward.dot(scratchDir);
  }

  function enforcePlayerSpacing(enemy: Aircraft): void {
    const offset = enemy.position.clone().sub(player.position);
    const distance = offset.length();
    if (distance >= ENEMY_BALANCE.minPlayerDistance) return;
    const direction =
      distance > 1e-6
        ? offset.multiplyScalar(1 / distance)
        : BASIS.yawPitchRollFrame(enemy.motion.yaw, enemy.motion.pitch, enemy.motion.roll)
            .forward.multiplyScalar(-1)
            .normalize();
    enemy.position
      .copy(player.position)
      .addScaledVector(direction, ENEMY_BALANCE.minPlayerDistance);
  }

  function enemyShoot(enemy: Aircraft, aimDot: number, distance: number, dt: number): void {
    enemy.gunCooldown -= dt;
    enemy.missileCooldown -= dt;
    if (
      aimDot < ENEMY_BALANCE.gunAimDotMin ||
      distance > ENEMY_BALANCE.gunRange ||
      enemy.gunCooldown > 0
    ) {
      return;
    }

    const frame = BASIS.yawPitchRollFrame(enemy.motion.yaw, enemy.motion.pitch, enemy.motion.roll);
    spawnShot({
      manager: enemyShots,
      owner: enemy,
      weaponId: WEAPON_TYPES.GUN,
      damage: ENEMY_BALANCE.gunDamage,
      position: enemy.position.clone().addScaledVector(frame.forward, 18),
      direction: frame.forward.clone(),
      speed: ENEMY_BALANCE.gunProjectileSpeed + enemy.motion.speed * GUN_SPEED_INHERIT,
      target: null,
      lifetimeSeconds: PLAYER_GUN.lifetimeSeconds,
      hitRadius: PLAYER_GUN.hitRadius + PLAYER_TUNING.radius,
      turnResponse: 0,
    });
    enemy.gunCooldown = prng.uniform(ENEMY_BALANCE.gunCooldownMin, ENEMY_BALANCE.gunCooldownMax);

    if (
      enemy.missileCooldown <= 0 &&
      distance > ENEMY_BALANCE.missileMinRange &&
      !player.destroyed
    ) {
      spawnShot({
        manager: enemyShots,
        owner: enemy,
        weaponId: WEAPON_TYPES.MISSILE,
        damage: ENEMY_BALANCE.missileDamage,
        position: enemy.position.clone().addScaledVector(frame.forward, 26),
        direction: frame.forward.clone(),
        speed: ENEMY_BALANCE.missileProjectileSpeed,
        target: player,
        lifetimeSeconds: PLAYER_MISSILE.lifetimeSeconds,
        hitRadius: PLAYER_MISSILE.hitRadius + PLAYER_TUNING.radius,
        turnResponse: PLAYER_MISSILE.turnResponse,
      });
      enemy.missileCooldown = prng.uniform(
        ENEMY_BALANCE.missileCooldownMin,
        ENEMY_BALANCE.missileCooldownMax,
      );
    }
  }

  function spawnEnemy(type: string | undefined, waveNumber: number, spawnIndex: number): void {
    const angle = prng.uniform(0, Math.PI * 2);
    const distance = prng.uniform(ENEMY_BALANCE.spawnDistanceMin, ENEMY_BALANCE.spawnDistanceMax);
    const right = Math.cos(angle) * distance + BASIS.rightComponent(player.position);
    const forward = Math.sin(angle) * distance + BASIS.forwardComponent(player.position);
    const up = prng.uniform(ENEMY_BALANCE.spawnAltitudeMin, ENEMY_BALANCE.spawnAltitudeMax);
    const position = BASIS.fromBasisComponents(right, up, forward);
    const toPlayer = player.position.clone().sub(position).normalize();
    const ace = type === "ace";
    const enemy = makeAircraft({
      id: `enemy-${waveNumber}-${spawnIndex}-${nextEnemyId}`,
      enemy: true,
      ace,
      bodyColor: ace ? 0xffdfd3 : 0xf5a097,
      accentColor: ace ? 0xffd23f : 0xff4a36,
      scale: ace ? 10 : 8.8,
      position,
      yaw: BASIS.forwardToYaw(toPlayer),
    });
    nextEnemyId += 1;
    enemies.push(enemy);
    probe.enemiesSpawned += 1;
  }

  // -- player weapon triggers --------------------------------------------------------------
  function requestPlayerFire(weaponId: string): void {
    weaponSystem.selectWeapon(weaponId);
    const frame = BASIS.yawPitchRollFrame(
      player.motion.yaw,
      player.motion.pitch,
      player.motion.roll,
    );
    const decision: WeaponFireDecision | null = weaponSystem.requestFire({
      shooterPosition: player.position,
      shooterBodyFrame: frame,
      weaponId,
    });
    if (!decision) return;

    if (decision.type === WEAPON_DECISIONS.FIRE_GUN) {
      spawnShot({
        manager: playerShots,
        owner: player,
        weaponId: WEAPON_TYPES.GUN,
        damage: PLAYER_GUN.damage,
        position: decision.position,
        direction: decision.direction,
        speed: (decision.speed ?? PLAYER_GUN.speed) + player.motion.speed * GUN_SPEED_INHERIT,
        target: null,
        lifetimeSeconds: PLAYER_GUN.lifetimeSeconds,
        // Uniform bandit body radius folded into the projectile radius
        // (ProjectileObject carries one hitRadius; aces are +9 in the demo).
        hitRadius: PLAYER_GUN.hitRadius + ENEMY_BALANCE.fighterRadius,
        turnResponse: 0,
      });
      probe.playerGunShots += 1;
    } else if (decision.type === WEAPON_DECISIONS.FIRE_MISSILE) {
      const target = (decision.target as Aircraft | null) ?? null;
      spawnShot({
        manager: playerShots,
        owner: player,
        weaponId: WEAPON_TYPES.MISSILE,
        damage: PLAYER_MISSILE.damage,
        position: decision.position,
        direction: decision.direction,
        speed: decision.speed ?? PLAYER_MISSILE.speed,
        target,
        lifetimeSeconds: PLAYER_MISSILE.lifetimeSeconds,
        hitRadius: PLAYER_MISSILE.hitRadius + (target ? target.radius : ENEMY_BALANCE.fighterRadius),
        turnResponse: PLAYER_MISSILE.turnResponse,
      });
      probe.playerMissileShots += 1;
      showMessage("FOX TWO", 1.2);
    }
  }

  function resolveHits(hits: ReturnType<ProjectileManager["step"]>, shooterIsPlayer: boolean): void {
    for (const hit of hits) {
      const meta = hit.metadata as ProjectileMeta;
      const missile = meta.weaponId === WEAPON_TYPES.MISSILE;
      effects.emitHitBurst(
        hit.position,
        BASIS.upVector(),
        missile ? 0xff6b2a : 0xffe08a,
        missile ? 42 : 12,
        missile ? 130 : 50,
        2,
        650,
      );
      // Targets are always Aircraft — we own both target lists.
      applyDamage(hit.hittedTarget as Aircraft, meta.damage, meta.sourceId);
      if (shooterIsPlayer) probe.playerHitsLanded += 1;
    }
  }

  // -- fixed step -----------------------------------------------------------------------------
  function step(dt: number, input: GameInput): void {
    clock.advanceMs(dt * 1000);
    elapsedSeconds += dt;

    // Controls: nub/d-pad → bank+pitch (L converts lateral to rudder yaw),
    // TRIANGLE/CIRCLE throttle, R boost, CROSS gun, SQUARE missile.
    const b = input.buttons;
    const yawMode = (b & BTN.LTRIGGER) !== 0;
    const lateral = clamp(
      (b & BTN.RIGHT ? 1 : 0) - (b & BTN.LEFT ? 1 : 0) + input.analogX,
      -1,
      1,
    );
    const pitchUp = clamp((b & BTN.UP ? 1 : 0) + Math.max(0, -input.analogY), 0, 1);
    const pitchDown = clamp((b & BTN.DOWN ? 1 : 0) + Math.max(0, input.analogY), 0, 1);
    const throttle = (b & BTN.TRIANGLE ? 1 : 0) - (b & BTN.CIRCLE ? 1 : 0);
    const fireGun = (b & BTN.CROSS) !== 0;
    const fireMissile = (b & BTN.SQUARE) !== 0;

    // -- player flight
    if (!player.destroyed) {
      player.motion.yaw += (yawMode ? -lateral : 0) * PLAYER_TUNING.yawRate * dt;
      player.motion.planMovement({
        left: yawMode ? 0 : Math.max(0, -lateral),
        right: yawMode ? 0 : Math.max(0, lateral),
        up: pitchUp,
        down: pitchDown,
        throttle,
        boost: (b & BTN.RTRIGGER) !== 0,
        deltaSeconds: dt,
        commit: true,
      });
    }

    // -- waves + enemy brains
    const wavePlan = waves.step({ activeUnits: liveEnemies().length });
    for (const spawn of wavePlan.spawns) {
      spawnEnemy(spawn.type, spawn.waveNumber, spawn.spawnIndex);
    }
    const waveNumber = waves.snapshot().waveNumber;
    if (waveNumber !== lastWaveNumber) {
      lastWaveNumber = waveNumber;
      showMessage(`WAVE ${waveNumber} INBOUND`, 2);
    }

    for (const enemy of enemies) {
      if (enemy.destroyed || player.destroyed) continue;
      const aggression = enemy.ace ? ENEMY_BALANCE.aceAggression : ENEMY_BALANCE.fighterAggression;
      const away = enemy.position.clone().sub(player.position);
      const distanceToPlayer = away.length();
      const shouldBreakAway = distanceToPlayer < ENEMY_BALANCE.breakawayDistance;
      const steeringTarget =
        shouldBreakAway && distanceToPlayer > 1e-6
          ? enemy.position
              .clone()
              .addScaledVector(away.normalize(), ENEMY_BALANCE.breakawayLeadDistance)
          : player.position;
      const aimDot = steerEnemyToward(enemy, steeringTarget, dt, aggression);
      enforcePlayerSpacing(enemy);
      const terrainFloor =
        terrainHeightAt(
          BASIS.rightComponent(enemy.position),
          BASIS.forwardComponent(enemy.position),
        ) + ENEMY_BALANCE.terrainClearance;
      if (BASIS.upComponent(enemy.position) < terrainFloor) {
        BASIS.setHeight(enemy.position, terrainFloor);
        enemy.motion.pitch = Math.max(enemy.motion.pitch, 0.28);
      }
      const shotDistance = enemy.position.distanceTo(player.position);
      if (!shouldBreakAway) enemyShoot(enemy, aimDot, shotDistance, dt);
    }

    // -- player fire control (lock steps while the missile is selected)
    if (!player.destroyed) {
      const frame = BASIS.yawPitchRollFrame(
        player.motion.yaw,
        player.motion.pitch,
        player.motion.roll,
      );
      weaponSystem.step({
        shooterPosition: player.position,
        shooterBodyFrame: frame,
        targets: liveEnemies(),
        deltaSeconds: dt,
      });
      if (fireGun) requestPlayerFire(WEAPON_TYPES.GUN);
      if (fireMissile) requestPlayerFire(WEAPON_TYPES.MISSILE);
    }

    // -- projectiles (per-team target lists)
    resolveHits(playerShots.step(liveEnemies(), dt), true);
    resolveHits(enemyShots.step(player.destroyed ? [] : [player], dt), false);

    // -- referees: combat death + terrain crash
    for (const event of combat.step()) {
      if (event.type === COMBAT_PLAY_EVENTS.PLAYER_KILLED && event.playerId === PLAYER_ID) {
        if (!player.destroyed) destroyAircraft(player);
        if (event.sourceId !== "terrain") showMessage("YOU WERE SHOT DOWN", 2.5);
      }
    }
    if (!player.destroyed) {
      flight.movePlayer(PLAYER_ID, vec(player.position));
      for (const event of flight.step()) {
        void event;
        probe.crashes += 1;
        applyDamage(player, 1000, "terrain", true);
        showMessage("TERRAIN IMPACT", 2.5);
      }
    }

    // -- presentation state (guest-side mirrors; render() flushes once a frame)
    for (const actor of [player, ...enemies]) {
      if (actor.destroyed) continue;
      actor.model.step({
        position: actor.position,
        yaw: actor.motion.yaw,
        pitch: actor.motion.pitch,
        roll: actor.motion.roll,
        throttle: actor.motion.throttle,
        isBoosting: actor.motion.isBoosting,
        elapsedTimeSeconds: elapsedSeconds,
        deltaSeconds: dt,
      });
    }
    effects.step(dt);
    cameraRig.step({
      targetPosition: player.position,
      targetFrame: BASIS.yawPitchRollFrame(
        player.motion.yaw,
        player.motion.pitch,
        player.motion.roll,
      ),
      targetSpeed: player.motion.speed,
      snapToTarget: probe.steps === 0,
      deltaSeconds: dt,
      camera: scene.camera,
    });

    damageFlash = Math.max(0, damageFlash - dt * 1.9);
    if (messageTimer > 0) {
      messageTimer -= dt;
      if (messageTimer <= 0) message = "";
    }

    probe.steps += 1;
    probe.waveNumber = waveNumber;
    probe.playerHealth = player.health;
    probe.score = score;
    probe.lockStatus = weaponSystem.lockStatus;
    probe.playerPosition = vec(player.position);
  }

  // -- HUD snapshot ------------------------------------------------------------------------------
  function hudState(): DogfightHudState {
    const altitude = BASIS.upComponent(player.position);
    const ground = terrainHeightAt(
      BASIS.rightComponent(player.position),
      BASIS.forwardComponent(player.position),
    );
    const agl = altitude - ground;
    const missiles = weaponSystem.weapons.get(WEAPON_TYPES.MISSILE)?.ammo ?? 0;
    const frame = BASIS.yawPitchRollFrame(
      player.motion.yaw,
      player.motion.pitch,
      player.motion.roll,
    );
    return {
      speed: Math.round(player.motion.speed),
      altitude: Math.max(0, Math.round(altitude)),
      agl: Math.max(0, Math.round(agl)),
      health: Math.max(0, Math.round(player.health)),
      score,
      waveNumber: waves.snapshot().waveNumber,
      banditsAlive: liveEnemies().length,
      weaponLabel:
        weaponSystem.selectedWeaponId === WEAPON_TYPES.MISSILE
          ? `MSL ${String(missiles).padStart(2, "0")}`
          : "GUN",
      lockStatus: weaponSystem.lockStatus,
      missiles,
      gunHeat: weaponSystem.gunHeat,
      throttle: player.motion.throttle,
      headingDeg: ((-toDeg(player.motion.yaw)) % 360 + 360) % 360,
      pitchDeg: toDeg(player.motion.pitch),
      rollDeg: toDeg(player.motion.roll),
      pullUp: !player.destroyed && agl < PULL_UP_AGL,
      failed: player.destroyed,
      damageFlash,
      message,
      playerPosition: vec(player.position),
      playerForward: vec(frame.forward),
      contacts: liveEnemies().map(
        (enemy): RadarContactState => ({
          position: vec(enemy.position),
          color: 0xff4f42,
          size: 5,
        }),
      ),
    };
  }

  return { scene, step, hudState };
}
