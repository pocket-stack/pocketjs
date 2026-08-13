// vapor/tests/sccp.test.ts — sparse conditional constant propagation.
//
// The dependency graph is normally a syntactic over-approximation:
// `flag.value ? a.value : b.value` subscribes to all three. These tests pin
// the SCCP refinement: refs proven constant fold at compile time, decidable
// branches drop their dead arm from both the effect masks and the ROM.

import { describe, expect, test } from "bun:test";
import { compileVaporApp } from "../compiler/compile.ts";

const HEADER = `
import { computed, ref } from "vue";
import { Button, onButton } from "../../host/input.ts";
`;

function app(setup: string, handler: string, jsx: string): string {
  return `${HEADER}
export default () => {
${setup}
  onButton((b) => {
${handler}
  });
  return (
    <>
${jsx}
    </>
  );
};
`;
}

describe("sccp ref constant propagation", () => {
  test("a never-written ref folds and splits the ternary mask", () => {
    const src = app(
      `  const flag = ref(false);
  const a = ref(1);
  const bb = ref(2);`,
      `    if (b === Button.A) a.value += 1;
    if (b === Button.B) bb.value += 1;`,
      `      <row y={0}>{flag.value ? a.value : bb.value}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.graph).toContain("flag (bool) = const 0 (sccp: reads folded, never dirty)");
    // the effect subscribes to bb alone — a and flag are gone from the mask
    expect(out.graph).toMatch(/eff_0: rows \[0, 1\) mask 0x4 \{bb\}/);
    // and the dead arm never reaches ROM
    expect(out.c).not.toContain("g_flag ?");
    expect(out.c).not.toContain("g_a :");
  });

  test("writes behind a decidably-false guard are pruned (conditional propagation)", () => {
    const src = app(
      `  const locked = ref(true);
  const secret = ref(0);
  const count = ref(0);`,
      `    if (b === Button.A) count.value += 1;
    if (!locked.value) secret.value += 1;`,
      `      <row y={0}>{secret.value ? 9 : count.value}</row>
      <row y={1}>{locked.value ? "LOCKED" : "OPEN"}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    // locked never written -> const 1; that kills secret's only write ->
    // secret const 0; both rows and the handler's dead if fold
    expect(out.graph).toContain("locked (bool) = const 1");
    expect(out.graph).toContain("secret (num) = const 0");
    expect(out.graph).toMatch(/eff_0: rows \[0, 1\) mask 0x4 \{count\}/);
    // the pruned write's set-gate never reaches ROM (seeding `g_secret = 0;`
    // legitimately remains for oracle/debug parity)
    expect(out.c).not.toContain("g_secret !=");
    expect(out.c).not.toContain("!g_locked");
    // row 1 folded to a static paint: exactly one effect remains
    expect(out.graph.match(/eff_\d+:/g)?.length).toBe(1);
    expect(out.c).toContain("LOCKED");
    expect(out.c).not.toContain("OPEN");
  });

  test("optimistic fixpoint: mutually-gated refs converge to const", () => {
    const src = app(
      `  const a = ref(false);
  const b2 = ref(false);
  const count = ref(0);`,
      `    if (b === Button.A) count.value += 1;
    if (a.value) b2.value = true;
    if (b2.value) a.value = true;`,
      `      <row y={0}>{a.value || b2.value ? 1 : count.value}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.graph).toContain("a (bool) = const 0");
    expect(out.graph).toContain("b2 (bool) = const 0");
    expect(out.graph).toMatch(/mask 0x4 \{count\}/);
  });

  test("a genuinely-mutated ref does not fold; both arms stay subscribed", () => {
    const src = app(
      `  const flag = ref(false);
  const a = ref(1);
  const bb = ref(2);`,
      `    if (b === Button.Select) flag.value = !flag.value;
    if (b === Button.A) a.value += 1;
    if (b === Button.B) bb.value += 1;`,
      `      <row y={0}>{flag.value ? a.value : bb.value}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.graph).not.toContain("= const");
    expect(out.graph).toMatch(/eff_0: rows \[0, 1\) mask 0x7 \{flag, a, bb\}/);
  });

  test("writes that store the ref's current value do not break folding", () => {
    const src = app(
      `  const mode = ref(3);
  const count = ref(0);`,
      `    if (b === Button.A) { count.value += 1; mode.value = 3; }
    if (b === Button.B) mode.value = 2 + 1;`,
      `      <row y={0}>{mode.value === 3 ? count.value : 0}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.graph).toContain("mode (num) = const 3");
    expect(out.graph).toMatch(/mask 0x2 \{count\}/);
  });

  test("computed over folded refs becomes dep-free and leaves masks", () => {
    const src = app(
      `  const base = ref(10);
  const count = ref(0);
  const offset = computed(() => base.value * 2);`,
      `    if (b === Button.A) count.value += 1;`,
      `      <row y={0}>{offset.value + count.value}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.graph).toContain("base (num) = const 10");
    expect(out.graph).toContain("offset: num <- {}");
    expect(out.graph).toMatch(/mask 0x2 \{count\}/);
  });

  test("folded refs still seed state and keep their debug slots (oracle parity)", () => {
    const src = app(
      `  const flag = ref(true);
  const count = ref(0);`,
      `    if (b === Button.A) count.value += 1;`,
      `      <row y={0}>{flag.value ? count.value : 0}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.c).toContain("g_flag = 1;");
    expect(out.debugSlots.map((s) => s.name)).toEqual(["flag", "count"]);
  });

  test("negative ref seeds initialize correctly (prefix-minus folding)", () => {
    const src = app(
      `  const cursor = ref(-1);
  const count = ref(0);`,
      `    if (b === Button.A) { cursor.value = 0; count.value += 1; }`,
      `      <row y={0}>{cursor.value + count.value}</row>`,
    );
    const out = compileVaporApp("sccp.tsx", src);
    expect(out.c).toContain("g_cursor = -1;");
  });
});
