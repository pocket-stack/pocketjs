export const CONTACT_ROW_HEIGHT = 30;
export const CONTACT_LIST_HEIGHT = 204;
export const CONTACT_CENTER_ANCHOR_Y =
  (CONTACT_LIST_HEIGHT - CONTACT_ROW_HEIGHT) / 2;
export const CONTACT_UP_ANCHOR_Y = 3 * CONTACT_ROW_HEIGHT;
export const CONTACT_DOWN_ANCHOR_Y =
  CONTACT_LIST_HEIGHT - 3 * CONTACT_ROW_HEIGHT;
export const CONTACT_SPRING_OVERSHOOT = 12;
export const CONTACT_SPRING_STIFFNESS = 480;
export const CONTACT_SPRING_DAMPING = 44;
export const CONTACT_MAX_OFFSCREEN_ROWS = 0.5;
export const CONTACT_MAX_OFFSCREEN_PX =
  CONTACT_ROW_HEIGHT * CONTACT_MAX_OFFSCREEN_ROWS;

export function wheelMultiplier(burst: number): number {
  const gear = Math.min(10, Math.floor(Math.max(0, burst) / 3));
  return 1 << gear;
}

/** Position an independent selection bar over its logical row while possible,
 * then clamp the bar itself so no more than maxOffscreenPx can be clipped at
 * either viewport edge. The real row remains free to travel far off-screen. */
export function contactSelectionY(
  selectedIndex: number,
  offset: number,
  maxOffscreenPx = CONTACT_MAX_OFFSCREEN_PX,
): number {
  const rowY = selectedIndex * CONTACT_ROW_HEIGHT - offset;
  return Math.max(
    -maxOffscreenPx,
    Math.min(
      CONTACT_LIST_HEIGHT - CONTACT_ROW_HEIGHT + maxOffscreenPx,
      rowY,
    ),
  );
}

/** Keep the real selected row within the same half-row clip bounds as the
 * independent selection bar. A remote wheel target may remain far ahead and
 * drive the sprint, but it cannot become the selected contact until the list
 * has visually caught up to it. */
export function contactVisibleIndex(
  targetIndex: number,
  offset: number,
  count: number,
  maxOffscreenPx = CONTACT_MAX_OFFSCREEN_PX,
): number {
  const first = Math.max(
    0,
    Math.ceil((offset - maxOffscreenPx) / CONTACT_ROW_HEIGHT),
  );
  const last = Math.min(
    count - 1,
    Math.floor(
      (offset + CONTACT_LIST_HEIGHT - CONTACT_ROW_HEIGHT + maxOffscreenPx) /
        CONTACT_ROW_HEIGHT,
    ),
  );
  return Math.max(first, Math.min(last, targetIndex));
}

/** Final list offset required to bring a selected row back into the resting
 * band. null means the row can move inside the band without moving the list. */
export function contactScrollTarget(
  selectedIndex: number,
  currentIntent: number,
  maxOffset: number,
): number | null {
  const rowTop = selectedIndex * CONTACT_ROW_HEIGHT;
  const lastRowTop = maxOffset + CONTACT_LIST_HEIGHT - CONTACT_ROW_HEIGHT;
  if (rowTop === 0) return currentIntent === 0 ? null : 0;
  if (rowTop >= lastRowTop) {
    return currentIntent === maxOffset ? null : maxOffset;
  }
  const screenY = rowTop - currentIntent;
  let target: number;
  if (screenY > CONTACT_DOWN_ANCHOR_Y) {
    target = rowTop - CONTACT_DOWN_ANCHOR_Y;
  } else if (screenY < CONTACT_UP_ANCHOR_Y) {
    target = rowTop - CONTACT_UP_ANCHOR_Y;
  } else {
    return null;
  }
  const clamped = Math.max(0, Math.min(maxOffset, target));
  return clamped === currentIntent ? null : clamped;
}
