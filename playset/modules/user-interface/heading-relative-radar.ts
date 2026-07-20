// playset/modules/user-interface/heading-relative-radar.ts — heading-relative
// radar: contacts projected into the player's yaw frame, range-clamped to the
// scope edge, rendered as dot Views inside a fixed square scope.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/HeadingRelativeRadar.js. The projection
// math (radar radius = min(w,h)/2 − 11, ±range planar bounds, yaw-frame
// rotation, range clamp) is verbatim in HeadingRelativeRadarProjection; the
// Canvas2D painting is replaced by a PocketJS View tree: background/ring/
// crosshair as static Views, contacts as an <Index> of translated dot Views
// (Index, not For: rows are positional projections recomputed per update —
// For would tear every dot down each frame). Deviations forced by the move:
// cross/triangle contact shapes and the player arrow collapse to dots (no
// path primitive), contact yaw rotation is dropped with them, and the
// devicePixelRatio canvas-resolution sync is moot for native views. rgba()
// colors converted to #rrggbbaa.

import type { JSX as SolidJSX } from "solid-js";
import { Index, Show, createMemo } from "solid-js";
import { View, type ViewProps } from "@pocketjs/framework/components";
import { clamp01 } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import { MinimapProjector2D, type Point2D } from "./minimap-projector-2d.ts";

type StyleObject = NonNullable<ViewProps["style"]>;

// spec/spec.ts ENUMS ordinals (stable wire values; playset avoids a spec dep).
const POS_ABSOLUTE = 1;

const RADAR_BG = "#060c14db"; // rgba(6,12,20,0.86)
const RADAR_AXES = "#8caad238"; // rgba(140,170,210,0.22)
const RADAR_RING = "#8caad257"; // rgba(140,170,210,0.34)
const RADAR_BORDER = "#7794bc61"; // rgba(119,148,188,0.38)
const PLAYER_DOT_RADIUS = 5.6; // the original arrow's half-width

export interface Vec3Reading {
  x: number;
  y: number;
  z: number;
}

export function parseVec3Reading(value: VecLike | null | undefined): Vec3Reading | null {
  if (!value) return null;

  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function toCssColor(value: string | number | null | undefined, fallback = "#53fe8e"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (Number.isFinite(value)) return `#${(value as number).toString(16).padStart(6, "0")}`;
  return fallback;
}

export interface HeadingRelativeRadarProjectionOptions {
  width?: number;
  height?: number;
  range?: number;
  basis?: WorldBasis;
}

/** The original's scope geometry + projection, minus the canvas. */
export class HeadingRelativeRadarProjection {
  basis: WorldBasis;
  projector: MinimapProjector2D;
  range!: number;
  width!: number;
  height!: number;
  radarRadius!: number;
  radarCenterX!: number;
  radarCenterY!: number;
  radarOriginX!: number;
  radarOriginY!: number;

  constructor({
    width = 250,
    height = 200,
    range = 20,
    basis = DEFAULT_WORLD_BASIS,
  }: HeadingRelativeRadarProjectionOptions = {}) {
    this.basis = basis;
    this.projector = new MinimapProjector2D({
      planarBounds: {
        minRight: -range,
        maxRight: range,
        minForward: -range,
        maxForward: range,
      },
      width,
      height,
    });
    this.setRange(range);
    this.setSize(width, height);
  }

  setRange(range: number): void {
    this.range = Math.max(0.5, range);
    this.projector.setPlanarBounds(-this.range, this.range, -this.range, this.range);
  }

  setBasis(basis: WorldBasis = DEFAULT_WORLD_BASIS): this {
    this.basis = basis;
    return this;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.radarRadius = Math.max(1, Math.min(this.width, this.height) * 0.5 - 11);
    this.radarCenterX = this.width * 0.5;
    this.radarCenterY = this.height * 0.5;
    this.radarOriginX = this.radarCenterX - this.radarRadius;
    this.radarOriginY = this.radarCenterY - this.radarRadius;
    this.projector.setViewport(this.radarRadius * 2, this.radarRadius * 2, 0);
  }

  yawFromForward(forward: VecLike | null | undefined): number {
    return this.basis.forwardToYaw(forward);
  }

  projectRelativePoint(localRight: number, localForward: number, out: Point2D = { x: 0, y: 0 }): Point2D {
    const distance = Math.hypot(localRight, localForward);
    let clampedRight = localRight;
    let clampedForward = localForward;

    if (distance > this.range) {
      const scale = this.range / distance;
      clampedRight *= scale;
      clampedForward *= scale;
    }

    this.projector.projectPlanar(clampedRight, clampedForward, out);
    out.x += this.radarOriginX;
    out.y += this.radarOriginY;
    return out;
  }

  projectContact(
    position: VecLike,
    playerPosition: VecLike,
    playerYaw: number,
    out: Point2D = { x: 0, y: 0 },
  ): Point2D {
    const delta = this.basis.planarDelta(position, playerPosition);
    const dRight = delta.right;
    const dForward = delta.forward;
    const cos = Math.cos(playerYaw);
    const sin = Math.sin(playerYaw);
    return this.projectRelativePoint(
      cos * dRight + sin * dForward,
      -sin * dRight + cos * dForward,
      out,
    );
  }
}

export interface RadarContact extends Record<string, unknown> {
  position?: VecLike | null;
  x?: number;
  y?: number;
  z?: number;
  color?: string | number;
  opacity?: number;
  size?: number;
  yaw?: number;
  shape?: string;
}

export interface HeadingRelativeRadarProps {
  playerPosition: () => VecLike | null | undefined;
  /** Omitted entirely, or returning null ⇒ basis forward (original semantics). */
  playerForward?: () => VecLike | null | undefined;
  contacts?: () => RadarContact[];
  width?: number;
  height?: number;
  range?: number | (() => number);
  playerColor?: string | number;
  contactColor?: string | number;
  contactOpacity?: number;
  basis?: WorldBasis;
}

interface ProjectedContact {
  x: number;
  y: number;
  size: number;
  color: string;
  opacity: number;
}

export function HeadingRelativeRadar(props: HeadingRelativeRadarProps): SolidJSX.Element {
  const width = Math.max(1, Math.floor(props.width ?? 250));
  const height = Math.max(1, Math.floor(props.height ?? 200));
  const basis = props.basis ?? DEFAULT_WORLD_BASIS;
  const playerColor = toCssColor(props.playerColor ?? 0x53fe8e);
  const contactColor = toCssColor(props.contactColor ?? 0xff4444, "#ff4444");
  const contactOpacity = clamp01(props.contactOpacity ?? 0.85);
  const range = (): number =>
    typeof props.range === "function" ? props.range() : (props.range ?? 20);

  const projection = createMemo(
    () => new HeadingRelativeRadarProjection({ width, height, range: range(), basis }),
  );
  // Scope geometry depends only on the (static) width/height.
  const { radarRadius, radarCenterX, radarCenterY, radarOriginX, radarOriginY } = projection();

  const player = createMemo<{ position: Vec3Reading; yaw: number } | null>(() => {
    const position = parseVec3Reading(props.playerPosition());
    if (!position) return null;

    const forwardReading = props.playerForward ? (props.playerForward() ?? null) : null;
    const forward = forwardReading === null ? basis.forwardVector() : parseVec3Reading(forwardReading);
    if (!forward) return null;
    return { position, yaw: projection().yawFromForward(forward) };
  });

  const dots = createMemo<ProjectedContact[]>(() => {
    const current = player();
    if (!current) return [];
    const proj = projection();
    const out: ProjectedContact[] = [];
    for (const contact of props.contacts?.() ?? []) {
      const contactPosition = parseVec3Reading(contact?.position ?? contact);
      if (!contactPosition) continue;

      const point = proj.projectContact(contactPosition, current.position, current.yaw, {
        x: 0,
        y: 0,
      });
      out.push({
        x: point.x,
        y: point.y,
        size: Math.max(2, Number(contact.size) || 4.2),
        color: toCssColor(contact.color, contactColor),
        opacity: clamp01(Number(contact.opacity ?? contactOpacity) || 0),
      });
    }
    return out;
  });

  const dot = (style: StyleObject): SolidJSX.Element => View({ style });

  return View({
    debugName: "HeadingRelativeRadar",
    style: {
      width,
      height,
      bgColor: RADAR_BG,
      borderColor: RADAR_BORDER,
      borderWidth: 1,
    },
    children: [
      // crosshair axes
      dot({
        posType: POS_ABSOLUTE,
        insetL: radarCenterX - 0.5,
        insetT: radarOriginY,
        width: 1,
        height: radarRadius * 2,
        bgColor: RADAR_AXES,
      }),
      dot({
        posType: POS_ABSOLUTE,
        insetL: radarOriginX,
        insetT: radarCenterY - 0.5,
        width: radarRadius * 2,
        height: 1,
        bgColor: RADAR_AXES,
      }),
      // range ring
      dot({
        posType: POS_ABSOLUTE,
        insetL: radarOriginX,
        insetT: radarOriginY,
        width: radarRadius * 2,
        height: radarRadius * 2,
        radius: radarRadius,
        borderColor: RADAR_RING,
        borderWidth: 1,
      }),
      // contacts
      Index({
        get each() {
          return dots();
        },
        children: (item: () => ProjectedContact) =>
          View({
            get style(): StyleObject {
              const d = item();
              return {
                posType: POS_ABSOLUTE,
                insetL: 0,
                insetT: 0,
                width: d.size * 2,
                height: d.size * 2,
                radius: d.size,
                bgColor: d.color,
                opacity: d.opacity,
                translateX: d.x - d.size,
                translateY: d.y - d.size,
              };
            },
          }),
      }) as unknown as SolidJSX.Element,
      // player marker — projectRelativePoint(0,0) is always the scope center
      Show({
        get when() {
          return player() !== null;
        },
        get children() {
          return dot({
            posType: POS_ABSOLUTE,
            insetL: radarCenterX - PLAYER_DOT_RADIUS,
            insetT: radarCenterY - PLAYER_DOT_RADIUS,
            width: PLAYER_DOT_RADIUS * 2,
            height: PLAYER_DOT_RADIUS * 2,
            radius: PLAYER_DOT_RADIUS,
            bgColor: playerColor,
          });
        },
      }) as unknown as SolidJSX.Element,
    ],
  });
}
