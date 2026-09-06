import { flush } from "solid-js";
// The OSK editing session, unit-tested through its JSX-free module (the
// keyboard VIEW and the TextField that summons it are pinned at the app
// level — pocket-youtube's sim journeys drive the full tap→type→search path).

import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { createOsk } from "../framework/src/osk-controller.ts";

function session(initial = "", opts: { maxLength?: number; closeOnCommit?: boolean } = {}) {
  const [value, setValue] = createSignal(initial);
  const committed: string[] = [];
  const closed: number[] = [];
  const osk = createOsk({
    value,
    setValue,
    onCommit: (text) => committed.push(text),
    onClose: () => closed.push(1),
    ...opts,
  });
  return { osk, value, setValue, committed, closed };
}

describe("editing", () => {
  test("insert/backspace edit at the caret; caret follows", () => {
    const s = session("psp");
    s.osk.open(); flush();
    expect(s.osk.caret()).toBe(3);
    s.osk.insert("!"); flush();
    expect(s.value()).toBe("psp!");
    s.osk.moveCaret(-4); flush();
    s.osk.insert("go "); flush();
    expect(s.value()).toBe("go psp!");
    s.osk.backspace(); flush();
    expect(s.value()).toBe("gopsp!");
  });

  test("maxLength refuses overflow whole (no partial inserts)", () => {
    const s = session("1234", { maxLength: 5 });
    s.osk.open(); flush();
    s.osk.insert("ab"); flush();
    expect(s.value()).toBe("1234");
    s.osk.insert("a"); flush();
    expect(s.value()).toBe("1234a");
  });

  test("the caret clamps live against external edits", () => {
    const s = session("abcdef");
    s.osk.open(); flush();
    expect(s.osk.caret()).toBe(6);
    s.setValue("ab"); flush();
    expect(s.osk.caret()).toBe(2);
    expect(s.osk.display("|")).toBe("ab|");
  });
});

describe("session lifecycle", () => {
  test("commit reports the bound value and closes (closeOnCommit default)", () => {
    const s = session("vita");
    s.osk.open(); flush();
    s.osk.commit(); flush();
    expect(s.committed).toEqual(["vita"]);
    expect(s.osk.isOpen()).toBe(false);
  });

  test("closeOnCommit:false keeps the session open across commits", () => {
    const s = session("hi", { closeOnCommit: false });
    s.osk.open(); flush();
    s.osk.commit(); flush();
    expect(s.osk.isOpen()).toBe(true);
  });

  test("cancel closes without committing", () => {
    const s = session("draft");
    s.osk.open(); flush();
    s.osk.cancel(); flush();
    expect(s.committed).toEqual([]);
    expect(s.closed).toEqual([1]);
    expect(s.osk.isOpen()).toBe(false);
  });

  test("display carries the caret marker only while open", () => {
    const s = session("ab");
    expect(s.osk.display("|")).toBe("ab");
    s.osk.open(); flush();
    expect(s.osk.display("|")).toBe("ab|");
  });
});
