import { describe, expect, test } from "bun:test";
import { createIme, IME } from "../framework/src/ime.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import type { ImeSnapshot } from "../contracts/spec/ime.ts";

function fixture() {
  let session = 1;
  const sent: { id: number; payload: string }[] = [], replies: string[] = [], committed: string[] = [];
  const io = createOffloadClient({ session: () => session, take: () => replies.shift(),
    submit: raw => { sent.push(JSON.parse(raw)); return true; } });
  const ime = createIme({ io, changed() {}, commit: value => committed.push(value) });
  const tick = () => { io.step(); ime.step(); };
  const answer = (request: number, fields: Partial<ImeSnapshot> = {}) => replies.push(JSON.stringify({ id: request,
    payload: JSON.stringify({ commit: "", preedit: "ni", candidates: ["你", "呢"], page: 0, last: false, caret: (fields.preedit ?? "ni").length, ...fields }) }));
  return { ime, io, sent, committed, tick, answer, connect: (n: number) => { session = n; } };
}
describe("replayable IME", () => {
  test("stale candidates cannot replace a newer composition or be selected", () => {
    const f = fixture();
    f.ime.key(110); f.tick(); f.tick();
    f.ime.key(105);
    f.answer(f.sent[0].id, { preedit: "n" }); f.tick(); f.tick();
    expect(f.ime.select(0)).toBe(false);
    expect(JSON.parse(f.sent[1].payload)).toEqual([110, 105]);
    f.answer(f.sent[1].id); f.tick();
    expect(f.ime.state().preedit).toBe("ni");
    expect(f.ime.select(0)).toBe(true);
  });
  test("disconnect retains the transcript and fences replies from its previous transport", () => {
    const f = fixture();
    f.ime.key(110); f.tick(); f.tick();
    const old = f.sent[0].id;
    f.connect(0); f.tick(); f.ime.key(105); f.tick();
    expect(f.ime.state().connected).toBe(false);
    f.connect(2); f.tick(); f.tick();
    expect(JSON.parse(f.sent[1].payload)).toEqual([110, 105]);
    f.answer(old, { commit: "wrong", preedit: "" }); f.tick();
    expect(f.committed).toEqual([]);
    f.answer(f.sent[1].id); f.tick();
    expect(f.ime.select(1)).toBe(true);
    f.tick(); f.tick();
    f.answer(f.sent[2].id, { commit: "呢", preedit: "", candidates: [] }); f.tick();
    expect(f.committed).toEqual(["呢"]);
    expect(f.ime.composing()).toBe(false);
  });
  test("closing an editor rejects in-flight commits; transcript budget is bounded", () => {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick();
    f.ime.reset(); f.answer(f.sent[0].id, { commit: "你", preedit: "" }); f.tick();
    expect(f.committed).toEqual([]);
    for (let i = 0; i < IME.keys; i++) expect(f.ime.key(97)).toBe(true);
    expect(f.ime.key(97)).toBe(false);
    f.ime.reset();
    expect(f.ime.key(-1)).toBe(false);
    expect(f.ime.key(0x1f600)).toBe(false);
    expect(f.ime.key(97)).toBe(true);
  });
});
