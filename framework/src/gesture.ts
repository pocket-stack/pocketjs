// Gesture recognition over the per-frame touch snapshot (touch.ts).
//
// touches() is a stateless snapshot; this module turns it into contact
// LIFECYCLES — down / move / up / cancel edges with per-contact history and
// release velocity — and runs registered recognizers over them: tap,
// long-press, and axis-lockable pan (whose end velocity feeds flings).
//
// Ownership model (the UIKit shape, sized for a handheld):
//   - On a down edge each recognizer that matches the contact's region
//     becomes an OWNER; owners observe down/move/up concurrently.
//   - Priority is registration order, last-registered first (the same
//     convention as the focus controller stack) — deterministic because
//     mount order is deterministic.
//   - Discrete gestures single-fire on the highest-priority owner: the first
//     owner whose pan crosses slop CLAIMS the contact and every other owner
//     is cancelled (a list pan cancels the row's press-highlight); tap and
//     long-press resolve to the first owner carrying that handler.
//   - Region hit-testing uses the ink-claiming hitTest op when present; a
//     `rect` is the geometry fallback for hosts without op 27 AND the
//     complement for ink misses inside the region (gaps between rows still
//     pan the list). A non-null hit OUTSIDE the subtree never rect-matches —
//     ink above the region occludes it.
//
// The gesture layer never touches focus itself. Components translate
// gestures into focus/press explicitly via setActiveNode()/pressNode()
// (input.ts), so d-pad, cursor, and touch share one authority over the
// `focus:`/`active:` native variants and a pressed look can never strand.
//
// Determinism: the pump runs once per frame from index.ts — after effect
// delivery, before app frame hooks — so app code always observes this
// frame's completed gesture output. Velocity is an integer position delta
// over k fixed-dt frames (one IEEE division; bit-identical everywhere).
// Long-press deadlines are virtual-frame counts derived from simulationHz().
// On hosts without touch (PSP) touches() is always empty and the pump costs
// two comparisons; recognizers stay inert.
//
// Steady state allocates nothing: contact tracks are a fixed pool of 8
// (the wire cap), position history lives in preallocated Int16Array rings,
// and per-owner recognition state is a flag byte per pool slot.

import { onCleanup } from "solid-js";
import { simulationHz, virtualFrame } from "./clock.ts";
import { hitNode } from "./input.ts";
import type { NodeMirror } from "./renderer.ts";
import { touches } from "./touch.ts";

export type GesturePhase = "down" | "move" | "up" | "cancel";

/** A live view of one contact, valid during the frame it is delivered. */
export interface GestureContact {
  /** Stable while the contact is down; ids may be reused after release. */
  readonly id: number;
  /** Current position, logical viewport px. */
  readonly x: number;
  readonly y: number;
  /** Position at the down edge. */
  readonly startX: number;
  readonly startY: number;
  /** Total travel since down. */
  readonly dx: number;
  readonly dy: number;
  /** Travel THIS frame (what a finger-follow drag consumes). */
  readonly fdx: number;
  readonly fdy: number;
  /** Velocity in logical px per VIRTUAL second (release velocity on up). */
  readonly vx: number;
  readonly vy: number;
  /** virtualFrame() at the down edge. */
  readonly downFrame: number;
  /** Frames since down (0 on the down frame). */
  readonly frames: number;
}

export interface GestureRegion {
  /** Own contacts whose ink-claiming hit chain lands inside this node's
   *  subtree (spec op 27). */
  node?: () => NodeMirror | null | undefined;
  /** Geometry fallback: used when the host lacks hitTest, and as the
   *  complement when the hit misses (nothing painted under the finger)
   *  inside the region. Logical px. */
  rect?: () => { x: number; y: number; w: number; h: number } | null | undefined;
}

export interface GestureOptions {
  /** Omit for a whole-screen recognizer (lowest specificity, not lowest
   *  priority — priority is registration order). */
  region?: GestureRegion;
  /** Pan axis lock. "y"/"x" reject cross-axis movement (the contact's tap
   *  may still die, but this recognizer never pans it). Default "any". */
  axis?: "x" | "y" | "any";
  /** Max total travel (per axis) for the contact to still count as a tap. */
  tapSlop?: number;
  /** Travel that starts a pan (and claims the contact). */
  panSlop?: number;
  /** Hold duration for onLongPress, in VIRTUAL seconds. */
  longPressSeconds?: number;
  /** Survive pushTouchBlock (the OSK's own recognizer sets this). */
  allowWhenBlocked?: boolean;
  onDown?(c: GestureContact): void;
  onMove?(c: GestureContact): void;
  onUp?(c: GestureContact): void;
  onCancel?(c: GestureContact): void;
  /** Up within tapSlop, nothing claimed, no long-press fired. Single-fires
   *  on the highest-priority owner with a handler. */
  onTap?(c: GestureContact): void;
  /** Held longPressSeconds within tapSlop. Fires once, then claims. */
  onLongPress?(c: GestureContact): void;
  /** Slop exceeded on the (locked) axis — claims the contact. */
  onPanStart?(c: GestureContact): void;
  /** Every frame while panning (fdx/fdy may be 0 on hold frames). */
  onPanMove?(c: GestureContact): void;
  /** Release while panning; c.vx/vy is the fling velocity. */
  onPanEnd?(c: GestureContact): void;
}

export interface GestureHandle {
  dispose(): void;
  /** Force-cancel this recognizer's in-flight contacts (fires onCancel). */
  cancel(): void;
  /** True while any contact is mid-pan under this recognizer. */
  readonly panning: boolean;
}

const MAX_TRACKS = 8; // the touch wire cap (touch.ts)
const HIST = 8; // position history ring length
const VELOCITY_WINDOW = 3; // frames spanned by the velocity estimate
const DEFAULT_TAP_SLOP = 8;
const DEFAULT_PAN_SLOP = 6;
const DEFAULT_LONG_PRESS_S = 0.5;

// Per-(recognizer, pool slot) recognition state flags.
const OBSERVING = 1;
const TAP_DEAD = 2;
const LONGPRESS_FIRED = 4;
const PANNING = 8;
const PAN_DEAD = 16;

interface Recognizer {
  opts: GestureOptions;
  disposed: boolean;
  /** One flag byte per contact pool slot. */
  flags: Uint8Array;
}

interface Track extends GestureContact {
  slot: number;
  used: boolean;
  /** Seen in the current frame's snapshot (mark/sweep). */
  present: boolean;
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  fdx: number;
  fdy: number;
  vx: number;
  vy: number;
  downFrame: number;
  frames: number;
  histX: Int16Array;
  histY: Int16Array;
  histHead: number;
  histLen: number;
  owners: Recognizer[];
  claimedBy: Recognizer | null;
}

const recognizers: Recognizer[] = [];
let blockDepth = 0;
let liveCount = 0;

const tracks: Track[] = Array.from({ length: MAX_TRACKS }, (_, slot) => ({
  slot,
  used: false,
  present: false,
  id: 0,
  x: 0,
  y: 0,
  startX: 0,
  startY: 0,
  dx: 0,
  dy: 0,
  fdx: 0,
  fdy: 0,
  vx: 0,
  vy: 0,
  downFrame: 0,
  frames: 0,
  histX: new Int16Array(HIST),
  histY: new Int16Array(HIST),
  histHead: 0,
  histLen: 0,
  owners: [],
  claimedBy: null,
}));

function withinSubtree(node: NodeMirror, ancestor: NodeMirror): boolean {
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

/** Region match for a down at (x, y). `hit` is the memoized ink hit for this
 *  down: undefined = not yet computed, null = computed and missed/no op. */
function regionMatches(
  rec: Recognizer,
  x: number,
  y: number,
  hitBox: { hit: NodeMirror | null | undefined },
): boolean {
  const region = rec.opts.region;
  if (!region) return true;
  const target = region.node?.();
  if (target) {
    if (hitBox.hit === undefined) hitBox.hit = hitNode(x, y);
    const hit = hitBox.hit;
    if (hit) return withinSubtree(hit, target);
    // Ink miss (or no hitTest op): the rect decides, when provided. A hit on
    // ink OUTSIDE the subtree already returned above — occluders win.
  }
  const r = region.rect?.();
  if (!r) return false;
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function fireCancel(rec: Recognizer, t: Track): void {
  rec.flags[t.slot] = 0;
  if (t.claimedBy === rec) t.claimedBy = null;
  rec.opts.onCancel?.(t);
}

/** The winner keeps the contact; every other observing owner is cancelled. */
function claim(t: Track, winner: Recognizer): void {
  t.claimedBy = winner;
  for (const o of t.owners) {
    if (o !== winner && o.flags[t.slot] & OBSERVING) fireCancel(o, t);
  }
}

function releaseTrack(t: Track): void {
  for (const o of t.owners) o.flags[t.slot] = 0;
  t.owners.length = 0;
  t.claimedBy = null;
  t.used = false;
  liveCount--;
}

function beginTrack(t: Track, id: number, x: number, y: number): void {
  t.used = true;
  t.present = true;
  t.id = id;
  t.x = x;
  t.y = y;
  t.startX = x;
  t.startY = y;
  t.dx = 0;
  t.dy = 0;
  t.fdx = 0;
  t.fdy = 0;
  t.vx = 0;
  t.vy = 0;
  t.downFrame = virtualFrame();
  t.frames = 0;
  t.histX[0] = x;
  t.histY[0] = y;
  t.histHead = 1;
  t.histLen = 1;
  t.owners.length = 0;
  t.claimedBy = null;
  liveCount++;

  // Resolve owners in priority order (last-registered first); the ink hit is
  // computed at most once per down, shared across recognizers.
  const hitBox: { hit: NodeMirror | null | undefined } = { hit: undefined };
  for (let i = recognizers.length - 1; i >= 0; i--) {
    const rec = recognizers[i];
    if (rec.disposed) continue;
    if (blockDepth > 0 && !rec.opts.allowWhenBlocked) continue;
    if (!regionMatches(rec, x, y, hitBox)) continue;
    rec.flags[t.slot] = OBSERVING;
    t.owners.push(rec);
  }
  for (const o of t.owners) o.opts.onDown?.(t);
}

function updateTrack(t: Track, x: number, y: number): void {
  t.present = true;
  t.fdx = x - t.x;
  t.fdy = y - t.y;
  t.x = x;
  t.y = y;
  t.dx = x - t.startX;
  t.dy = y - t.startY;
  t.frames++;
  t.histX[t.histHead] = x;
  t.histY[t.histHead] = y;
  t.histHead = (t.histHead + 1) % HIST;
  if (t.histLen < HIST) t.histLen++;
  const k = Math.min(VELOCITY_WINDOW, t.histLen - 1);
  if (k <= 0) {
    t.vx = 0;
    t.vy = 0;
    return;
  }
  // Integer px over k frames of 1/hz virtual seconds each — px per virtual
  // second with a single exactly-specified IEEE division per axis.
  const hz = simulationHz();
  const last = (t.histHead - 1 + HIST) % HIST;
  const prev = (last - k + HIST) % HIST;
  t.vx = ((t.histX[last] - t.histX[prev]) * hz) / k;
  t.vy = ((t.histY[last] - t.histY[prev]) * hz) / k;
}

function recognize(t: Track): void {
  const moved = t.fdx !== 0 || t.fdy !== 0;
  const adx = t.dx < 0 ? -t.dx : t.dx;
  const ady = t.dy < 0 ? -t.dy : t.dy;

  for (const rec of t.owners) {
    const f = rec.flags[t.slot];
    if (!(f & OBSERVING)) continue;
    if (moved) rec.opts.onMove?.(t);
    // Tap death is per-owner: each recognizer has its own slop.
    const slop = rec.opts.tapSlop ?? DEFAULT_TAP_SLOP;
    if (!(f & TAP_DEAD) && (adx > slop || ady > slop)) {
      rec.flags[t.slot] |= TAP_DEAD;
    }
  }

  // Long-press: first (highest-priority) owner still tap-alive past its
  // deadline fires once, then claims.
  if (!t.claimedBy) {
    for (const rec of t.owners) {
      const f = rec.flags[t.slot];
      if (!(f & OBSERVING) || f & (TAP_DEAD | LONGPRESS_FIRED)) continue;
      if (!rec.opts.onLongPress) continue;
      const deadline = Math.max(
        1,
        Math.round((rec.opts.longPressSeconds ?? DEFAULT_LONG_PRESS_S) * simulationHz()),
      );
      if (t.frames < deadline) continue;
      rec.flags[t.slot] |= LONGPRESS_FIRED;
      rec.opts.onLongPress(t);
      claim(t, rec);
      break;
    }
  }

  // Pan start: first owner whose (locked) axis crosses slop claims.
  if (!t.claimedBy) {
    for (const rec of t.owners) {
      const f = rec.flags[t.slot];
      if (!(f & OBSERVING) || f & (PANNING | PAN_DEAD)) continue;
      if (!rec.opts.onPanStart && !rec.opts.onPanMove && !rec.opts.onPanEnd) continue;
      const slop = rec.opts.panSlop ?? DEFAULT_PAN_SLOP;
      if (adx <= slop && ady <= slop) continue;
      const axis = rec.opts.axis ?? "any";
      if (axis === "y" ? ady < adx : axis === "x" ? adx < ady : false) {
        // Dominant axis is the wrong one — this recognizer never pans this
        // contact (a horizontal swipe over a vertical list stays a swipe).
        rec.flags[t.slot] |= PAN_DEAD;
        continue;
      }
      rec.flags[t.slot] |= PANNING | TAP_DEAD;
      rec.opts.onPanStart?.(t);
      claim(t, rec);
      break;
    }
  }

  for (const rec of t.owners) {
    if ((rec.flags[t.slot] & (OBSERVING | PANNING)) === (OBSERVING | PANNING)) {
      rec.opts.onPanMove?.(t);
    }
  }
}

function finishTrack(t: Track): void {
  for (const rec of t.owners) {
    const f = rec.flags[t.slot];
    if (!(f & OBSERVING)) continue;
    rec.opts.onUp?.(t);
    if (f & PANNING) rec.opts.onPanEnd?.(t);
  }
  // Tap single-fires on the highest-priority owner still qualifying.
  if (!t.claimedBy) {
    for (const rec of t.owners) {
      const f = rec.flags[t.slot];
      if (!(f & OBSERVING) || f & (TAP_DEAD | LONGPRESS_FIRED | PANNING)) continue;
      if (!rec.opts.onTap) continue;
      rec.opts.onTap(t);
      break;
    }
  }
  releaseTrack(t);
}

/** One gesture frame. Called from the frame pump (index.ts) after
 *  __setTouches/__drainEffects and before app frame hooks. */
export function __runGestures(): void {
  const snap = touches();
  if (snap.length === 0 && liveCount === 0) return;

  for (const t of tracks) t.present = false;

  for (const c of snap) {
    let found: Track | null = null;
    for (const t of tracks) {
      if (t.used && t.id === c.id) {
        found = t;
        break;
      }
    }
    if (found) {
      updateTrack(found, c.x, c.y);
      continue;
    }
    let free: Track | null = null;
    for (const t of tracks) {
      if (!t.used) {
        free = t;
        break;
      }
    }
    if (free) beginTrack(free, c.id, c.x, c.y);
  }

  // Up edges first (a released contact must not be re-recognized), then the
  // per-frame recognition pass over surviving contacts.
  for (const t of tracks) {
    if (t.used && !t.present) finishTrack(t);
  }
  for (const t of tracks) {
    if (t.used && t.present) recognize(t);
  }
}

function cancelContactsFor(rec: Recognizer): void {
  for (const t of tracks) {
    if (t.used && rec.flags[t.slot] & OBSERVING) fireCancel(rec, t);
  }
}

/**
 * Register a recognizer. Framework-neutral: the caller owns disposal. Most
 * component code wants createGesture() below, which scopes disposal to the
 * owner's onCleanup.
 */
export function attachGesture(opts: GestureOptions): GestureHandle {
  const rec: Recognizer = { opts, disposed: false, flags: new Uint8Array(MAX_TRACKS) };
  recognizers.push(rec);
  return {
    dispose(): void {
      if (rec.disposed) return;
      cancelContactsFor(rec);
      rec.disposed = true;
      const i = recognizers.lastIndexOf(rec);
      if (i >= 0) recognizers.splice(i, 1);
    },
    cancel(): void {
      if (!rec.disposed) cancelContactsFor(rec);
    },
    get panning(): boolean {
      for (const t of tracks) {
        if (t.used && rec.flags[t.slot] & PANNING) return true;
      }
      return false;
    },
  };
}

/** attachGesture + onCleanup(dispose) for Solid component scopes. */
export function createGesture(opts: GestureOptions): GestureHandle {
  const handle = attachGesture(opts);
  onCleanup(() => handle.dispose());
  return handle;
}

/**
 * Modal touch mute — the touch mirror of pushButtonHandlerBlock (frame.ts).
 * Pushing SYNCHRONOUSLY cancels the in-flight contacts of every non-exempt
 * recognizer (the list under an opening OSK sees onCancel this frame, not a
 * phantom release later) and suppresses new downs for them while held.
 * Recognizers with allowWhenBlocked keep working. Returns a disposer.
 */
export function pushTouchBlock(): () => void {
  blockDepth++;
  for (const rec of recognizers) {
    if (!rec.opts.allowWhenBlocked) cancelContactsFor(rec);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    blockDepth = Math.max(0, blockDepth - 1);
  };
}

/** Fresh gesture state for a fresh mount (index.ts render()/dispose). */
export function resetGestures(): void {
  recognizers.length = 0;
  blockDepth = 0;
  liveCount = 0;
  for (const t of tracks) {
    t.used = false;
    t.present = false;
    t.owners.length = 0;
    t.claimedBy = null;
  }
}
