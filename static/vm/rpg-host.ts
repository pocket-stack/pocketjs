// static/vm/rpg-host.ts — host-side RPG syscalls for the reference VM.
//
// Used by compiler unit tests and the story simulator: it executes SAY/CHOICE
// /WARP/... by recording them into an event log and answering CHOICEs from a
// scripted queue. This is "the game with the consoles removed" — if a story
// plays correctly here, the C runtimes only have to render it.

import { WAITING } from "../spec/isa.ts";
import { RPG_OP, RPG_OP_OPERANDS } from "../spec/rpg.ts";
import type { OperandReader, RefHost, RefVM, SyscallResult } from "./ref.ts";

export type RpgEvent =
  | { kind: "say"; textId: number }
  | { kind: "choice"; textIds: number[]; picked: number }
  | { kind: "lock" }
  | { kind: "release" }
  | { kind: "face"; slot: number }
  | { kind: "avis"; slot: number; visible: boolean }
  | { kind: "warp"; map: number; x: number; y: number; dir: number }
  | { kind: "sfx"; id: number }
  | { kind: "wait"; frames: number };

/**
 * Auto-playing host: SAY pages are dismissed immediately, CHOICEs answered
 * from `picks` (in order; throws when exhausted), WAITs elapse instantly.
 * `events` is the full ordered transcript.
 */
export class AutoRpgHost implements RefHost {
  events: RpgEvent[] = [];
  private picks: number[];
  private pickAt = 0;

  constructor(picks: number[] = []) {
    this.picks = picks;
  }

  /** Convenience: run a script to completion under this host. */
  play(vm: RefVM, scriptId: number): RpgEvent[] {
    vm.start(scriptId);
    while (vm.status === "suspended") {
      if (vm.waiting === WAITING.FRAMES) {
        this.events.push({ kind: "wait", frames: vm.lastWait });
        vm.resume();
      } else if (vm.waiting === WAITING.TEXT) {
        vm.resume();
      } else if (vm.waiting === WAITING.CHOICE) {
        const last = this.events[this.events.length - 1];
        if (!last || last.kind !== "choice") throw new Error("choice suspend without event");
        vm.resume(last.picked);
      } else {
        throw new Error(`unknown waiting state ${vm.waiting}`);
      }
    }
    return this.events;
  }

  syscall(op: number, r: OperandReader, _vm: RefVM): SyscallResult {
    switch (op) {
      case RPG_OP.SAY: {
        const textId = r.u16();
        this.events.push({ kind: "say", textId });
        return { suspend: WAITING.TEXT };
      }
      case RPG_OP.CHOICE: {
        const n = r.u8();
        const textIds: number[] = [];
        for (let i = 0; i < n; i++) textIds.push(r.u16());
        if (this.pickAt >= this.picks.length) {
          throw new Error(`CHOICE #${this.pickAt + 1} but only ${this.picks.length} picks scripted`);
        }
        const picked = this.picks[this.pickAt++];
        if (picked < 0 || picked >= n) throw new Error(`scripted pick ${picked} out of 0..${n - 1}`);
        this.events.push({ kind: "choice", textIds, picked });
        return { suspend: WAITING.CHOICE, pushOnResume: true };
      }
      case RPG_OP.LOCK:
        this.events.push({ kind: "lock" });
        return {};
      case RPG_OP.RELEASE:
        this.events.push({ kind: "release" });
        return {};
      case RPG_OP.FACE:
        this.events.push({ kind: "face", slot: r.u8() });
        return {};
      case RPG_OP.AVIS: {
        const slot = r.u8();
        const visible = r.u8() !== 0;
        this.events.push({ kind: "avis", slot, visible });
        return {};
      }
      case RPG_OP.WARP: {
        const map = r.u8(), x = r.u8(), y = r.u8(), dir = r.u8();
        this.events.push({ kind: "warp", map, x, y, dir });
        return {};
      }
      case RPG_OP.SFX:
        this.events.push({ kind: "sfx", id: r.u8() });
        return {};
      default:
        throw new Error(`unknown RPG syscall 0x${op.toString(16)}`);
    }
  }

  /** say/choice text ids in order — handy for asserting story flow. */
  get textTrace(): number[] {
    const out: number[] = [];
    for (const e of this.events) {
      if (e.kind === "say") out.push(e.textId);
      if (e.kind === "choice") out.push(...e.textIds);
    }
    return out;
  }
}

export { RPG_OP, RPG_OP_OPERANDS };
