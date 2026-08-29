// Keyboard panel geometry, JSX-free so tests can compute key positions with
// the same numbers the renderer and hit-testing use (the osk-layout rule).

export const KB_PAD = 6;
export const KB_GAP = 4;
export const KB_ROW_H = 40;
export const KB_ROWS = 4;
export const KB_H = KB_ROWS * KB_ROW_H + (KB_ROWS - 1) * KB_GAP + 2 * KB_PAD; // 184
export const KB_W = 320;
