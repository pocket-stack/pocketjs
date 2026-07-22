// vapor/test/compiler.test.ts — subset diagnostics + deterministic output.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compileVaporApp, VaporCompileError } from "../compiler/compile.ts";

const ENTRY = join(import.meta.dir, "..", "examples", "todo", "todo.tsx");

const HEADER = `
import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
`;

function minimal(body: string, jsx = "<row y={0}>{count.value}</row>"): string {
  return `${HEADER}
export default () => {
  const count = ref(0);
  ${body}
  onButton((b) => {
    if (b === Button.A) count.value = count.value + 1;
  });
  return (
    <>
      ${jsx}
    </>
  );
};
`;
}

function compileErr(source: string): string {
  try {
    compileVaporApp("test.tsx", source);
  } catch (e) {
    expect(e).toBeInstanceOf(VaporCompileError);
    return (e as Error).message;
  }
  throw new Error("expected a VaporCompileError");
}

describe("pocket vapor compiler", () => {
  test("compiles the todo example deterministically", async () => {
    const source = await Bun.file(ENTRY).text();
    const a = compileVaporApp(ENTRY, source, "VAPOR TODO");
    const b = compileVaporApp(ENTRY, source, "VAPOR TODO");
    expect(a.c).toBe(b.c);
    expect(a.c).toContain("vp_mark");
    expect(a.graph).toContain("visible: view(maxLen 12)");
    expect(a.plan).toContain("pools");
  });

  test("effect masks subscribe conditional reads on both arms", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    // the footer reads only `editing`; the list block reads todos+cursor+filter
    expect(app.graph).toMatch(/eff_\d+: rows \[19, 20\) mask 0x8 \{editing\}/);
    expect(app.graph).toMatch(/rows \[3, 15\) mask 0x7 \{todos, cursor, filter\}/);
  });

  test("rejects loose equality", () => {
    const msg = compileErr(minimal("", "<row y={0}>{count.value == 1 ? 'a' : 'b'}</row>"));
    expect(msg).toContain("===");
  });

  test("rejects dynamic row y outside map", () => {
    const msg = compileErr(minimal("", "<row y={count.value}>{'X'}</row>"));
    expect(msg).toContain("compile-time constant");
  });

  test("rejects unknown vue imports", () => {
    const msg = compileErr(`
import { ref, computed, watch } from "vue";
import { Button, onButton } from "../../host/input.ts";
export default () => {
  const count = ref(0);
  onButton((b) => { count.value = 1; });
  return (<><row y={0}>{count.value}</row></>);
};
`);
    expect(msg).toContain("watch");
  });

  test("rejects computeds that read later computeds", () => {
    const msg = compileErr(minimal("const a = computed(() => b.value + 1);\n  const b = computed(() => count.value);"));
    expect(msg).toContain(".value on non-reactive: b");
  });

  test("rejects list refs without an interface annotation", () => {
    const msg = compileErr(`${HEADER}
export default () => {
  const items = ref([{ text: "A", done: false }]);
  onButton((b) => {});
  return (<><row y={0}>{items.value.length}</row></>);
};
`);
    expect(msg).toContain("ref<T[]>");
  });

  test("errors carry file:line:col", () => {
    const msg = compileErr(minimal("", "<row y={0}>{count.value == 1 ? 'a' : 'b'}</row>"));
    expect(msg).toMatch(/^test\.tsx:\d+:\d+/);
  });

  test("keymaps compile to ROM fnptr tables with null holes", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    expect(app.c).toMatch(/static void \(\*const KM_listKeys\[10\]\)\(void\) = \{ .*km_listKeys_6.* \};/);
    expect(app.c).toContain("KM_editKeys");
    expect(app.c).toMatch(/\? KM_editKeys : KM_listKeys/); // dispatch ternary
    expect(app.c).toContain("fn_closeEditor"); // bare fn reference as keymap value
  });

  test("computed can yield a record reference (current todo)", async () => {
    const source = await Bun.file(ENTRY).text();
    const app = compileVaporApp(ENTRY, source);
    expect(app.graph).toContain("current: obj <- {cursor, filter, todos}");
    expect(app.c).toContain("static rec_todo * c_current_v;");
  });

  test("splice/indexOf remain in the subset", () => {
    const source = `${HEADER}
interface It { text: string; done: boolean }
export default () => {
  const items = ref<It[]>([{ text: "A", done: false }]);
  onButton((b) => {
    const t = items.value[0];
    if (t) items.value.splice(items.value.indexOf(t), 1);
  });
  return (<><row y={0}>{items.value.length}</row></>);
};
`;
    const app = compileVaporApp("test.tsx", source);
    expect(app.c).toContain("g_items_len--");
  });

  test("rejects keymap keys that are not compile-time constants", () => {
    const msg = compileErr(minimal("const keys = { [count.value]: () => {} };"));
    expect(msg).toContain("compile-time Button constants");
  });

  test("rejects helper params without a number annotation", () => {
    const msg = compileErr(minimal("function move(d) { count.value = count.value + d; }"));
    expect(msg).toContain("annotated `: number`");
  });

  test("rejects list assignment from a different list", () => {
    const source = `${HEADER}
interface It { text: string; done: boolean }
export default () => {
  const a = ref<It[]>([]);
  const b2 = ref<It[]>([]);
  onButton((b) => {
    a.value = b2.value.filter((t) => !t.done);
  });
  return (<><row y={0}>{a.value.length}</row></>);
};
`;
    const msg = compileErr(source);
    expect(msg).toContain("derive from the same list");
  });
});
