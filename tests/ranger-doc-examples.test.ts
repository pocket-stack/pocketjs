// tests/ranger-doc-examples.test.ts — M1 checked doc mirrors (§6.6).
//
// Contract: bun test tests/ranger-doc-examples.test.ts
// Typecheck target: node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
//
// This file holds the complete compilable examples for the
// `// checked mirror … keep in sync` fences (§6.1 fixed, §6.2 state,
// §6.3 clip, §6.3 rng). Mirror sections below are byte-identical with the
// doc fences except ONE line: the §state fence's
// `import type { Subpx } from "./fixed.ts";` is dropped here because this
// self-contained file defines Subpx once in its §fixed section (keeping
// the line would be a duplicate-identifier error; §6.6-3 "다르면 테스트가
// 이긴다"). Allowed import surface elsewhere is tsconfig `paths` keys plus
// `.ts` relative imports only; `import type` lines erase at runtime.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as SimFixed from "../apps/ranger/sim/fixed.ts";
import * as SimRng from "../apps/ranger/sim/rng.ts";

const SELF = fileURLToPath(import.meta.url);

// checked mirror of tests/ranger-doc-examples.test.ts §fixed — keep in sync.
// 1px = 16 subpx. 모든 게임 좌표·속도는 i32 subpx 정수다.
export const SUB = 16;
export type Subpx = number; // i32 invariant (정수만 대입)
export const toSub = (px: number): Subpx => Math.floor(px) * SUB;
export const toPx = (s: Subpx): number => Math.floor(s / SUB);
export const GX = (x: number): number => Math.floor((x * 8) / 15); // §2.1
export const GY = (y: number): number => 32 + Math.floor((y * 8) / 15);

// checked mirror of tests/ranger-doc-examples.test.ts §state — keep in sync.
// 값 import는 실제 공개 export 키(`@pocketjs/framework/*`, package.json `exports`)만 사용한다.
export type Phase = "title" | "fight" | "clear" | "over";
export interface FighterState {
  x: Subpx; y: Subpx; vx: Subpx; vy: Subpx;
  facing: 1 | -1; hp: number; maxHp: number;
  pose: number; // 1-based 부모 프레임 (§5.1 POSE)
  state: "idle"|"walk"|"jump"|"guard"|"hurt"|"attack"|"dead";
  stateT: number; // SWF 프레임 단위 경과
  atkId: number; hitDone: boolean; atkCd: number;
}
export interface GameState {
  phase: Phase; score: number; combo: number; comboT: number;
  hitstop: number; swfFrame: number;
  player: FighterState; enemies: FighterState[];
}
// _root 접근은 이 인터페이스로만:
export interface RootApi {
  gotoAndPlay(label: string): void;
  gotoAndStop(frame: number): void;
  addScore(n: number): void;
}

// checked mirror of tests/ranger-doc-examples.test.ts §clip — keep in sync.
// NodeMirror는 실제 공개 API다: framework/src/renderer-solid.ts에서
// `export { … type NodeMirror }`로 재export되며, 기존 apps/ranger/battle.tsx도
// `@pocketjs/framework/renderer`에서 import한다. 아래 예제는 그 경로를 그대로 쓴다.
import type { NodeMirror } from "@pocketjs/framework/renderer";
export interface ClipInstance {
  slotPath: string; variant: string; node: NodeMirror;
  frameIdx: number; playing: boolean;
  vars: Record<string, number | string | boolean>;
  scriptRunMark: number;
}
export function gotoAndStop(c: ClipInstance, frame1Based: number): void {
  c.frameIdx = frame1Based - 1; c.playing = false;
}

// checked mirror of tests/ranger-doc-examples.test.ts §rng — keep in sync.
// §3.5 xorshift32 고정
export interface Rng { next(n: number): number; reset(seed: number): void; }
export function createRng(seed = 0xc0ffee): Rng {
  let s = seed >>> 0 || 1;
  return {
    next(n: number): number {
      s ^= (s << 13) >>> 0; s >>>= 0;
      s ^= s >>> 17; s ^= (s << 5) >>> 0; s >>>= 0;
      return (s % n + n) % n;
    },
    reset(seed2: number): void { s = seed2 >>> 0 || 1; },
  };
}

function makeFighter(): FighterState {
  return {
    x: 0, y: 0, vx: 0, vy: 0,
    facing: 1, hp: 100, maxHp: 100,
    pose: 1, state: "idle", stateT: 0,
    atkId: 0, hitDone: false, atkCd: 0,
  };
}

describe("ranger doc mirrors (§6.6)", () => {
  test("mirror sections are present with their sync markers", () => {
    const src = readFileSync(SELF, "utf8");
    for (const section of ["§fixed", "§state", "§clip", "§rng"]) {
      expect(
        src.includes(
          `// checked mirror of tests/ranger-doc-examples.test.ts ${section} — keep in sync.`,
        ),
      ).toBe(true);
    }
  });

  test("§fixed mirror matches sim/fixed.ts behavior", () => {
    expect(SUB).toBe(SimFixed.SUB);
    for (const px of [0, 1, 2, 50, 300, 600]) {
      expect(toSub(px)).toBe(SimFixed.toSub(px));
      expect(GX(px)).toBe(SimFixed.GX(px));
      expect(GY(px)).toBe(SimFixed.GY(px));
    }
    for (const s of [0, 16, 160, 5120]) {
      expect(toPx(s)).toBe(SimFixed.toPx(s));
    }
  });

  test("§state shapes construct and RootApi covers _root access", () => {
    const player = makeFighter();
    const game: GameState = {
      phase: "fight", score: 0, combo: 0, comboT: 0,
      hitstop: 0, swfFrame: 0,
      player, enemies: [makeFighter()],
    };
    expect(game.phase).toBe("fight");
    expect(game.enemies.length).toBe(1);
    const calls: string[] = [];
    const root: RootApi = {
      gotoAndPlay: (label: string) => {
        calls.push(`play:${label}`);
      },
      gotoAndStop: (frame: number) => {
        calls.push(`stop:${frame}`);
      },
      addScore: (n: number) => {
        game.score += n;
      },
    };
    root.gotoAndPlay("fight");
    root.gotoAndStop(1);
    root.addScore(100);
    expect(calls).toEqual(["play:fight", "stop:1"]);
    expect(game.score).toBe(100);
  });

  test("§clip gotoAndStop pins 1-based frames and holds", () => {
    const clip = {
      slotPath: "root/p1/body",
      variant: "v546",
      node: {} as NodeMirror,
      frameIdx: 5,
      playing: true,
      vars: {} as Record<string, number | string | boolean>,
      scriptRunMark: 0,
    } satisfies ClipInstance;
    gotoAndStop(clip, 36);
    expect(clip.frameIdx).toBe(35);
    expect(clip.playing as boolean).toBe(false);
  });

  test("§rng mirror matches sim/rng.ts and resets deterministically", () => {
    const a = createRng();
    const b = SimRng.createRng();
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 8; i++) {
      seqA.push(a.next(100));
      seqB.push(b.next(100));
    }
    expect(seqA).toEqual(seqB);
    a.reset(1234);
    b.reset(1234);
    expect(a.next(1000)).toBe(b.next(1000));
    // Seeded streams stay in range and repeat after reset.
    const c = createRng(7);
    const first = [c.next(6), c.next(6), c.next(6)];
    c.reset(7);
    expect([c.next(6), c.next(6), c.next(6)]).toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
  });
});
