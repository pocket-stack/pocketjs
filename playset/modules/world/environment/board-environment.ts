// playset/modules/world/environment/board-environment.ts — a cell-grid game
// board: ground plane, translucent grid, ambient + key lighting, and the
// cell↔world mapping helpers.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/world/environment/BoardEnvironment.js. Deliberate changes
// for the scene3d surface:
//   - `scene` is a Scene3D (or null: board math only — SceneNodes need a
//     scene, so visuals are skipped and `group` stays null).
//   - Material roughness/metalness dropped (no fixed-function analog); node
//     names dropped (no scene3d analog).
//   - scene3d planes are already flat in XZ facing +Y, so the ground uses
//     the OBJECT canonical rotation, not three's plane rotation.
//   - GridHelper becomes unlit thin boxes under a grid node that carries the
//     original's non-uniform scale; gridOpacity rides in the material color
//     alpha (MAT.transparent).
//   - AmbientLight → scene.ambient(c, c); DirectionalLight → scene.sun(dir,
//     c) with dir derived from keyLightPosition toward the board center (the
//     original's shadow-camera aim). Intensities scale the colors. Shadow
//     map config dropped: shadows → blob decals, see world/blob-shadow.ts.
//     `ambientLight`/`keyLight` become plain descriptor records.

import { Vector3 } from "../../../math/index.ts";
import { DEFAULT_WORLD_BASIS, type WorldBasis } from "../../math/world-basis.ts";
import { MAT, type Scene3D, type SceneNode } from "../../../scene3d/client.ts";
import type { PlanarPoint } from "./planar-utils.ts";

/** spec ABGR byte order: (a<<24)|(b<<16)|(g<<8)|r. Local on purpose. */
function rgbToAbgr(hex: number, alpha = 255): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return (((alpha & 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Intensity-scaled light color (fixed-function has no intensity knob). */
function scaledRgbToAbgr(hex: number, intensity: number): number {
  const scale = (channel: number): number =>
    Math.max(0, Math.min(255, Math.round(channel * intensity)));
  const r = scale((hex >> 16) & 255);
  const g = scale((hex >> 8) & 255);
  const b = scale(hex & 255);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const GRID_LINE_HALF_THICKNESS = 0.02;
const GRID_LINE_HALF_HEIGHT = 0.005;

function sanitizeBoardSize(columns: number, rows: number, cellSize: number): {
  columns: number;
  rows: number;
  cellSize: number;
} {
  return {
    columns: Math.max(2, Math.floor(columns)),
    rows: Math.max(2, Math.floor(rows)),
    cellSize: Math.max(0.01, cellSize),
  };
}

export function boardCenterOffset(columns: number, rows: number, cellSize: number): PlanarPoint {
  return {
    right: (columns - 1) * cellSize * 0.5,
    forward: (rows - 1) * cellSize * 0.5,
  };
}

export function defaultBoardOrigin(rows: number, cellSize: number, basis: WorldBasis = DEFAULT_WORLD_BASIS): Vector3 {
  return basis.fromBasisComponents(0, 0, -(rows - 1) * cellSize);
}

export function offsetBoardPoint(
  origin: Vector3,
  right = 0,
  up = 0,
  forward = 0,
  basis: WorldBasis = DEFAULT_WORLD_BASIS,
): Vector3 {
  return new Vector3()
    .copy(origin)
    .add(basis.fromBasisComponents(right, up, forward));
}

export interface BoardLightDescriptor {
  color: number;
  intensity: number;
  position?: Vector3;
  target?: Vector3;
  direction?: Vector3;
}

export interface BoardEnvironmentOptions {
  scene?: Scene3D | null;
  columns?: number;
  rows?: number;
  cellSize?: number;
  backgroundScale?: number;
  boardUp?: number;
  gridUp?: number;
  groundColor?: number;
  gridColor?: number;
  gridOpacity?: number;
  /** Accepted for API compatibility; ignored (no fixed-function analog). */
  groundRoughness?: number;
  /** Accepted for API compatibility; ignored (no fixed-function analog). */
  groundMetalness?: number;
  lighting?: boolean;
  ambientColor?: number;
  ambientIntensity?: number;
  keyLightColor?: number;
  keyLightIntensity?: number;
  keyLightPosition?: { right: number; up: number; forward: number };
  /** Accepted for API compatibility; ignored (shadows → blob decals). */
  shadowMapSize?: number;
  /** Accepted for API compatibility; ignored (shadows → blob decals). */
  shadowExtent?: number;
  name?: string;
  basis?: WorldBasis;
}

export class BoardEnvironment {
  scene: Scene3D | null;
  columns: number;
  rows: number;
  cellSize: number;
  backgroundScale: number;
  boardUp: number;
  gridUp: number;
  groundColor: number;
  gridColor: number;
  gridOpacity: number;
  groundRoughness: number;
  groundMetalness: number;
  lighting: boolean;
  ambientColor: number;
  ambientIntensity: number;
  keyLightColor: number;
  keyLightIntensity: number;
  keyLightPosition: { right: number; up: number; forward: number };
  shadowMapSize: number;
  shadowExtent: number;
  name: string;
  basis: WorldBasis;
  origin: Vector3;
  centerOffset: PlanarPoint;
  center: Vector3;
  bounds: Readonly<{ minRight: number; maxRight: number; minForward: number; maxForward: number }>;
  boardWidth: number;
  boardLength: number;
  group: SceneNode | null;
  boardMesh: SceneNode | null;
  gridHelper: SceneNode | null;
  ambientLight: BoardLightDescriptor | null;
  keyLight: BoardLightDescriptor | null;
  created: boolean;

  constructor({
    scene = null,
    columns = 20,
    rows = 20,
    cellSize = 1,
    backgroundScale = 2.5,
    boardUp = -0.5,
    gridUp = -0.49,
    groundColor = 0xd68a4c,
    gridColor = 0xffffff,
    gridOpacity = 0.3,
    groundRoughness = 1,
    groundMetalness = 0,
    lighting = true,
    ambientColor = 0xffffff,
    ambientIntensity = 0.6,
    keyLightColor = 0xffffff,
    keyLightIntensity = 0.7,
    keyLightPosition = { right: 20, up: 18, forward: 20 },
    shadowMapSize = 1024,
    shadowExtent = 30,
    name = 'BoardEnvironment',
    basis = DEFAULT_WORLD_BASIS,
  }: BoardEnvironmentOptions = {}) {
    const safeSize = sanitizeBoardSize(columns, rows, cellSize);

    this.scene = scene;
    this.columns = safeSize.columns;
    this.rows = safeSize.rows;
    this.cellSize = safeSize.cellSize;
    this.backgroundScale = Math.max(1, backgroundScale);
    this.boardUp = boardUp;
    this.gridUp = gridUp;
    this.groundColor = groundColor;
    this.gridColor = gridColor;
    this.gridOpacity = gridOpacity;
    this.groundRoughness = groundRoughness;
    this.groundMetalness = groundMetalness;
    this.lighting = lighting;
    this.ambientColor = ambientColor;
    this.ambientIntensity = ambientIntensity;
    this.keyLightColor = keyLightColor;
    this.keyLightIntensity = keyLightIntensity;
    this.keyLightPosition = keyLightPosition;
    this.shadowMapSize = shadowMapSize;
    this.shadowExtent = shadowExtent;
    this.name = name;
    this.basis = basis;
    this.origin = defaultBoardOrigin(this.rows, this.cellSize, this.basis);
    this.centerOffset = boardCenterOffset(this.columns, this.rows, this.cellSize);
    this.center = offsetBoardPoint(
      this.origin,
      this.centerOffset.right,
      0,
      this.centerOffset.forward,
      this.basis,
    );
    this.bounds = Object.freeze({
      minRight: 0,
      maxRight: this.columns - 1,
      minForward: 0,
      maxForward: this.rows - 1,
    });
    this.boardWidth = this.columns * this.cellSize * this.backgroundScale;
    this.boardLength = this.rows * this.cellSize * this.backgroundScale;
    this.group = scene ? scene.node() : null;
    this.boardMesh = null;
    this.gridHelper = null;
    this.ambientLight = null;
    this.keyLight = null;
    this.created = false;
  }

  create(): this {
    if (this.created) return this;

    if (this.scene && this.group) {
      this.createBoardMesh();
      this.createGridHelper();
      if (this.lighting) {
        this.createKeyLight();
        this.createAmbientLight();
      }
    }
    this.created = true;
    return this;
  }

  cellToWorldPoint(cell: PlanarPoint, up = 0): Vector3 {
    return offsetBoardPoint(
      this.origin,
      cell.right * this.cellSize,
      up,
      cell.forward * this.cellSize,
      this.basis,
    );
  }

  worldPoint(right = 0, up = 0, forward = 0): Vector3 {
    return offsetBoardPoint(this.origin, right, up, forward, this.basis);
  }

  createBoardMesh(): SceneNode {
    const scene = this.scene!;
    const geom = scene.plane(this.boardWidth, this.boardLength);
    const material = scene.material(rgbToAbgr(this.groundColor), 0);
    const boardMesh = scene.mesh(geom, material, this.group!);
    boardMesh.position.copy(this.cellToWorldPoint(this.centerOffset, this.boardUp));
    boardMesh.quaternion.copy(this.basis.threeObjectCanonicalToBasisQuaternion());
    this.boardMesh = boardMesh;
    return boardMesh;
  }

  createGridHelper(): SceneNode {
    const scene = this.scene!;
    const helperSize = Math.max(this.columns, this.rows) * this.cellSize;
    const helperDivisions = Math.max(this.columns, this.rows);
    const gridHelper = scene.node(this.group!);
    gridHelper.scale.set(
      (this.columns * this.cellSize) / helperSize,
      1,
      (this.rows * this.cellSize) / helperSize,
    );
    gridHelper.position.copy(this.cellToWorldPoint(this.centerOffset, this.gridUp));
    gridHelper.quaternion.copy(this.basis.threeObjectCanonicalToBasisQuaternion());

    const alpha = Math.max(0, Math.min(255, Math.round(this.gridOpacity * 255)));
    const material = scene.material(
      rgbToAbgr(this.gridColor, alpha),
      MAT.unlit | MAT.transparent,
    );
    const half = helperSize / 2;
    const step = helperSize / helperDivisions;
    const lineAlongX = scene.box(half, GRID_LINE_HALF_HEIGHT, GRID_LINE_HALF_THICKNESS);
    const lineAlongZ = scene.box(GRID_LINE_HALF_THICKNESS, GRID_LINE_HALF_HEIGHT, half);
    for (let i = 0; i <= helperDivisions; i += 1) {
      const k = -half + i * step;
      scene.mesh(lineAlongX, material, gridHelper).position.set(0, 0, k);
      scene.mesh(lineAlongZ, material, gridHelper).position.set(k, 0, 0);
    }

    this.gridHelper = gridHelper;
    return gridHelper;
  }

  createAmbientLight(): BoardLightDescriptor {
    const ambientLight: BoardLightDescriptor = {
      color: this.ambientColor,
      intensity: this.ambientIntensity,
    };
    const color = scaledRgbToAbgr(this.ambientColor, this.ambientIntensity);
    this.scene!.ambient(color, color);
    this.ambientLight = ambientLight;
    return ambientLight;
  }

  createKeyLight(): BoardLightDescriptor {
    const position = this.worldPoint(
      this.keyLightPosition.right,
      this.keyLightPosition.up,
      this.keyLightPosition.forward,
    );
    const target = this.center.clone();
    // The direction the light travels: from the key light toward its target.
    const direction = target.clone().sub(position).normalize();
    this.scene!.sun(direction, scaledRgbToAbgr(this.keyLightColor, this.keyLightIntensity));

    const keyLight: BoardLightDescriptor = {
      color: this.keyLightColor,
      intensity: this.keyLightIntensity,
      position,
      target,
      direction,
    };
    this.keyLight = keyLight;
    return keyLight;
  }
}
