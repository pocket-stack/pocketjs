import { describe, expect, test } from "bun:test";
import { createIme, IME } from "../framework/src/ime.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import type { ImeSnapshot } from "../contracts/spec/ime.ts";

function fixture() {
  let session = 1;
  const sent: { id: number; method: string; payload: string }[] = [], replies: string[] = [], committed: string[] = [];
  const io = createOffloadClient({ session: () => session, take: () => replies.shift(),
    submit: raw => { sent.push(JSON.parse(raw)); return true; } });
  const ime = createIme({ io, changed() {}, commit: value => committed.push(value) });
  const tick = () => { io.step(); ime.step(); };
  const answer = (request: number, fields: Partial<ImeSnapshot> = {}) => replies.push(JSON.stringify({ id: request,
    payload: JSON.stringify({ commit: "", preedit: "ni", candidates: ["你", "呢"], page: 0, last: false, caret: (fields.preedit ?? "ni").length, ...fields }) }));
  return { ime, io, sent, committed, tick, answer, replies, connect: (n: number) => { session = n; } };
}
describe("replayable IME", () => {
  test("candidate windows are reads and absolute selection is revision fenced", () => {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick(); f.answer(f.sent[0].id); f.tick();
    let count = 0;
    expect(f.ime.browse(15, p => { count = p!.candidates.length; })).toBeGreaterThan(0); f.tick();
    const read = f.sent.at(-1)!;
    expect(read.method).toBe("ime.candidates");
    expect(JSON.parse(read.payload)).toEqual({ keys: [110], offset: 15 });
    f.replies.push(JSON.stringify({ id: read.id, payload: JSON.stringify({ offset: 15, candidates: ["泥", "拟"], last: true }) })); f.tick();
    expect(count).toBe(2); expect(f.ime.state().preedit).toBe("ni");
    expect(f.ime.selectAbsolute(16)).toBe(true); f.tick(); f.tick();
    expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([110, IME.selectAbsolute + 16]);
    expect(f.ime.selectAbsolute(15)).toBe(false);
  });
  test("typing cancels candidate windows and rejects their stale selections", () => {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick(); f.answer(f.sent[0].id); f.tick();
    let completed = false;
    f.ime.browse(15, () => { completed = true; }); f.tick(); const old = f.sent.at(-1)!.id;
    f.ime.key(105);
    f.replies.push(JSON.stringify({ id: old, payload: JSON.stringify({ offset: 15, candidates: ["wrong"], last: true }) })); f.tick();
    expect(completed).toBe(false); expect(f.ime.selectAbsolute(15)).toBe(false);
    expect(f.ime.browse(512, () => {})).toBe(0);
  });
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
  test("delayed caret replies cannot move a continuing left drag back to an older position", () => {
    const f = fixture();
    for (const ch of "haha") f.ime.key(ch.charCodeAt(0));
    f.tick(); f.tick(); f.answer(f.sent.at(-1)!.id, { preedit: "ha ha", caret: 5 }); f.tick();
    const shown = [f.ime.state().caret];
    f.ime.key(IME.left); f.tick(); f.tick(); const first = f.sent.at(-1)!.id;
    f.ime.key(IME.left);
    f.answer(first, { preedit: "ha ha", caret: 4 }); f.tick(); f.tick();
    shown.push(f.ime.state().caret);
    const second = f.sent.at(-1)!.id;
    f.answer(second, { preedit: "haha", caret: 2 }); f.tick(); shown.push(f.ime.state().caret);
    f.ime.key(IME.left); f.tick(); f.tick();
    f.answer(f.sent.at(-1)!.id, { preedit: "haha", caret: 1 }); f.tick(); shown.push(f.ime.state().caret);
    f.ime.key(IME.left); f.tick(); f.tick();
    f.answer(f.sent.at(-1)!.id, { preedit: "ha ha", caret: 0 }); f.tick(); shown.push(f.ime.state().caret);
    f.answer(first, { preedit: "ha ha", caret: 4 }); f.answer(second, { preedit: "haha", caret: 2 }); f.tick();
    shown.push(f.ime.state().caret);
    expect(shown).toEqual([5, 5, 2, 1, 0, 0]);
    expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([...Array.from("haha", c => c.charCodeAt(0)), ...Array(4).fill(IME.left)]);
    expect(f.committed).toEqual([]);
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
