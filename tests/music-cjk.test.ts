import { expect, test } from "bun:test";
import { bootWorld, treeHasText } from "../hosts/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";
import { unpack } from "../framework/compiler/pak.ts";

test("ordinary Text renders changing runtime metadata and restores the list after glyph pressure", async () => {
  const build = Bun.spawnSync([process.execPath, "tools/build.ts", "music-cjk"], { stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
  const bundle = await Bun.file("dist/music-cjk-main.js").text();
  expect(bundle).not.toContain("気迫");
  expect(bundle).not.toContain("你好世界");
  const atlases = unpack(new Uint8Array(await Bun.file("dist/music-cjk-main.pak").arrayBuffer()))
    .filter(blob => blob.key.startsWith("ui:font."));
  const coverage = new Map<number, Set<number>>();
  for (const { data } of atlases) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const chars = new Set<number>();
    for (let i = 0; i < dv.getUint16(6, true); i++) if (dv.getUint16(20 + i * 8, true)) chars.add(dv.getUint32(16 + i * 8, true));
    coverage.set(data[12], chars);
  }
  const world = await bootWorld("music-cjk-main", 60);
  const step = (mask = 0) => { world.frame(mask); world.tick(); };
  const press = (mask: number) => { step(mask); step(); };
  step();
  const pixels = () => Bun.hash(world.render());
  const initial = pixels();
  expect(treeHasText(world.getTree(), "気迫")).toBe(true);
  expect(treeHasText(world.getTree(), "你好世界")).toBe(true);
  press(BTN.DOWN);
  expect(treeHasText(world.getTree(), "音乐/你好世界.mp3")).toBe(true);
  expect(pixels()).not.toEqual(initial);
  for (let i = 0; i < 6; i++) press(BTN.DOWN);
  expect(treeHasText(world.getTree(), "Music/01 - Sommarfågel.flac")).toBe(true);
  press(BTN.SQUARE);
  const stressA = pixels();
  const strings: string[] = [];
  const visit = (node: any) => { if (typeof node?.x === "string") strings.push(node.x); for (const c of node?.k ?? []) visit(c); };
  visit(world.getTree());
  const han = new Set(strings.join("").match(/[\u4e00-\u4eff]/gu));
  expect(han.size).toBe(192);
  for (const c of han) expect(coverage.get(2)!.has(c.codePointAt(0)!)).toBe(true);
  press(BTN.RTRIGGER);
  expect(pixels()).not.toEqual(stressA);
  press(BTN.RTRIGGER);
  expect(pixels()).toEqual(stressA);
  press(BTN.SQUARE);
  for (let i = 0; i < 7; i++) press(BTN.UP);
  expect(pixels()).toEqual(initial);
  expect((globalThis as any).offload).toBeUndefined();
}, 15000);
