// apps/ranger/sim/input.ts — M1 host-rate edge latch (hand-written).
//
// The host polls at 60Hz, SWF consumes at 24Hz. Edges are accumulated on
// every host tick (§3.4) so a press that rises and falls between advances
// is never lost. Plain OR-latching (latch |= buttons) cannot track
// release, so press-release-press would collapse into one press — the
// edge form below is the only implementation.
//
// Wiring: onFrame((buttons) => hostPoll(buttons)) every host tick;
// swfConsume() exactly ONCE at the head of an advancing SWF step (§3.3-3a).

/** Immutable per-step snapshot: edge presses + latest held mask. */
export interface SwfInput {
  readonly pressed: number;
  readonly held: number;
}

let pendingPressed = 0; // 소비 대기 중인 엣지(OR 누적)
let lastHostButtons = 0; // 직전 호스트 틱의 원시 마스크
let latestHeld = 0; // 최신 호스트 틱의 원시 마스크

export function hostPoll(buttons: number): void {
  pendingPressed |= buttons & ~lastHostButtons;
  lastHostButtons = buttons;
  latestHeld = buttons;
}
export function swfConsume(): SwfInput {
  const out: SwfInput = { pressed: pendingPressed, held: latestHeld };
  pendingPressed = 0;
  return out;
}
/** 테스트 전용 접근자. 게임 로직에서 호출하지 않는다. */
export function pendingForTest(): number {
  return pendingPressed;
}
/** 테스트 전용 리셋. 게임 로직에서 호출하지 않는다. */
export function resetInputForTest(): void {
  pendingPressed = 0;
  lastHostButtons = 0;
  latestHeld = 0;
}
