// apps/desk98/programs.ts — pure program geometry: content-local hit helpers
// and metrics for Notepad, Minesweeper, the folder view and the dialogs. The
// matching views live in the *.vue components; render geometry and hit
// geometry stay in one place by sharing these constants. Content coordinates
// are (cx, cy) from wm.ts hitRegion — origin at the frame's inner top-left,
// below caption (and menu bar if present).

import { getOps } from "@pocketjs/framework/host";
import { FONT } from "./theme.ts";
import { MINES_W } from "./mines.ts";

export function measure(s: string): number {
  const ops = getOps();
  return ops.measureText ? ops.measureText(s, FONT) : s.length * 7;
}

// ---------------------------------------------------------------------------
// Notepad
// ---------------------------------------------------------------------------

export const PAD_LINE_H = 16;
export const PAD_PAD = 3; // inset of the text from the white well

// ---------------------------------------------------------------------------
// Minesweeper — fixed-size window; all metrics in content-local px.
// ---------------------------------------------------------------------------

export const MINES_GEO = { w: 166, h: 227 } as const;
const M_PAD = 5; // content padding
const M_HEADER_H = 36;
const M_FIELD_TOP = M_PAD + M_HEADER_H + 6; // header + gap
const M_CELL = 16;
const M_CELLS_X = M_PAD + 3; // field bevel-w-[3] ring
const M_CELLS_Y = M_FIELD_TOP + 3;

export type MinesHit = { type: "cell"; i: number } | { type: "smiley" } | null;

export function minesHit(cx: number, cy: number): MinesHit {
  const sx = 160 / 2 - 13;
  if (cx >= sx && cx < sx + 26 && cy >= M_PAD + 5 && cy < M_PAD + 5 + 26) {
    return { type: "smiley" };
  }
  const x = Math.floor((cx - M_CELLS_X) / M_CELL);
  const y = Math.floor((cy - M_CELLS_Y) / M_CELL);
  if (x >= 0 && x < 9 && y >= 0 && y < 9) return { type: "cell", i: y * MINES_W + x };
  return null;
}

// ---------------------------------------------------------------------------
// Folder (Explorer details view)
// ---------------------------------------------------------------------------

export const FOLDER_HEADER_H = 17;
export const FOLDER_ROW_H = 17;
export const FOLDER_STATUS_H = 20;

/** Row index for a content-local click inside the list, -1 none. */
export function folderRowAt(cy: number, rowCount: number): number {
  const i = Math.floor((cy - 1 - FOLDER_HEADER_H) / FOLDER_ROW_H);
  return i >= 0 && i < rowCount ? i : -1;
}

// ---------------------------------------------------------------------------
// About + Shut Down dialogs
// ---------------------------------------------------------------------------

export const ABOUT_GEO = { w: 340, h: 216 } as const;
export const SHUTDOWN_GEO = { w: 300, h: 176 } as const;

/** Content-local button hits for the About dialog. */
export function aboutHit(contentW: number, contentH: number, cx: number, cy: number): "ok" | null {
  const x = contentW - 10 - 75;
  const y = contentH - 10 - 23;
  return cx >= x && cx < x + 75 && cy >= y && cy < y + 23 ? "ok" : null;
}

export type ShutdownHit = "ok" | "cancel" | "radio0" | "radio1" | null;

export function shutdownHit(
  contentW: number,
  contentH: number,
  cx: number,
  cy: number,
): ShutdownHit {
  const by = contentH - 10 - 23;
  const cancelX = contentW - 10 - 75;
  const okX = cancelX - 6 - 75;
  if (cy >= by && cy < by + 23) {
    if (cx >= okX && cx < okX + 75) return "ok";
    if (cx >= cancelX && cx < cancelX + 75) return "cancel";
  }
  for (const i of [0, 1]) {
    const ry = 46 + i * 20;
    if (cx >= 56 && cx < 220 && cy >= ry && cy < ry + 18) return i === 0 ? "radio0" : "radio1";
  }
  return null;
}
