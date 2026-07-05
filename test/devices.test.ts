// test/devices.test.ts — compile-time device profiles + responsive/device
// variants (spec/devices.ts + compiler/tailwind.ts). One app source, resolved
// per device profile at BUILD time. Run: bun test test/devices.test.ts.

import { describe, expect, test } from "bun:test";
import { compileClasses, fontSlotFor, parseClassLiteral } from "../compiler/tailwind.ts";
import { resolveProfile } from "../spec/devices.ts";
import { ENUMS, PROP, STYLE_ID_NONE, type StyleRecord } from "../spec/spec.ts";

const psp = resolveProfile("psp"); // 480×272
const tds = resolveProfile("3ds"); // 400×240

const baseMap = (rec: StyleRecord | null): Map<number, number> => {
  expect(rec).not.toBeNull();
  return new Map((rec!.base ?? []).map((p) => [p.prop, p.value]));
};
const isEmpty = (rec: StyleRecord | null): boolean =>
  rec !== null && !rec.base && !rec.focus && !rec.active && !rec.transition;

describe("width breakpoints (gated on profile width)", () => {
  test("md: sits between 3ds(400) and psp(480)", () => {
    // text-xl (20px) base, md:text-2xl (24px) only wide enough on psp.
    expect(baseMap(parseClassLiteral("text-xl md:text-2xl", psp)).get(PROP.fontSlot)).toBe(
      fontSlotFor(24, false),
    );
    expect(baseMap(parseClassLiteral("text-xl md:text-2xl", tds)).get(PROP.fontSlot)).toBe(
      fontSlotFor(20, false),
    );
  });

  test("sm: matches both handhelds, lg:/xl: match neither", () => {
    expect(baseMap(parseClassLiteral("sm:p-2", tds)).get(PROP.paddingT)).toBeDefined();
    expect(baseMap(parseClassLiteral("sm:p-2", psp)).get(PROP.paddingT)).toBeDefined();
    expect(isEmpty(parseClassLiteral("lg:p-2", psp))).toBeTrue();
    expect(isEmpty(parseClassLiteral("xl:p-2", psp))).toBeTrue();
  });
});

describe("device flags (gated on profile name / caps)", () => {
  test("3ds:flex-row applies on 3ds, is inert on psp", () => {
    expect(baseMap(parseClassLiteral("3ds:flex-row", tds)).get(PROP.flexDir)).toBe(
      ENUMS.FlexDir.Row,
    );
    expect(isEmpty(parseClassLiteral("3ds:flex-row", psp))).toBeTrue();
  });

  test("capability flag by cap name (touch: only on 3ds)", () => {
    expect(baseMap(parseClassLiteral("touch:hidden", tds)).get(PROP.display)).toBe(
      ENUMS.Display.None,
    );
    expect(isEmpty(parseClassLiteral("touch:hidden", psp))).toBeTrue();
  });

  test("one source, mixed reflow + per-device overrides", () => {
    // flex always; row on wide screens (md), col forced on 3ds.
    expect(baseMap(parseClassLiteral("flex md:flex-row 3ds:flex-col", psp)).get(PROP.flexDir)).toBe(
      ENUMS.FlexDir.Row,
    );
    expect(baseMap(parseClassLiteral("flex md:flex-row 3ds:flex-col", tds)).get(PROP.flexDir)).toBe(
      ENUMS.FlexDir.Col,
    );
  });
});

describe("validity: gated-out is inert, not invalid", () => {
  test("unknown prefix still disqualifies the literal", () => {
    expect(parseClassLiteral("wide:flex", psp)).toBeNull();
  });

  test("a bad body under a device prefix still disqualifies (either device)", () => {
    expect(parseClassLiteral("3ds:notautility", tds)).toBeNull();
    expect(parseClassLiteral("3ds:notautility", psp)).toBeNull();
  });

  test("hover: only errors when it would actually apply on this build", () => {
    expect(() => parseClassLiteral("3ds:hover:bg-blue-500", tds)).toThrow(/hover/);
    expect(() => parseClassLiteral("3ds:hover:bg-blue-500", psp)).not.toThrow();
  });

  test("default profile == psp (today's behaviour preserved)", () => {
    expect(baseMap(parseClassLiteral("md:p-2")).get(PROP.paddingT)).toBeDefined();
  });
});

describe("compileClasses maps fully-gated-out literals to STYLE_ID_NONE", () => {
  test("device-only literal is a KNOWN class (clears to default), not unknown", () => {
    const cPsp = compileClasses(["3ds:flex-row", "flex"], psp);
    expect(cPsp.ids["3ds:flex-row"]).toBe(STYLE_ID_NONE);
    expect(cPsp.ids["flex"]).toBeGreaterThanOrEqual(0);

    const cTds = compileClasses(["3ds:flex-row", "flex"], tds);
    expect(cTds.ids["3ds:flex-row"]).toBeGreaterThanOrEqual(0);
    expect(cTds.records.length).toBe(2);
  });
});
