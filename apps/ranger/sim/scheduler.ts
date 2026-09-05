// apps/ranger/sim/scheduler.ts — M1 integer SWF scheduler (hand-written).
//
// 24Hz SWF simulation over the 60Hz host with zero drift: Bresenham
// accumulator, integer only (§3.2). First block mirrors the contract fence.

export interface SwfScheduler {
  /** 다음 SWF 프레임까지 남은 호스트 틱이 아니라, 누적자 자체다. */
  acc: number; // 0 <= acc < 60 invariant
  swfFrame: number; // 현재 SWF 프레임 인덱스(루트 기준 0-based)
}
export function schedulerStep(s: SwfScheduler): number {
  // 이번 호스트 틱에서 전진할 SWF 프레임 수(0 또는 1)를 반환한다.
  // 24fps이므로 5틱당 정확히 2프레임: 반환값 패턴 [0,0,1,0,1]의 반복.
  s.acc += 24;
  if (s.acc >= 60) {
    s.acc -= 60;
    s.swfFrame += 1;
    return 1;
  }
  return 0;
}

// --- M1 companion (not part of the mirror) ---

/** Fresh scheduler: acc = 0, swfFrame = 0 (§3.2). */
export function createScheduler(): SwfScheduler {
  return { acc: 0, swfFrame: 0 };
}
