// test/youtube-host.test.ts — the Pocket YouTube Mac host service's parts:
// the CLUT8 quantizer, the IMG-entry encoder, the .pkst ring writer (against
// its own reader AND a committed golden the Rust core parses in cargo tests
// — the cross-language contract), the card text layout, and the yt-dlp
// JSON parsing (injected runner; no network anywhere in this file).

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { packbitsDecode, PSM } from "../spec/spec.ts";
import { paletteBytes, quantize } from "../demos/youtube/host/quant.ts";
import { encodeImgT8 } from "../demos/youtube/host/img.ts";
import { readStream, StreamWriter, type StreamGeometry } from "../demos/youtube/host/ring.ts";
import { cardFont, CARD_H, CARD_VISIBLE_W, CARD_W, fitLines, fmtDuration, renderCard } from "../demos/youtube/host/cards.ts";
import { search, resolve as resolveVideo, type Runner } from "../demos/youtube/host/yt.ts";

const tmp = mkdtempSync(join(tmpdir(), "pocket-youtube-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// quantizer
// ---------------------------------------------------------------------------

function solid(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

describe("quantize", () => {
  test("a solid image is one palette entry, indices all zero", () => {
    const { palette, indices } = quantize(solid(16, 16, 200, 40, 40), 16, 16);
    expect(new Set(indices).size).toBe(1);
    const p = palette[indices[0]];
    // Bin centers put the recovered channel within the 8-value bucket.
    expect(Math.abs((p & 255) - 200)).toBeLessThanOrEqual(4);
    expect(Math.abs(((p >>> 8) & 255) - 40)).toBeLessThanOrEqual(4);
    expect(p >>> 24).toBe(0xff);
  });

  test("deterministic: same pixels, same bytes (dither included)", () => {
    const rgba = new Uint8Array(64 * 32 * 4);
    for (let i = 0; i < 64 * 32; i++) {
      rgba[i * 4] = (i * 7) & 255;
      rgba[i * 4 + 1] = (i * 13) & 255;
      rgba[i * 4 + 2] = (i * 29) & 255;
      rgba[i * 4 + 3] = 255;
    }
    const a = quantize(rgba, 64, 32);
    const b = quantize(rgba, 64, 32);
    expect(b.palette).toEqual(a.palette);
    expect(b.indices).toEqual(a.indices);
  });

  test("a two-color image quantizes losslessly", () => {
    const rgba = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 256; i++) {
      const white = i % 2 === 0;
      rgba[i * 4] = white ? 252 : 4;
      rgba[i * 4 + 1] = white ? 252 : 4;
      rgba[i * 4 + 2] = white ? 252 : 4;
      rgba[i * 4 + 3] = 255;
    }
    const { palette, indices } = quantize(rgba, 16, 16, { dither: false });
    expect(new Set(indices).size).toBe(2);
    const lum = (i: number) => (palette[i] & 255) + ((palette[i] >>> 8) & 255);
    expect(lum(indices[0])).toBeGreaterThan(lum(indices[1]));
  });
});

// ---------------------------------------------------------------------------
// IMG entry
// ---------------------------------------------------------------------------

test("encodeImgT8 round-trips through the spec RLE", () => {
  const rgba = solid(32, 16, 20, 120, 220);
  const blob = encodeImgT8(rgba, 32, 16);
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  expect(dv.getUint16(0, true)).toBe(32);
  expect(dv.getUint16(2, true)).toBe(16);
  expect(blob[4]).toBe(PSM.PSM_T8);
  expect(blob[5] & 2).toBe(2); // linear
  expect(blob[5] & 1).toBe(1); // a solid image certainly RLE-compresses
  const decoded = packbitsDecode(blob.subarray(8 + 1024), 32 * 16);
  expect(decoded).not.toBeNull();
  expect(new Set(decoded!).size).toBe(1);
});

// ---------------------------------------------------------------------------
// .pkst ring
// ---------------------------------------------------------------------------

const GEO: StreamGeometry = {
  w: 16,
  h: 16,
  fpsNum: 15,
  fpsDen: 1,
  slotCount: 4,
  sampleRate: 22050,
  channels: 2,
  chunkFrames: 64,
  chunkCount: 4,
  totalFrames: 30,
};

function pal(seed: number): Uint8Array {
  const p = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) p[i] = (i + seed) & 255;
  return p;
}

describe(".pkst ring", () => {
  test("writer/reader round trip, ring wrap keeps the newest lap", () => {
    const path = join(tmp, "roundtrip.pkst");
    const w = new StreamWriter(path, GEO);
    const idx = new Uint8Array(16 * 16);
    for (let f = 0; f < 6; f++) {
      idx.fill(f);
      w.writeFrame(f * 2, pal(f), idx); // sparse frameIndex: host may skip
    }
    const pcm = new Int16Array(64 * 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i - 64;
    w.writeAudio(0, pcm);
    w.writeAudio(64, pcm);
    w.bumpEpoch();
    w.markEnded();
    w.close();

    const d = readStream(path);
    expect(d.epoch).toBe(1);
    expect(d.ended).toBe(true);
    expect(d.videoLatest).toBe(6);
    expect(d.audioLatest).toBe(2);
    // slotCount 4: only seqs 3..6 survive the wrap.
    expect(d.frames.map((f) => f.seq)).toEqual([3, 4, 5, 6]);
    expect(d.frames.map((f) => f.frameIndex)).toEqual([4, 6, 8, 10]);
    expect(d.frames[3].indices[0]).toBe(5);
    expect(d.frames[3].palette).toEqual(pal(5));
    expect(d.chunks.map((c) => c.startFrame)).toEqual([0, 64]);
    expect(d.chunks[1].pcm[0]).toBe(-64);
  });

  test("geometry is validated up front", () => {
    expect(() => new StreamWriter(join(tmp, "bad.pkst"), { ...GEO, w: 20 })).toThrow(/pow2/);
    expect(() => new StreamWriter(join(tmp, "bad.pkst"), { ...GEO, slotCount: 1 })).toThrow(/>= 2/);
  });
});

// ---------------------------------------------------------------------------
// The cross-language golden: TS writes it, cargo test parses it
// (core/src/tests.rs stream_golden_fixture_parses). UPDATE=1 refreshes.
// ---------------------------------------------------------------------------

test(".pkst golden matches the committed fixture", () => {
  const path = join(tmp, "golden.pkst");
  const w = new StreamWriter(path, GEO);
  const idx = new Uint8Array(16 * 16);
  for (let i = 0; i < idx.length; i++) idx[i] = i & 255;
  w.writeFrame(0, pal(1), idx);
  for (let i = 0; i < idx.length; i++) idx[i] = (i * 3) & 255;
  w.writeFrame(1, pal(2), idx);
  const pcm = new Int16Array(64 * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i * 3 - 64;
  w.writeAudio(0, pcm);
  w.close();
  const bytes = readFileSync(path);
  const fixture = new URL("./fixtures/youtube-golden.pkst", import.meta.url).pathname;
  if (process.env.UPDATE === "1" || !existsSync(fixture)) {
    writeFileSync(fixture, bytes);
  }
  expect(Buffer.compare(bytes, readFileSync(fixture))).toBe(
    0,
    // On mismatch: the writer's byte layout changed — bump STREAM_VERSION or
    // fix the regression, then UPDATE=1 bun test test/youtube-host.test.ts
  );
});

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------

describe("cards", () => {
  test("fitLines wraps and ellipsizes inside the budget", async () => {
    await cardFont();
    const lines = fitLines(
      "The quick brown fox jumps over the lazy dog and keeps going for a while",
      13,
      132,
      2,
    );
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(fitLines("short", 13, 132, 2)).toEqual(["short"]);
  });

  test("renderCard paints thumbnail area and text ink", async () => {
    const card = await renderCard({
      title: "Vue Vapor on a PSP",
      channel: "pocket-stack",
      durationS: 754,
      views: 123456,
      thumbRgba: solid(116, 64, 40, 80, 160),
    });
    expect(card.length).toBe(CARD_W * CARD_H * 4);
    // Thumb pixel landed.
    expect(card[(10 * CARD_W + 10) * 4 + 2]).toBe(160);
    // Some ink brighter than the background exists in the text region.
    let bright = 0;
    for (let y = 0; y < CARD_H; y++) {
      for (let x = 124; x < CARD_VISIBLE_W; x++) {
        if (card[(y * CARD_W + x) * 4] > 0x80) bright++;
      }
    }
    expect(bright).toBeGreaterThan(50);
    // The duration badge darkened the thumb's bottom-right corner.
    expect(card[(56 * CARD_W + 110) * 4 + 2]).toBeLessThan(160);
    // The chevron leaves ink near the right edge of the VISIBLE row.
    let chevron = 0;
    for (let y = 24; y < 44; y++) {
      for (let x = CARD_VISIBLE_W - 20; x < CARD_VISIBLE_W; x++) {
        if (card[(y * CARD_W + x) * 4] > 0x40) chevron++;
      }
    }
    expect(chevron).toBeGreaterThan(4);
    // The pow2 tail (clipped on device) stays flat background.
    for (let y = 0; y < CARD_H; y += 7) {
      expect(card[(y * CARD_W + CARD_VISIBLE_W + 20) * 4]).toBe(0x14);
    }
  });

  test("fmtDuration covers m:ss and h:mm:ss", () => {
    expect(fmtDuration(754)).toBe("12:34");
    expect(fmtDuration(3999)).toBe("1:06:39");
  });
});

// ---------------------------------------------------------------------------
// yt-dlp parsing (injected runner)
// ---------------------------------------------------------------------------

describe("yt-dlp adapter", () => {
  test("search parses flat-playlist lines and skips junk", async () => {
    const run: Runner = async () => ({
      ok: true,
      stdout:
        JSON.stringify({ id: "abc123", title: "视频一", channel: "频道", duration: 61, view_count: 1000 }) +
        "\nnot json\n" +
        JSON.stringify({ id: "def456", title: "Two", uploader: "Chan", duration: null }) +
        "\n",
      stderr: "",
    });
    const items = await search("q", 2, run);
    expect(items).toEqual([
      { videoId: "abc123", title: "视频一", channel: "频道", durationS: 61, views: 1000 },
      { videoId: "def456", title: "Two", channel: "Chan", durationS: 0, views: 0 },
    ]);
  });

  test("resolve surfaces the direct url and errors loudly without one", async () => {
    const ok: Runner = async () => ({
      ok: true,
      stdout: JSON.stringify({ url: "https://cdn/x", title: "T", channel: "C", duration: 9.7, thumbnail: "https://i/x" }),
      stderr: "",
    });
    const r = await resolveVideo("abc", ok);
    expect(r.url).toBe("https://cdn/x");
    expect(r.durationS).toBe(10);
    const noUrl: Runner = async () => ({ ok: true, stdout: "{}", stderr: "" });
    expect(resolveVideo("abc", noUrl)).rejects.toThrow(/no direct url/);
    const failed: Runner = async () => ({ ok: false, stdout: "", stderr: "boom" });
    expect(search("q", 1, failed)).rejects.toThrow(/boom/);
  });
});
