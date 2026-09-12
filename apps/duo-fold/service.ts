import { getOps } from "@pocketjs/framework/host";

export interface FoldState {
  t: "fold.state";
  source: boolean;
  available: boolean;
  active: boolean;
  manual: boolean;
  degrees: number;
  samples: number;
  calibrations: number;
}
export type FoldCommand = { op: "calibrate" | "motion" } | { op: "manual"; degrees: number };

export function parseFoldState(line: string): FoldState | null {
  try {
    const value = JSON.parse(line);
    if (value?.t !== "fold.state" ||
      ![value.source, value.available, value.active, value.manual].every(v => typeof v === "boolean") ||
      !Number.isFinite(value.degrees) || Math.abs(value.degrees) > 85.01 ||
      !Number.isSafeInteger(value.samples) || value.samples < 0 ||
      !Number.isSafeInteger(value.calibrations) || value.calibrations < 0) return null;
    return value;
  } catch { return null; }
}

/** Local HostOps service: native image/motion ownership, guest controls. */
export function connectFold() {
  const ops = getOps();
  if (!ops.svcOpen?.("duo-fold")) return null;
  return {
    poll(): FoldState | null {
      const lines = ops.svcPoll?.();
      if (!lines) return null;
      let state: FoldState | null = null;
      for (const line of lines.split("\n")) state = parseFoldState(line) ?? state;
      return state;
    },
    send(command: FoldCommand) { ops.svcSend?.(JSON.stringify(command)); },
  };
}
