/** Replayable composition. Candidate selections are page-relative Rime keys.
 * The guest owns the transcript; the provider owns dictionaries and conversion. */
export const IME = Object.freeze({ keys: 128, candidates: 5, select: 0x1000000,
  backspace: 0xff08, enter: 0xff0d, left: 0xff51, right: 0xff53,
  pageUp: 0xff55, pageDown: 0xff56 });
export interface ImeSnapshot {
  preedit: string;
  commit: string;
  candidates: string[];
  page: number;
  last: boolean;
  caret: number;
}
export function validImeKeys(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= IME.keys && value.every(k =>
    Number.isInteger(k) && ((k >= 32 && k <= 126) ||
      [IME.backspace, IME.enter, IME.left, IME.right, IME.pageUp, IME.pageDown].includes(k) ||
      (k >= IME.select && k < IME.select + IME.candidates)));
}
