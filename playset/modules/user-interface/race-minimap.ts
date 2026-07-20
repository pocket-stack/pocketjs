// playset/modules/user-interface/race-minimap.ts — race overview minimap:
// checkpoints, AI competitors (+ leader ring) and the local vehicle projected
// through MinimapProjector2D onto a fixed rectangle of dot Views.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/RaceMinimap.js. The projection (inherited
// MinimapProjector2D), dot radii (checkpoint 2.1 / next 3.4 / ai 2.8 / leader
// ring 4.8), style keys and next-checkpoint modulo rule are verbatim; the
// Canvas2D class becomes a PocketJS component over an internal projector.
// Deviations forced by the move: the track POLYLINE is skipped in v1 (no line
// primitive — checkpoint dots still trace the circuit), the local-vehicle
// triangle collapses to a stroked dot that still carries projectYaw as a
// rotate (degrees), canvas pixelRatio/syncResolution is moot for native
// views, and rgba() style strings are converted to #rrggbbaa. Rows render via
// <Index> (not For): they are positional projections recomputed per update —
// For would tear every dot down each frame. `basis` is exposed as a prop
// (the original hardcoded the default basis in its super() call).
//
// FAN-OUT DISCIPLINE (this is a hot component; measured, not guessed). The
// first version computed every dot from one memo that read both the static
// checkpoint list AND the live pose, so one HUD refresh woke all twelve dot
// effects, re-projected all ten checkpoints and rebuilt twelve style objects.
// On a 333 MHz PSP that was ~2/3 of a 78 ms HUD refresh — and ten of the
// twelve dots had not moved a pixel since boot. The reactive graph is now cut
// along what actually changes:
//
//   checkpointPoints     depends ONLY on `checkpoints` — projected at mount
//   nextCheckpointIndex  a NUMBER, so an unchanged next gate stops the update
//                        dead instead of reaching ten style effects
//   carDots / the local marker   the only per-refresh work, two dots' worth
//
// Everything on the per-refresh path projects through one scratch point and
// builds its style object as a flat literal (no object spread): with QuickJS
// at ~1.7 µs/op, allocation and graph churn ARE the cost, not the arithmetic.

import type { JSX as SolidJSX } from "solid-js";
import { Index, Show, createMemo } from "solid-js";
import { View, type ViewProps } from "@pocketjs/framework/components";
import { toDeg } from "../math/scalar-utils.ts";
import { DEFAULT_WORLD_BASIS, type VecLike, type WorldBasis } from "../math/world-basis.ts";
import { MinimapProjector2D, type PlanarBounds, type Point2D } from "./minimap-projector-2d.ts";

type StyleObject = NonNullable<ViewProps["style"]>;

// spec/spec.ts ENUMS ordinal (stable wire value; playset avoids a spec dep).
const POS_ABSOLUTE = 1;

export const DEFAULT_STYLES = Object.freeze({
  background: "#060a10e6", // rgba(6,10,16,0.9)
  border: "#8099bf9e", // rgba(128,153,191,0.62)
  track: "#71b9ffb8", // rgba(113,185,255,0.72) — unused until the v1 polyline gap closes
  checkpoint: "#ccdfffb3", // rgba(204,223,255,0.7)
  nextCheckpoint: "#ffe88a",
  localFill: "#f16a45",
  localStroke: "#fff0db",
  leaderRing: "#ffe88a",
});

export type RaceMinimapStyles = { -readonly [K in keyof typeof DEFAULT_STYLES]: string };

function toCssColor(value: string | number | null | undefined, fallback = "#8ab4d8"): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Number.isFinite(value)) {
    return `#${(value as number).toString(16).padStart(6, "0")}`;
  }
  return fallback;
}

export interface LocalVehicle {
  position?: VecLike | null;
  bodyFrame?: { forward?: VecLike | null } | null;
}

export interface RaceProgress {
  nextCheckpointIndex: number;
}

export interface AiCar extends Record<string, unknown> {
  id?: unknown;
  position?: VecLike | null;
  motion?: { position?: VecLike | null } | null;
  color?: string | number;
}

export interface RaceMinimapProps {
  planarBounds: PlanarBounds;
  width?: number;
  height?: number;
  padding?: number;
  invertRight?: boolean;
  invertForward?: boolean;
  basis?: WorldBasis;
  styles?: Partial<RaceMinimapStyles>;
  checkpoints?: () => (VecLike | null | undefined)[];
  localVehicle?: () => LocalVehicle | null | undefined;
  localProgress?: () => RaceProgress | null | undefined;
  aiCars?: () => AiCar[];
  aiLeaderId?: () => unknown;
}

interface ProjectedCar {
  x: number;
  y: number;
  color: string;
  leader: boolean;
}

const LOCAL_MARKER_RADIUS = 4.5; // the original triangle's half-width

export function RaceMinimap(props: RaceMinimapProps): SolidJSX.Element {
  const styles: RaceMinimapStyles = { ...DEFAULT_STYLES, ...(props.styles ?? {}) };
  const basis = props.basis ?? DEFAULT_WORLD_BASIS;
  const projector = new MinimapProjector2D({
    planarBounds: { ...props.planarBounds },
    width: props.width ?? 200,
    height: props.height ?? 200,
    padding: props.padding ?? 0,
    invertRight: props.invertRight ?? false,
    invertForward: props.invertForward ?? false,
    basis,
  });

  // Every projection on the per-refresh path lands here and is copied out
  // before the next one runs — one buffer instead of a literal per dot.
  const point: Point2D = { x: 0, y: 0 };
  // The fallback heading, resolved once (forwardVector() allocates a Vector3).
  const defaultForward = basis.forwardVector();

  // Static geometry: reads `checkpoints` and NOTHING else, so a HUD refresh
  // that only moved the cars never re-enters this.
  const checkpointPoints = createMemo<Point2D[]>(() => {
    const checkpoints = props.checkpoints?.() ?? [];
    const out: Point2D[] = [];
    for (let i = 0; i < checkpoints.length; i += 1) {
      out.push(projector.project(checkpoints[i], { x: 0, y: 0 }));
    }
    return out;
  });

  // The one checkpoint fact that moves, as a plain number: identical values
  // stop here instead of rebuilding every dot's style (the original folded
  // this into the geometry memo, which is what made the whole row churn).
  const nextCheckpointIndex = createMemo<number>(() => {
    const count = checkpointPoints().length;
    const progress = props.localProgress?.() ?? null;
    if (!progress || count === 0) return -1;
    return progress.nextCheckpointIndex % count;
  });

  const carDots = createMemo<ProjectedCar[]>(() => {
    const leaderId = props.aiLeaderId?.();
    const out: ProjectedCar[] = [];
    for (const aiCar of props.aiCars?.() ?? []) {
      const position = aiCar?.position ?? aiCar?.motion?.position ?? null;
      if (!position) continue;

      projector.project(position, point);
      out.push({
        x: point.x,
        y: point.y,
        color: toCssColor(aiCar?.color),
        leader: aiCar?.id === leaderId && leaderId != null,
      });
    }
    return out;
  });

  /** Is there a local vehicle to draw? Presence only — a boolean, so moving
   *  the player never touches the <Show> that mounts its marker. */
  const hasLocal = createMemo<boolean>(() => Boolean(props.localVehicle?.()?.position));

  // Flat style literals rather than one builder + object spread: the spread
  // copied nine keys through a generic path on every dot, every refresh.
  const fillDot = (x: number, y: number, radius: number, bgColor: string): StyleObject => ({
    posType: POS_ABSOLUTE,
    insetL: 0,
    insetT: 0,
    width: radius * 2,
    height: radius * 2,
    radius,
    translateX: x - radius,
    translateY: y - radius,
    bgColor,
  });

  const ringDot = (x: number, y: number, radius: number, borderColor: string): StyleObject => ({
    posType: POS_ABSOLUTE,
    insetL: 0,
    insetT: 0,
    width: radius * 2,
    height: radius * 2,
    radius,
    translateX: x - radius,
    translateY: y - radius,
    borderColor,
    borderWidth: 1,
  });

  return View({
    debugName: "RaceMinimap",
    style: {
      width: projector.width,
      height: projector.height,
      bgColor: styles.background,
      borderColor: styles.border,
      borderWidth: 1,
    },
    children: [
      // checkpoints (the v1 track line is these dots' circuit). Each dot owns a
      // boolean memo over the shared next-gate index, so passing a gate wakes
      // exactly the two dots whose highlight actually flipped.
      Index({
        get each() {
          return checkpointPoints();
        },
        children: (item: () => Point2D, index: number) => {
          const isNext = createMemo<boolean>(() => index === nextCheckpointIndex());
          return View({
            get style(): StyleObject {
              const p = item();
              return isNext()
                ? fillDot(p.x, p.y, 3.4, styles.nextCheckpoint)
                : fillDot(p.x, p.y, 2.1, styles.checkpoint);
            },
          });
        },
      }) as unknown as SolidJSX.Element,
      // AI competitors + leader ring
      Index({
        get each() {
          return carDots();
        },
        children: (item: () => ProjectedCar) =>
          [
            View({
              get style(): StyleObject {
                const d = item();
                return fillDot(d.x, d.y, 2.8, d.color);
              },
            }),
            Show({
              get when() {
                return item().leader;
              },
              get children() {
                return View({
                  get style(): StyleObject {
                    const d = item();
                    return ringDot(d.x, d.y, 4.8, styles.leaderRing);
                  },
                });
              },
            }),
          ] as unknown as SolidJSX.Element,
      }) as unknown as SolidJSX.Element,
      // local vehicle — triangle collapsed to a stroked dot, yaw kept as rotate.
      // Projected straight inside the style getter: an intermediate memo would
      // only add a graph hop and an object, and this runs every refresh.
      Show({
        get when() {
          return hasLocal();
        },
        get children() {
          return View({
            get style(): StyleObject {
              const vehicle = props.localVehicle?.() ?? null;
              const position = vehicle?.position;
              if (!position) return {};
              projector.project(position, point);
              const yaw = projector.projectYaw(vehicle?.bodyFrame?.forward ?? defaultForward);
              return {
                posType: POS_ABSOLUTE,
                insetL: 0,
                insetT: 0,
                width: LOCAL_MARKER_RADIUS * 2,
                height: LOCAL_MARKER_RADIUS * 2,
                radius: LOCAL_MARKER_RADIUS,
                translateX: point.x - LOCAL_MARKER_RADIUS,
                translateY: point.y - LOCAL_MARKER_RADIUS,
                bgColor: styles.localFill,
                borderColor: styles.localStroke,
                borderWidth: 1,
                rotate: toDeg(yaw),
              };
            },
          });
        },
      }) as unknown as SolidJSX.Element,
    ],
  });
}
