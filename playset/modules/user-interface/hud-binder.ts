// playset/modules/user-interface/hud-binder.ts — tiny reactive HUD bindings:
// HudValue (a Text bound to an accessor) and HudBar (a fill View whose width
// tracks a 0..1 accessor).
//
// Ported from GameBlocks (github.com/xt4d/GameBlocks, MIT © 2026 Weihao
// Cheng) — modules/user-interface/DomHudRenderer.js. The original walked DOM
// selectors and re-rendered on UiStateModel changedKeys; under PocketJS Solid
// reactivity IS the binder, so DomHudRenderer is superseded and deliberately
// NOT exported: bindText → HudValue, bindStyleWidth → HudBar (+ hudBarRatio,
// the original's current/max→0..1 math), bindClassToggle/bindAttribute →
// plain Solid expressions at the call site. DEFAULT_FORMATTER is verbatim.

import type { JSX as SolidJSX } from "solid-js";
import { Text, View, type ViewProps } from "@pocketjs/framework/components";
import { clamp01 } from "../math/scalar-utils.ts";

type StyleObject = NonNullable<ViewProps["style"]>;

export const DEFAULT_FORMATTER = (value: unknown): string => String(value ?? "");

/** bindStyleWidth's ratio rule, verbatim: non-positive max ⇒ 0. */
export function hudBarRatio(current: number, max: number): number {
  const safeCurrent = Number(current ?? 0);
  const safeMax = Number(max ?? 1);
  return safeMax <= 0 ? 0 : clamp01(safeCurrent / safeMax);
}

export interface HudValueProps {
  /** Reactive source — a Solid accessor (or createUiSignal(...) selector). */
  value: () => unknown;
  format?: (value: unknown) => string;
  class?: string;
  style?: StyleObject;
  debugName?: string;
}

export function HudValue(props: HudValueProps): SolidJSX.Element {
  return Text({
    class: props.class,
    style: props.style,
    debugName: props.debugName ?? "HudValue",
    children: (() =>
      (props.format ?? DEFAULT_FORMATTER)(props.value())) as unknown as SolidJSX.Element,
  });
}

const DEFAULT_TRACK_COLOR = "#7dffb729"; // rgba(125,255,183,0.16)
const DEFAULT_FILL_COLOR = "#7dffb7e6"; // rgba(125,255,183,0.9)

export interface HudBarProps {
  /** Fill fraction accessor; clamped to 0..1 (pair with hudBarRatio). */
  ratio: () => number;
  /** Track width in px — PocketJS has no percent widths beyond w-full. */
  width: number;
  height?: number;
  trackColor?: string;
  fillColor?: string;
  class?: string;
  style?: StyleObject;
  debugName?: string;
}

export function HudBar(props: HudBarProps): SolidJSX.Element {
  const height = props.height ?? 6;
  return View({
    class: props.class,
    debugName: props.debugName ?? "HudBar",
    style: {
      width: props.width,
      height,
      bgColor: props.trackColor ?? DEFAULT_TRACK_COLOR,
      ...(props.style ?? {}),
    },
    children: View({
      get style(): StyleObject {
        return {
          width: Math.round(clamp01(props.ratio()) * props.width),
          height,
          bgColor: props.fillColor ?? DEFAULT_FILL_COLOR,
        };
      },
    }),
  });
}
