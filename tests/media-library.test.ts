import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMediaDownloadServer, downloadHeader, mediaCRC } from "../tools/media-download.ts";
import { mediaLibrary, mediaPlayer } from "../framework/src/media.ts";

const directory = mkdtempSync(join(tmpdir(), "pocket-media-library-")), sd = join(directory, "sd"), harness = join(directory, "worker");
beforeAll(() => {
  const result = Bun.spawnSync(["cc", "-std=gnu11", "-O2", "-pthread", "-Wall", "-Wextra", "-I", "tests/fixtures/media-library", "-I", "hosts/3ds/src",
    `-DPOCKETJS_MEDIA_ROOT="${sd}"`, "tests/fixtures/media-library/harness.c", "hosts/3ds/src/media_library.c", "-o", harness]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("native storage worker verifies transfer, exports captions, reopens offline and deletes", async () => {
  const vtt = Buffer.from(`WEBVTT\n\n${"00:00:01.000 --> 00:00:02.000\nこんにちは 世界 & captions\n\n".repeat(8000)}`);
  const header = downloadHeader({ mediaBytes: 0, indexBytes: 0, captionBytes: vtt.length, durationMs: 120000, crc: mediaCRC(vtt) ^ 0xffffffff, title: '日本語 "captions"', language: "ja" });
  const path = join(directory, "captions.pkd"), bytes = Buffer.concat([header, vtt]); writeFileSync(path, bytes);
  const server = await createMediaDownloadServer({ advertiseHost: "127.0.0.1" });
  try {
    const source = await server.publish(path), process = Bun.spawn([harness, String(source.port), source.token, "captions", "keep"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(process.stdout).text();
    expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
    const [before, status, entries, reboot] = output.trim().split("\n").map(line => JSON.parse(line));
    expect(before).toEqual([]); expect(status.phase).toBe("complete"); expect(status.receivedBytes).toBe(bytes.length);
    expect(entries).toEqual(reboot); expect(entries[0].title).toBe('日本語 "captions"'); expect(entries[0].captions).toBe(true);
    expect(readFileSync(join(sd, "captions.pkd"))).toEqual(bytes); expect(readFileSync(join(sd, "captions.vtt"))).toEqual(vtt);
    expect(readdirSync(sd).some(name => name.endsWith(".part"))).toBe(false);
    const retry = await server.publish(path), remove = Bun.spawn([harness, String(retry.port), retry.token, "captions", "remove"], { stdout: "pipe", stderr: "pipe" });
    const lines = (await new Response(remove.stdout).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(await remove.exited).toBe(0); expect(lines[1].phase).toBe("error"); expect(lines[1].error).toContain("Already saved");
    expect(lines.at(-1)).toEqual([]); expect(readdirSync(sd)).toEqual([]);
  } finally { server.close(); }
}, 30000);

test("corruption, truncation, cancellation and failed SD writes never publish partial files", async () => {
  for (const failure of ["crc", "truncated", "cancel", "storage"]) {
    const payload = Buffer.from("WEBVTT\n\n".repeat(5000));
    const header = downloadHeader({ mediaBytes: 0, indexBytes: 0, captionBytes: payload.length, durationMs: 1000,
      crc: (mediaCRC(payload) ^ 0xffffffff) + (failure === "crc" ? 1 : 0), title: failure, language: "en" });
    const path = join(directory, `${failure}.pkd`); writeFileSync(path, Buffer.concat([header, failure === "truncated" ? payload.subarray(0, 40) : payload]));
    if (failure === "storage") mkdirSync(join(sd, `${failure}.part`));
    const server = await createMediaDownloadServer({ advertiseHost: "127.0.0.1" });
    try {
      const source = await server.publish(path), process = Bun.spawn([harness, String(source.port), source.token, failure, failure === "cancel" ? "cancel" : "keep"], { stdout: "pipe", stderr: "pipe" });
      const lines = (await new Response(process.stdout).text()).trim().split("\n").map(line => JSON.parse(line));
      expect(await process.exited, await new Response(process.stderr).text()).toBe(0);
      expect(lines[1].phase).toBe(failure === "cancel" ? "cancelled" : "error");
      expect(lines[2]).toEqual([]); expect(lines[3]).toEqual([]);
      expect(readdirSync(sd)).toEqual([]);
    } finally { server.close(); }
  }
}, 30000);

test("local media APIs reject paths and nonfinite seeks before native handoff", () => {
  const calls: unknown[] = [], ops = { open: () => true, close() {}, paused() {}, volume() {}, texture: () => 1, status: () => "{}", openLocal: (...args: unknown[]) => { calls.push(args); return true; } };
  expect(mediaPlayer(ops).open({ file: "movie_01", positionMs: 1234 })).toBe(true);
  for (const file of ["../movie", "sdmc:/movie", "", "a".repeat(65)]) expect(() => mediaPlayer(ops).open({ file })).toThrow();
  expect(() => mediaPlayer(ops).open({ file: "movie", positionMs: NaN })).toThrow(); expect(calls).toEqual([["movie_01", 1234]]);
  expect(() => mediaLibrary({} as any).remove("../movie")).toThrow();
});
