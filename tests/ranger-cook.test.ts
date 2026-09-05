// tests/ranger-cook.test.ts — M1 cook acceptance (§4, §7, §10 M1).
//
// Contract: bun test tests/ranger-cook.test.ts
// SWF-less by default; when RANGER_SWF exists, deterministic generation is
// verified twice plus PNG pixel-hash stability. Asserts ID stability,
// two-run byte equality, exact provenance headers, schemas, the tools/
// import ban, and silent-first (IN_SCOPE_SOUNDS=[]).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CookScopeError,
  IN_SCOPE_SOUNDS,
  LINKAGE,
  OUT_OF_SCOPE_IDS,
  validateCookScope,
} from "../apps/ranger/scope.ts";
import {
  STABLE_IDS,
  isBitmapId,
  isFontId,
  isSoundId,
  isSpriteBaseId,
  isSpritePieceFile,
  isSpriteSheetFile,
  stableSheetFiles,
} from "../tools/ranger-cook/ids.ts";
import {
  GENERATED_BY,
  SWF_REF,
  checkSwfPath,
  cookAppDir,
  readPngSize,
} from "../tools/ranger-cook/cook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "apps/ranger");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

interface ExportAsset {
  name: string;
  charId: number;
}

/** FNV-1a 32-bit over bytes (pixel-hash stability, no dependencies). */
function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

describe("ranger cook stable IDs (§4.2)", () => {
  test("STABLE_IDS exhaustively covers the selected LINKAGE", () => {
    const inv = JSON.parse(read("apps/ranger/m0-inventory.json")) as {
      exportAssets: ExportAsset[];
    };
    const charByName = new Map(inv.exportAssets.map((a) => [a.name, a.charId]));
    expect(STABLE_IDS.length).toBe(Object.keys(LINKAGE).length);
    expect(STABLE_IDS.length).toBe(20);
    const linkages = new Set(Object.keys(LINKAGE));
    for (const entry of STABLE_IDS) {
      expect(linkages.has(entry.linkage)).toBe(true);
      expect(entry.base).toBe(`v${entry.characterId}`);
      expect(entry.base).toBe(LINKAGE[entry.linkage]);
      expect(isSpriteBaseId(entry.base)).toBe(true);
      // CharacterId matches the M0 exportAssets evidence.
      expect(charByName.get(entry.linkage)).toBe(entry.characterId);
    }
  });

  test("piece counts match locally evidenced rasters", () => {
    const pngs = readdirSync(APP).filter((f) => f.endsWith(".png"));
    for (const entry of STABLE_IDS) {
      const expected = stableSheetFiles(entry);
      expect(expected[0]).toBe(`${entry.base}.png`);
      expect(expected.length).toBe(entry.pieces + 1);
      for (let i = 0; i < entry.pieces; i++) {
        const file = `${entry.base}p${i}.png`;
        expect(isSpritePieceFile(file)).toBe(true);
        expect(pngs.includes(file)).toBe(true);
      }
    }
    // Pinned local evidence: ef_hit1 has base + 4 pieces, tobi1 base only.
    const efHit1 = STABLE_IDS.find((e) => e.linkage === "ef_hit1")!;
    expect(efHit1.pieces).toBe(4);
    expect(pngs.includes("v370.png")).toBe(true);
    const tobi1 = STABLE_IDS.find((e) => e.linkage === "tobi1")!;
    expect(tobi1.pieces).toBe(0);
    expect(pngs.includes("v185.png")).toBe(true);
  });

  test("stable-ID grammar spot pins", () => {
    expect(isSpriteSheetFile("v328.png")).toBe(true);
    expect(isSpriteSheetFile("v1153p0.png")).toBe(true);
    expect(isSpriteSheetFile("V328.png")).toBe(false);
    expect(isSpriteSheetFile("v328p0.jpg")).toBe(false);
    expect(isBitmapId("b1409")).toBe(true);
    expect(isSoundId("s198")).toBe(true);
    expect(isSoundId("s12_hit")).toBe(true);
    expect(isFontId("f4_12")).toBe(true);
    expect(isSoundId("se_101")).toBe(false);
  });
});

describe("ranger cook scope gate (fail-hard, §10 M0/M1)", () => {
  test("in-scope LINKAGE cooks; out-of-scope and unknown IDs fail", () => {
    validateCookScope(Object.keys(LINKAGE));
    for (const id of OUT_OF_SCOPE_IDS) {
      let err: unknown = null;
      try {
        validateCookScope([id]);
      } catch (e) {
        err = e;
      }
      expect(err instanceof CookScopeError).toBe(true);
    }
    let unknown: unknown = null;
    try {
      validateCookScope(["__not_a_linkage__"]);
    } catch (e) {
      unknown = e;
    }
    expect(unknown instanceof CookScopeError).toBe(true);
    expect((unknown as CookScopeError).scopeClass).toBe("unknown");
  });

  test("cookAppDir rejects unknown linkage IDs", () => {
    let err: unknown = null;
    try {
      cookAppDir(APP, ["toujouS10", ...Object.keys(LINKAGE)], false);
    } catch (e) {
      err = e;
    }
    expect(err instanceof CookScopeError).toBe(true);
    let unknown: unknown = null;
    try {
      cookAppDir(APP, ["__not_a_linkage__"], false);
    } catch (e) {
      unknown = e;
    }
    expect(unknown instanceof CookScopeError).toBe(true);
  });
});

describe("ranger cook determinism + provenance (§7)", () => {
  test("two generations are byte-identical with exact headers", () => {
    const before: Record<string, string> = {};
    for (const n of ["anim.json", "images.json", "sprites.json", "sheets.ts"]) {
      before[n] = readFileSync(join(APP, n), "utf8");
    }
    const run1 = cookAppDir(APP, Object.keys(LINKAGE), true);
    const mid: Record<string, string> = {};
    for (const n of ["anim.json", "images.json", "sprites.json", "sheets.ts"]) {
      mid[n] = readFileSync(join(APP, n), "utf8");
    }
    const run2 = cookAppDir(APP, Object.keys(LINKAGE), true);
    const after: Record<string, string> = {};
    for (const n of ["anim.json", "images.json", "sprites.json", "sheets.ts"]) {
      after[n] = readFileSync(join(APP, n), "utf8");
    }
    expect(mid).toEqual(after);
    expect(before).toEqual(after);
    expect(run1.summary.sheets).toBeGreaterThan(0);
    expect(run1.summary.variants).toBeGreaterThan(0);

    for (const n of ["anim.json", "images.json", "sprites.json"]) {
      const doc = JSON.parse(after[n]) as Record<string, unknown>;
      expect(doc["_generatedBy"]).toBe(GENERATED_BY);
      expect(doc["_generatedBy"]).toBe("tools/ranger-cook/cook.ts");
      expect(doc["_swfRef"]).toBe(SWF_REF);
      expect(doc["_swfRef"]).toBe("swf:fws6:root19f");
      expect(doc["_doNotEdit"]).toBe(true);
    }
    const sheetsTs = after["sheets.ts"];
    expect(
      sheetsTs.startsWith("// auto-generated by tools/ranger-cook/cook.ts — do not edit.\n"),
    ).toBe(true);
    expect(run2.summary.bytes).toEqual(run1.summary.bytes);
  });

  test("generated schemas hang together (sheets/sprites/images/names)", () => {
    const anim = JSON.parse(read("apps/ranger/anim.json")) as {
      variants: Record<string, unknown>;
      sheets: Record<string, { cols: number; rows: number; frames: number }>;
      fighters: Record<string, unknown>;
    };
    const sprites = JSON.parse(read("apps/ranger/sprites.json")) as Record<
      string,
      { cols: number; rows: number; frames: number; step: number }
    >;
    const images = JSON.parse(read("apps/ranger/images.json")) as Record<
      string,
      { w: number; h: number; src: string }
    >;
    const sheetsTs = read("apps/ranger/sheets.ts");
    const names = [...sheetsTs.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(Object.keys(anim.variants).length).toBeGreaterThan(0);
    expect(Object.keys(anim.fighters).length).toBeGreaterThan(0);
    // Sheet key sets agree across all four artifacts (provenance keys are
    // contract headers, not entries — consumers look up names only).
    const spriteKeys = Object.keys(sprites).filter((k) => !k.startsWith("_"));
    const imageEntries = Object.entries(images).filter(([k]) => !k.startsWith("_"));
    expect(new Set(spriteKeys)).toEqual(new Set(Object.keys(anim.sheets)));
    expect(new Set(names)).toEqual(new Set(Object.keys(anim.sheets)));
    for (const [name, g] of Object.entries(anim.sheets)) {
      expect(g.frames).toBe(g.cols * g.rows);
      expect(sprites[name].frames).toBe(g.frames);
      expect(sprites[name].step).toBeGreaterThan(0);
    }
    // Image dims match the local PNG IHDR scan.
    for (const [name, meta] of imageEntries) {
      expect(existsSync(join(APP, name))).toBe(true);
      const size = readPngSize(join(APP, name));
      expect(meta.w).toBe(size.w);
      expect(meta.h).toBe(size.h);
      expect(meta.src).toBe(name);
    }
  });

  test("RANGER_SWF branch: generation stays deterministic, PNGs stable", () => {
    const swf = process.env["RANGER_SWF"];
    if (!swf || !existsSync(swf)) return;
    checkSwfPath(swf);
    const hashPngs = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const f of readdirSync(APP).filter((x) => x.endsWith(".png")).sort()) {
        out[f] = fnv1a(readFileSync(join(APP, f)));
      }
      return out;
    };
    const files = ["anim.json", "images.json", "sprites.json", "sheets.ts"];
    cookAppDir(APP, Object.keys(LINKAGE), true);
    const first = Object.fromEntries(
      files.map((n) => [n, readFileSync(join(APP, n), "utf8")]),
    );
    const hashes1 = hashPngs();
    cookAppDir(APP, Object.keys(LINKAGE), true);
    const second = Object.fromEntries(
      files.map((n) => [n, readFileSync(join(APP, n), "utf8")]),
    );
    expect(second).toEqual(first);
    expect(hashPngs()).toEqual(hashes1);
  });
});

describe("ranger pak + silent-first (§4.6, §9)", () => {
  test("pak.json is a skeleton over local generated paths only", () => {
    const pak = JSON.parse(read("apps/ranger/pak.json")) as unknown;
    expect(Array.isArray(pak)).toBe(true);
    for (const e of pak as { key: string; file: string }[]) {
      expect(e.key.startsWith("ui:") || e.key.startsWith("audio:")).toBe(true);
      expect(e.file.startsWith("tools/")).toBe(false);
      expect(e.file.startsWith("/")).toBe(false);
      expect(e.file.includes("..")).toBe(false);
      expect(existsSync(join(APP, e.file))).toBe(true);
      expect(e.key.startsWith("audio:wav.")).toBe(false);
    }
  });

  test("M1 is silent-first: no in-scope sounds, no audio requirement", () => {
    expect([...IN_SCOPE_SOUNDS]).toEqual([]);
    const pocket = JSON.parse(read("apps/ranger/pocket.json")) as {
      engine: { capabilities: { requires: string[] } };
    };
    expect(pocket.engine.capabilities.requires).toContain("input.buttons");
    expect(pocket.engine.capabilities.requires).toContain("text.glyphs.baked");
    expect(pocket.engine.capabilities.requires).not.toContain("audio.pcm");
  });

  test("runtime apps/ranger never imports tools/", () => {
    // Import-graph ban (§7.3): no import/require of tools/ paths. Plain
    // prose mentions (e.g. M0 scope.ts citing the scan script) are fine.
    const importTools = /(?:from\s+["']|import\s*\(\s*["']|require\s*\(\s*["'])[^"']*tools\//;
    const owned = [
      "apps/ranger/scope.ts",
      "apps/ranger/sim/fixed.ts",
      "apps/ranger/sim/scheduler.ts",
      "apps/ranger/sim/rng.ts",
      "apps/ranger/sim/input.ts",
      "apps/ranger/sim/step.ts",
    ];
    for (const rel of owned) {
      expect(existsSync(join(ROOT, rel))).toBe(true);
      const src = read(rel);
      expect(importTools.test(src)).toBe(false);
    }
  });

  test("cook carries no hardcoded operator SWF paths", () => {
    for (const rel of ["tools/ranger-cook/cook.ts", "tools/ranger-cook/ids.ts"]) {
      const src = read(rel);
      expect(/[A-Za-z]:\\/.test(src)).toBe(false);
      expect(src.includes("/Users/")).toBe(false);
      expect(src.includes("/home/")).toBe(false);
      expect(/\.swf\b/.test(src)).toBe(false);
    }
  });
});
