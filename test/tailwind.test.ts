// Unit tests for the Tailwind-subset token parser (compiler/tailwind.ts).
// Run: bun test test/tailwind.test.ts   (wired into `bun run test`).

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FONT_SLOT,
  compileClasses,
  fontSlotFor,
  paletteColor,
  parseClassLiteral,
} from "../compiler/tailwind.ts";
import {
  ENUMS,
  PROP,
  SIZE_FULL,
  TRANSITION_MASK_ALL,
  abgr,
  animBit,
  bitsF32,
  decodeStyleTable,
  f32Bits,
  type StyleProp,
  type StyleRecord,
} from "../spec/spec.ts";

function props(rec: StyleRecord | null, variant: "base" | "focus" | "active" = "base"): Map<number, number> {
  expect(rec).not.toBeNull();
  const list: StyleProp[] = rec![variant] ?? [];
  return new Map(list.map((p) => [p.prop, p.value]));
}

const f32Of = (m: Map<number, number>, prop: number): number => {
  expect(m.has(prop)).toBeTrue();
  return bitsF32(m.get(prop)!);
};

describe("palette", () => {
  test("known colors", () => {
    expect(paletteColor("white")).toBe(abgr(255, 255, 255));
    expect(paletteColor("black")).toBe(abgr(0, 0, 0));
    expect(paletteColor("transparent")).toBe(0);
    expect(paletteColor("slate-900")).toBe(abgr(0x0f, 0x17, 0x2a));
    expect(paletteColor("indigo-500")).toBe(abgr(0x63, 0x66, 0xf1));
    expect(paletteColor("emerald-400")).toBe(abgr(0x34, 0xd3, 0x99));
    expect(paletteColor("rose-950")).toBe(abgr(0x4c, 0x05, 0x19));
  });
  test("rejections", () => {
    expect(paletteColor("slate-901")).toBeNull();
    expect(paletteColor("mauve-500")).toBeNull();
    expect(paletteColor("slate")).toBeNull();
  });
});

describe("spacing / box", () => {
  test("p-2 = 8px on all four sides", () => {
    const m = props(parseClassLiteral("p-2"));
    for (const p of [PROP.paddingT, PROP.paddingR, PROP.paddingB, PROP.paddingL]) {
      expect(bitsF32(m.get(p)!)).toBe(8);
    }
  });
  test("px-3 / mt-1.5 axis and fractional scale", () => {
    const m = props(parseClassLiteral("px-3 mt-1.5"));
    expect(bitsF32(m.get(PROP.paddingL)!)).toBe(12);
    expect(bitsF32(m.get(PROP.paddingR)!)).toBe(12);
    expect(m.has(PROP.paddingT)).toBeFalse();
    expect(bitsF32(m.get(PROP.marginT)!)).toBe(6);
  });
  test("w-16 h-full and arbitrary values", () => {
    const m = props(parseClassLiteral("w-16 h-full"));
    expect(f32Of(m, PROP.width)).toBe(64);
    expect(f32Of(m, PROP.height)).toBe(SIZE_FULL);
    const a = props(parseClassLiteral("w-[123px] h-[45]"));
    expect(f32Of(a, PROP.width)).toBe(123);
    expect(f32Of(a, PROP.height)).toBe(45);
  });
  test("min/max, inset, z, absolute", () => {
    const m = props(parseClassLiteral("absolute inset-0 top-2 min-w-10 max-h-20 z-5"));
    expect(m.get(PROP.posType)).toBe(ENUMS.PosType.Absolute);
    expect(f32Of(m, PROP.insetT)).toBe(8); // inset-0 then top-2 (last wins)
    expect(f32Of(m, PROP.insetB)).toBe(0);
    expect(f32Of(m, PROP.minW)).toBe(40);
    expect(f32Of(m, PROP.maxH)).toBe(80);
    expect(m.get(PROP.zIndex)).toBe(5);
  });
  test("hidden / overflow-hidden", () => {
    const m = props(parseClassLiteral("hidden overflow-hidden"));
    expect(m.get(PROP.display)).toBe(ENUMS.Display.None);
    expect(m.get(PROP.overflow)).toBe(ENUMS.Overflow.Hidden);
  });
});

describe("flex", () => {
  test("full flex row", () => {
    const m = props(parseClassLiteral("flex flex-row justify-between items-center gap-4 flex-wrap"));
    expect(m.get(PROP.display)).toBe(ENUMS.Display.Flex);
    expect(m.get(PROP.flexDir)).toBe(ENUMS.FlexDir.Row);
    expect(m.get(PROP.justify)).toBe(ENUMS.Justify.Between);
    expect(m.get(PROP.align)).toBe(ENUMS.Align.Center);
    expect(f32Of(m, PROP.gap)).toBe(16);
    expect(m.get(PROP.flexWrap)).toBe(1);
  });
  test("flex-1 expands to grow/shrink/basis", () => {
    const m = props(parseClassLiteral("flex-1"));
    expect(f32Of(m, PROP.grow)).toBe(1);
    expect(f32Of(m, PROP.shrink)).toBe(1);
    expect(f32Of(m, PROP.basis)).toBe(0);
  });
  test("grow-0 shrink-0 basis-8", () => {
    const m = props(parseClassLiteral("grow-0 shrink-0 basis-8"));
    expect(f32Of(m, PROP.grow)).toBe(0);
    expect(f32Of(m, PROP.shrink)).toBe(0);
    expect(f32Of(m, PROP.basis)).toBe(32);
  });
});

describe("visual", () => {
  test("bg + gradient + border + shadow + opacity + rounded", () => {
    const m = props(
      parseClassLiteral("bg-slate-900 bg-gradient-to-b from-indigo-500 to-transparent border border-white shadow-md opacity-50 rounded-lg"),
    );
    expect(m.get(PROP.bgColor)).toBe(abgr(0x0f, 0x17, 0x2a));
    expect(m.get(PROP.gradDir)).toBe(ENUMS.GradDir.ToBottom);
    expect(m.get(PROP.gradFrom)).toBe(abgr(0x63, 0x66, 0xf1));
    expect(m.get(PROP.gradTo)).toBe(0);
    expect(f32Of(m, PROP.borderWidth)).toBe(1);
    expect(m.get(PROP.borderColor)).toBe(abgr(255, 255, 255));
    expect(m.get(PROP.shadow)).toBe(2);
    expect(f32Of(m, PROP.opacity)).toBe(0.5);
    expect(f32Of(m, PROP.radius)).toBe(8);
  });
  test("rounded-full bakes radius from pinned w/h", () => {
    const m = props(parseClassLiteral("w-12 h-8 rounded-full"));
    expect(f32Of(m, PROP.radius)).toBe(16); // min(48,32)/2
  });
  test("rounded-full without pinned size throws [R]", () => {
    expect(() => parseClassLiteral("rounded-full bg-white")).toThrow(/rounded-full/);
    expect(() => parseClassLiteral("w-12 rounded-full")).toThrow(/rounded-full/);
    expect(() => parseClassLiteral("w-full h-full rounded-full")).toThrow(/rounded-full/);
  });
});

describe("text", () => {
  test("size + weight combine into one font slot", () => {
    const m = props(parseClassLiteral("text-2xl font-bold text-white"));
    expect(m.get(PROP.fontSlot)).toBe(fontSlotFor(24, true));
    expect(m.get(PROP.textColor)).toBe(abgr(255, 255, 255));
  });
  test("font-bold alone defaults to 16px bold", () => {
    const m = props(parseClassLiteral("font-bold"));
    expect(m.get(PROP.fontSlot)).toBe(fontSlotFor(16, true));
  });
  test("align / leading / tracking", () => {
    const m = props(parseClassLiteral("text-center leading-6 tracking-wide text-lg"));
    expect(m.get(PROP.textAlign)).toBe(ENUMS.TextAlign.Center);
    expect(f32Of(m, PROP.lineHeight)).toBe(24);
    expect(f32Of(m, PROP.tracking)).toBeCloseTo(0.025 * 18, 5);
    expect(m.get(PROP.fontSlot)).toBe(fontSlotFor(18, false));
  });
});

describe("transform", () => {
  test("translate/scale/rotate", () => {
    const m = props(parseClassLiteral("translate-x-2 translate-y-[10px] scale-95 scale-x-50 scale-y-125 rotate-45"));
    expect(f32Of(m, PROP.translateX)).toBe(8);
    expect(f32Of(m, PROP.translateY)).toBe(10);
    expect(f32Of(m, PROP.scale)).toBeCloseTo(0.95, 5);
    expect(f32Of(m, PROP.scaleX)).toBeCloseTo(0.5, 5);
    expect(f32Of(m, PROP.scaleY)).toBeCloseTo(1.25, 5);
    expect(f32Of(m, PROP.rotate)).toBe(45);
  });
});

describe("variants", () => {
  test("focus:/active: fold into the same record", () => {
    const rec = parseClassLiteral("bg-indigo-500 focus:bg-indigo-300 active:scale-95");
    expect(props(rec).get(PROP.bgColor)).toBe(abgr(0x63, 0x66, 0xf1));
    expect(props(rec, "focus").get(PROP.bgColor)).toBe(abgr(0xa5, 0xb4, 0xfc));
    expect(bitsF32(props(rec, "active").get(PROP.scale)!)).toBeCloseTo(0.95, 5);
  });
  test("hover: is a loud error in an otherwise-valid literal", () => {
    expect(() => parseClassLiteral("p-2 hover:bg-white")).toThrow(/hover/);
  });
});

describe("motion", () => {
  test("transition-colors duration-150", () => {
    const rec = parseClassLiteral("bg-indigo-500 transition-colors duration-150")!;
    expect(rec.transition).toBeDefined();
    expect(rec.transition!.durMs).toBe(150);
    expect(rec.transition!.delayMs).toBe(0);
    expect(rec.transition!.easing).toBe(ENUMS.Easing.EaseInOut);
    const mask = rec.transition!.mask;
    expect(mask & (1 << animBit("bgColor"))).not.toBe(0);
    expect(mask & (1 << animBit("translateX"))).toBe(0);
  });
  test("transition-all + ease-spring + delay", () => {
    const rec = parseClassLiteral("transition-all duration-300 ease-spring delay-16")!;
    expect(rec.transition!.mask).toBe(TRANSITION_MASK_ALL);
    expect(rec.transition!.durMs).toBe(300);
    expect(rec.transition!.delayMs).toBe(16);
    expect(rec.transition!.easing).toBe(ENUMS.Easing.Spring);
  });
  test("plain transition covers colors+opacity+transform", () => {
    const rec = parseClassLiteral("transition")!;
    const mask = rec.transition!.mask;
    for (const p of ["bgColor", "textColor", "opacity", "scale", "scaleX", "scaleY", "rotate"] as const) {
      expect(mask & (1 << animBit(p))).not.toBe(0);
    }
    for (const p of ["width", "gap", "radius"] as const) {
      expect(mask & (1 << animBit(p))).toBe(0);
    }
  });
  test("duration/ease/delay WITHOUT a transition utility default to mask ALL (CSS initial transition-property: all)", () => {
    const rec = parseClassLiteral("w-20 duration-300")!;
    expect(rec.transition).toBeDefined();
    expect(rec.transition!.mask).toBe(TRANSITION_MASK_ALL);
    expect(rec.transition!.durMs).toBe(300);
    const d = parseClassLiteral("delay-100 ease-out w-20")!;
    expect(d.transition!.mask).toBe(TRANSITION_MASK_ALL);
    expect(d.transition!.delayMs).toBe(100);
    expect(d.transition!.easing).toBe(ENUMS.Easing.EaseOut);
  });
});

describe("all-or-nothing rejection [R]", () => {
  const rejected = [
    "Press Circle", // ordinary text
    "Count:", // colon, not a variant
    "logo.png", // asset name
    "p-2 unknown-utility", // one bad token poisons the literal
    "p-2 hover", // bare non-utility word
    "60", // bare number
    "p-", // dangling dash
    "bg-slate-901", // bad shade
    "text-3xl", // size not in the pinned slot list
    "w--4", // negative-ish garbage
    "p-[4rem]", // unsupported arbitrary unit
    "justify-evenly", // not in the v1 enum
    "focus:", // empty variant body
    "sm:p-2", // responsive variants unsupported
    "", // empty string
    "   ", // whitespace only
  ];
  for (const lit of rejected) {
    test(`rejects ${JSON.stringify(lit)}`, () => {
      expect(parseClassLiteral(lit)).toBeNull();
    });
  }
});

describe("compileClasses", () => {
  test("assigns ids, dedupes identical records, encodes styles.bin", () => {
    const c = compileClasses([
      "p-2 bg-white",
      "Press Circle", // ignored
      "bg-white p-2", // same record as the first -> same id
      "p-4",
    ]);
    expect(c.records.length).toBe(2);
    expect(c.ids["p-2 bg-white"]).toBe(c.ids["bg-white p-2"]);
    expect(c.ids["p-4"]).not.toBe(c.ids["p-2 bg-white"]);
    expect("Press Circle" in c.ids).toBeFalse();

    const decoded = decodeStyleTable(c.bin);
    expect(decoded.length).toBe(2);
    const m = new Map(decoded[c.ids["p-4"]].base!.map((p) => [p.prop, p.value]));
    expect(bitsF32(m.get(PROP.paddingT)!)).toBe(16);
  });
  test("always includes the default font slot", () => {
    const c = compileClasses(["p-2"]);
    expect(c.usedFontSlots).toContain(DEFAULT_FONT_SLOT);
  });
  test("used font slots follow the records", () => {
    const c = compileClasses(["text-2xl font-bold"]);
    expect(c.usedFontSlots).toContain(fontSlotFor(24, true));
  });
  test("f32 payloads round-trip exactly", () => {
    const c = compileClasses(["opacity-50"]);
    const rec = c.records[c.ids["opacity-50"]];
    expect(rec.base![0].value).toBe(f32Bits(0.5));
  });
});
