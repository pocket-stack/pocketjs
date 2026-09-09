/** Run after ime:setup; this gate uses the deployed dictionary and native engine. */
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { RimeEngine } from "./rime.ts";
import { IME } from "../../contracts/spec/ime.ts";
const engine = new RimeEngine(resolve(Bun.argv[2] ?? ".pocket/ime"));
const keys = (s: string) => Array.from(s, c => c.charCodeAt(0));
const compose = async (input: number[]) => JSON.parse(await engine.compose(JSON.stringify(input)));
try {
  for (const [pinyin, expected] of [["nihao", "你好"], ["zhongwen", "中文"], ["beijing", "北京"]]) {
    const input = keys(pinyin);
    const snapshot = await compose(input);
    assert.equal(snapshot.candidates[0], expected);
    const committed = await compose([...input, IME.select]);
    assert.equal(committed.commit, expected);
    assert.equal(committed.preedit, "");
    assert.deepEqual(await compose([...input, IME.select]), committed);
  }
  const first = await compose(keys("ni"));
  const second = await compose([...keys("ni"), IME.pageDown]);
  assert.equal(second.page, 1);
  assert.notDeepEqual(second.candidates, first.candidates);
  assert.deepEqual(await compose([...keys("ni"), IME.pageDown, IME.pageUp]), first);
  assert.deepEqual(await compose([...keys("nix"), IME.backspace]), first);
  const moved = await compose([...keys("nihao"), IME.left]);
  assert.ok(moved.caret < moved.preedit.length);
  assert.equal((await compose([...keys("nihao"), IME.enter])).commit, "nihao");
  assert.equal((await compose([...keys("nihao"), 32])).commit, "你好");
  console.log("Rime acceptance passed: phrases, selection, replay, paging, deletion, caret, raw commit, space");
} finally { engine.close(); }
