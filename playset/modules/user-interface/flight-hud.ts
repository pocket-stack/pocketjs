// playset/modules/user-interface/flight-hud.ts — fighter-cockpit HUD overlay:
// compass heading + cardinal, pitch tape (7 px/degree, roll-rotated), SPD/THR/
// AOA-ROLL and ALT/AGL/WPN data boxes, status row, PULL UP warning.
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/FlightHud.js. The state→presentation
// mapping (renderDashboard field names, cardinal buckets, heat %, pitch-tape
// geometry 620×880 @ 7 px/deg, line widths 210/330) is verbatim and exposed
// as computeFlightHudReadouts(). Deviations, all forced by the DOM→PocketJS
// move: the injected-CSS animations, dashed negative pitch lines,
// waterline/boresight/roll-scale pseudo-element art and vw/vh responsive
// sizing are dropped; box paddings/margins and the status-row placement are
// compacted so the whole cockpit fits a 480×272 screen (the original's vw/vh
// values assumed a browser canvas); rgba() colors are converted to #rrggbbaa;
// `pullUpWarning: null` (original: "keep previous") renders as hidden — a
// reactive tree has no imperative latch. The component accepts either a
// props-accessor or a UiStateModel (via createUiSignal).
//
// Every Text carries a font class (text-xs/text-sm) — on native hosts a text
// node without a compiled style gets no baked font atlas slot and renders
// nothing, so class-less Text is a blank HUD outside the mirror-tree tests.

import type { JSX as SolidJSX } from "solid-js";
import { Show, createMemo } from "solid-js";
import { Text, View, type ViewProps } from "@pocketjs/framework/components";
import { clamp, toFinite } from "../math/scalar-utils.ts";
import { HudBar } from "./hud-binder.ts";
import { UiStateModel, createUiSignal } from "./ui-state-model.ts";

type StyleObject = NonNullable<ViewProps["style"]>;

// spec/spec.ts ENUMS ordinals (stable wire values; playset avoids a spec dep).
const POS_ABSOLUTE = 1;
const OVERFLOW_HIDDEN = 1;
const FLEX_ROW = 0;
const FLEX_COL = 1;
const ALIGN_CENTER = 1;
const JUSTIFY_BETWEEN = 3;
const DISPLAY_FLEX = 0;
const DISPLAY_NONE = 1;

// Palette — original CSS rgba() values converted to #rrggbbaa.
const HUD_GREEN = "#7dffb7";
const HUD_BRIGHT = "#d8ffe8";
const LABEL_COLOR = "#b7ffd9b8"; // rgba(183,255,217,0.72)
const STATUS_COLOR = "#d8ffe8db"; // rgba(216,255,232,0.86)
const BOX_BG = "#00120a38"; // rgba(0,18,10,0.22)
const BOX_BORDER = "#7dffb752"; // rgba(125,255,183,0.32)
const PITCH_LINE = "#7dffb7b8"; // rgba(125,255,183,0.72)
const PITCH_LINE_ZERO = "#7dffb7eb"; // rgba(125,255,183,0.92)
const PITCH_LABEL = "#b5ffd7db"; // rgba(181,255,215,0.86)
const RETICLE = "#7dffb7e6"; // rgba(125,255,183,0.9)
const WARNING_TEXT = "#ffecec";
const WARNING_BG = "#9d0a0ac7"; // rgba(157,10,10,0.78)
const WARNING_BORDER = "#ff9b9bad"; // rgba(255,155,155,0.68)

// Pitch-tape geometry, verbatim from the original markup/CSS.
const PITCH_TAPE_W = 620;
const PITCH_TAPE_H = 880;
const PITCH_CENTER_TOP = 440;
const PITCH_PX_PER_DEGREE = 7;

export function padNumber(value: number, width: number): string {
  return String(Math.abs(Math.round(Number(value) || 0))).padStart(width, "0");
}

export function normalizeCompassHeadingDegrees(compassHeadingDegrees = 0): number {
  const numericCompassHeading = Number(compassHeadingDegrees);
  if (!Number.isFinite(numericCompassHeading)) return 0;
  return ((numericCompassHeading % 360) + 360) % 360;
}

export function cardinalForCompassHeadingDegrees(compassHeadingDegrees = 0): string {
  const wrapped = normalizeCompassHeadingDegrees(compassHeadingDegrees);
  if (wrapped >= 337.5 || wrapped < 22.5) return "N";
  if (wrapped < 67.5) return "NE";
  if (wrapped < 112.5) return "E";
  if (wrapped < 157.5) return "SE";
  if (wrapped < 202.5) return "S";
  if (wrapped < 247.5) return "SW";
  if (wrapped < 292.5) return "W";
  return "NW";
}

/** renderDashboard's input fields — names verbatim from the original. */
export type FlightHudState = {
  regionName: string;
  speed: number;
  altitude: number;
  agl: number;
  waveLabel: string;
  waveDetail: string;
  compassHeadingDegrees: number;
  compassHeadingText: string;
  timeText: string;
  scoreText: string;
  throttle: number;
  pitchDegrees: number;
  rollDegrees: number;
  weaponLabel: string;
  lockStatus: string;
  gunHeat: number;
  pullUpWarning: boolean | null;
};

/** Derived readouts — keys match the original's data-hud element names. */
export type FlightHudReadouts = {
  compassHeading: string;
  cardinal: string;
  speed: string;
  altitude: string;
  agl: string;
  throttle: string;
  attitude: string;
  weapon: string;
  region: string;
  wave: string;
  lock: string;
  score: string;
  time: string;
  throttleRatio: number;
  translatePitch: number;
  safeRoll: number;
  pullUpWarning: boolean;
};

// HUD presentation angles are degrees; simulation angles stay radians.
export function computeFlightHudReadouts({
  regionName = "Hold Pattern",
  speed = 0,
  altitude = 0,
  agl = 0,
  waveLabel = "FREE",
  waveDetail = "",
  compassHeadingDegrees = 0,
  compassHeadingText = "",
  timeText = "",
  scoreText = "",
  throttle = 0,
  pitchDegrees = 0,
  rollDegrees = 0,
  weaponLabel = "--",
  lockStatus = "NONE",
  gunHeat = 0,
  pullUpWarning = null,
}: Partial<FlightHudState> = {}): FlightHudReadouts {
  const safeCompassHeadingDegrees = normalizeCompassHeadingDegrees(
    Number.isFinite(compassHeadingDegrees)
      ? compassHeadingDegrees
      : Number.parseFloat(compassHeadingText),
  );
  const safePitch = ((toFinite(pitchDegrees, 0) % 360) + 360) % 360;
  const safeRoll = toFinite(rollDegrees, 0);
  const throttleRatio = clamp(toFinite(throttle, 0), 0, 1);
  const heatPercent = Math.round(clamp(toFinite(gunHeat, 0), 0, 1) * 100);

  const translatePitch = safePitch < 180 ? safePitch : safePitch - 360;

  return {
    compassHeading: padNumber(safeCompassHeadingDegrees, 3),
    cardinal: cardinalForCompassHeadingDegrees(safeCompassHeadingDegrees),
    speed: padNumber(speed, 3),
    altitude: padNumber(altitude, 4),
    agl: padNumber(agl, 3),
    throttle: `${Math.round(throttleRatio * 100).toString().padStart(3, "0")}%`,
    attitude: `${safePitch >= 0 ? "+" : ""}${safePitch.toFixed(1)} / ${safeRoll >= 0 ? "+" : ""}${safeRoll.toFixed(1)}`,
    weapon: weaponLabel,
    region: regionName,
    wave: waveDetail ? `${waveLabel} ${waveDetail}` : waveLabel,
    lock: `LOCK ${lockStatus}  HEAT ${heatPercent}%`,
    score: scoreText,
    time: timeText,
    throttleRatio,
    translatePitch,
    safeRoll,
    pullUpWarning: Boolean(pullUpWarning),
  };
}

export type FlightHudSource =
  | (() => Partial<FlightHudState>)
  | UiStateModel<Partial<FlightHudState>>;

export interface FlightHudProps {
  /** Accessor of dashboard state, or a UiStateModel bridged via createUiSignal. */
  state: FlightHudSource;
  /** setShowHorizonLines equivalent — hides the pitch tape (default true). */
  showHorizonLines?: boolean | (() => boolean);
  width?: number;
  height?: number;
}

function resolveStateAccessor(source: FlightHudSource): () => Partial<FlightHudState> {
  if (typeof source === "function") return source;
  return createUiSignal(source);
}

function pitchLine(degrees: number): SolidJSX.Element {
  const zero = degrees === 0;
  const lineWidth = zero ? 330 : 210;
  const labelText = String(Math.abs(degrees));
  const label = (side: "left" | "right"): SolidJSX.Element =>
    Text({
      class: "text-xs",
      style: {
        posType: POS_ABSOLUTE,
        insetT: -9,
        ...(side === "left" ? { insetL: -48 } : { insetR: -48 }),
        textColor: PITCH_LABEL,
      },
      children: labelText,
    });
  return View({
    style: {
      posType: POS_ABSOLUTE,
      insetL: (PITCH_TAPE_W - lineWidth) / 2,
      insetT: PITCH_CENTER_TOP - degrees * PITCH_PX_PER_DEGREE,
      width: lineWidth,
      height: zero ? 2 : 1,
      bgColor: zero ? PITCH_LINE_ZERO : PITCH_LINE,
    },
    children: [label("left"), label("right")],
  });
}

function dataBox(label: string, value: () => string, meter?: SolidJSX.Element): SolidJSX.Element {
  return View({
    style: {
      width: 136,
      flexDir: FLEX_COL,
      paddingT: 5,
      paddingR: 10,
      paddingB: 5,
      paddingL: 10,
      marginB: 9,
      bgColor: BOX_BG,
      borderColor: BOX_BORDER,
      borderWidth: 1,
    },
    children: [
      Text({ class: "text-xs", style: { textColor: LABEL_COLOR }, children: label }),
      Text({
        class: "text-sm",
        style: { marginT: 2, textColor: HUD_BRIGHT },
        children: value as unknown as SolidJSX.Element,
      }),
      meter ?? null,
    ],
  });
}

export function FlightHud(props: FlightHudProps): SolidJSX.Element {
  const state = resolveStateAccessor(props.state);
  const view = createMemo(() => computeFlightHudReadouts(state()));
  const width = props.width ?? 480;
  const height = props.height ?? 272;
  const showHorizon = (): boolean => {
    const s = props.showHorizonLines;
    return typeof s === "function" ? s() : (s ?? true);
  };

  const horizonW = Math.round(width * 0.72);
  const horizonH = Math.round(height * 0.58);

  const pitchLines: SolidJSX.Element[] = [];
  for (let degrees = -60; degrees <= 60; degrees += 10) {
    pitchLines.push(pitchLine(degrees));
  }

  const centeredColumn = (top: number, children: SolidJSX.Element): SolidJSX.Element =>
    View({
      style: {
        posType: POS_ABSOLUTE,
        insetT: top,
        insetL: 0,
        width,
        flexDir: FLEX_COL,
        align: ALIGN_CENTER,
      },
      children,
    });

  return View({
    debugName: "FlightHud",
    style: { width, height, overflow: OVERFLOW_HIDDEN },
    children: [
      // -- compass heading -------------------------------------------------
      centeredColumn(18, [
        Text({ class: "text-xs", style: { textColor: LABEL_COLOR }, children: "HDG" }),
        Text({
          debugName: "hud:compassHeading",
          class: "text-sm font-bold",
          style: { textColor: HUD_BRIGHT },
          children: (() => view().compassHeading) as unknown as SolidJSX.Element,
        }),
        Text({
          debugName: "hud:cardinal",
          class: "text-xs",
          style: { textColor: LABEL_COLOR },
          children: (() => view().cardinal) as unknown as SolidJSX.Element,
        }),
      ] as unknown as SolidJSX.Element),

      // -- horizon window: pitch tape + reticle ------------------------------
      View({
        style: {
          posType: POS_ABSOLUTE,
          insetL: (width - horizonW) / 2,
          insetT: (height - horizonH) / 2,
          width: horizonW,
          height: horizonH,
          overflow: OVERFLOW_HIDDEN,
        },
        children: [
          View({
            debugName: "hud:pitchTape",
            get style(): StyleObject {
              const v = view();
              return {
                posType: POS_ABSOLUTE,
                insetL: (horizonW - PITCH_TAPE_W) / 2,
                insetT: (horizonH - PITCH_TAPE_H) / 2,
                width: PITCH_TAPE_W,
                height: PITCH_TAPE_H,
                rotate: -v.safeRoll,
                translateY: v.translatePitch * PITCH_PX_PER_DEGREE,
                display: showHorizon() ? DISPLAY_FLEX : DISPLAY_NONE,
              };
            },
            children: pitchLines as unknown as SolidJSX.Element,
          }),
          View({
            // reticle ring + center dot
            style: {
              posType: POS_ABSOLUTE,
              insetL: horizonW / 2 - 74,
              insetT: horizonH / 2 - 74,
              width: 148,
              height: 148,
              radius: 74,
              borderColor: RETICLE,
              borderWidth: 2,
            },
          }),
          View({
            style: {
              posType: POS_ABSOLUTE,
              insetL: horizonW / 2 - 3.5,
              insetT: horizonH / 2 - 3.5,
              width: 7,
              height: 7,
              radius: 3.5,
              bgColor: RETICLE,
            },
          }),
        ],
      }),

      // -- data columns ------------------------------------------------------
      View({
        style: {
          posType: POS_ABSOLUTE,
          insetL: Math.round(width * 0.07),
          insetT: Math.round(height * 0.16),
          flexDir: FLEX_COL,
        },
        children: [
          dataBox("SPD", () => view().speed),
          dataBox(
            "THR",
            () => view().throttle,
            View({
              style: { marginT: 6 },
              children: HudBar({ ratio: () => view().throttleRatio, width: 116, height: 6 }),
            }),
          ),
          dataBox("AOA / ROLL", () => view().attitude),
        ],
      }),
      View({
        style: {
          posType: POS_ABSOLUTE,
          insetR: Math.round(width * 0.07),
          insetT: Math.round(height * 0.16),
          flexDir: FLEX_COL,
        },
        children: [
          dataBox("ALT", () => view().altitude),
          dataBox("AGL", () => view().agl),
          dataBox("WPN", () => view().weapon),
        ],
      }),

      // -- status row --------------------------------------------------------
      View({
        style: {
          posType: POS_ABSOLUTE,
          insetB: 10,
          insetL: Math.round(width * 0.07),
          width: Math.round(width * 0.78),
          flexDir: FLEX_ROW,
          justify: JUSTIFY_BETWEEN,
          gap: 8,
        },
        children: (["region", "wave", "lock", "score", "time"] as const).map((key) =>
          Text({
            debugName: `hud:${key}`,
            class: "text-xs",
            style: { textColor: STATUS_COLOR },
            children: (() => view()[key]) as unknown as SolidJSX.Element,
          }),
        ) as unknown as SolidJSX.Element,
      }),

      // -- PULL UP warning ----------------------------------------------------
      Show({
        get when() {
          return view().pullUpWarning;
        },
        get children() {
          return centeredColumn(
            Math.round(height * 0.28),
            Text({
              debugName: "hud:warning",
              class: "text-sm font-bold",
              style: {
                paddingT: 9,
                paddingR: 18,
                paddingB: 9,
                paddingL: 18,
                textColor: WARNING_TEXT,
                bgColor: WARNING_BG,
                borderColor: WARNING_BORDER,
                borderWidth: 1,
              },
              children: "PULL UP",
            }),
          );
        },
      }) as unknown as SolidJSX.Element,
    ],
  });
}
