// static/test/pipeline.test.ts — the whole host-side pipeline on the smoke
// game: evaluate -> compile -> model -> link, then PLAY THE STORY on the
// reference VM straight out of the linked script blob (fixups included).
// This is the game running with the consoles removed.

import { describe, expect, test } from "bun:test";
import { compileGame } from "../compiler/index.ts";
import { BLOB_KIND } from "../spec/isa.ts";
import { MAP_HEADER_SIZE, SCRIPT_NONE } from "../spec/rpg.ts";
import { RefVM } from "../vm/ref.ts";
import { AutoRpgHost } from "../vm/rpg-host.ts";

const ENTRY = new URL("./smoke/game.ts", import.meta.url).pathname;

describe("compile pipeline (smoke game)", () => {
  test("compiles for all three targets with coherent link output", async () => {
    for (const target of ["gba", "gb", "nes"] as const) {
      const out = await compileGame(ENTRY, target);
      const { linked, debug } = out;

      expect(linked.model.title).toBe("POCKET SMOKE");
      expect(linked.blobs[linked.scriptBlobIndex].kind).toBe(BLOB_KIND.SCRIPTS);
      expect(linked.scriptTable.length).toBe(5);
      expect(Object.keys(debug.maps)).toEqual(["office", "street"]);
      expect(debug.actors.guide).toEqual({ map: 0, slot: 0 });
      expect(debug.actors.intern).toEqual({ map: 0, slot: 1 });

      // map blob sanity: header fields match the model
      const officeBlob = linked.blobs[linked.mapBlobIndex[0]].bytes;
      expect(officeBlob[0]).toBe(10); // width
      expect(officeBlob[1]).toBe(6); // height
      expect(officeBlob[2]).toBe(2); // actors
      expect(officeBlob[3]).toBe(1); // warps
      expect(officeBlob[4]).toBe(1); // triggers
      expect(officeBlob[6] | (officeBlob[7] << 8)).not.toBe(SCRIPT_NONE); // onEnter
      expect(officeBlob.length).toBeGreaterThan(MAP_HEADER_SIZE + 60 + 8);

      // every text stream is addressable
      expect(linked.textTable.length).toBe(debug.texts.length);
      for (const t of linked.textTable) {
        const blob = linked.blobs[t.blob];
        expect(blob.kind).toBe(BLOB_KIND.TEXT);
        expect(t.off).toBeLessThan(blob.bytes.length);
      }
    }
  });

  test("warp fixups point at real entrances after patching", async () => {
    const { linked, debug } = await compileGame(ENTRY, "gba");
    const code = linked.blobs[linked.scriptBlobIndex].bytes;
    // InternTalk ends with WARP street:door -> map 1, x 5, y 2, dir 0
    expect(linked.ctx.warpFixups).toHaveLength(1);
    const at = linked.ctx.warpFixups[0].at;
    expect(code[at]).toBe(debug.maps.street);
    expect(code[at + 1]).toBe(5);
    expect(code[at + 2]).toBe(2);
  });

  test("the story plays to completion on the reference VM", async () => {
    const { linked, debug } = await compileGame(ENTRY, "gba");
    const code = linked.blobs[linked.scriptBlobIndex].bytes;

    // Playthrough: talk to the guide, pick Spar, always Strike.
    const host = new AutoRpgHost(Array(24).fill(0));
    const vm = new RefVM(code, linked.scriptTable, host);
    host.play(vm, debug.scripts.GuideTalk);

    expect(vm.status).toBe("done");
    expect(vm.getFlag(debug.flags.beat_guide)).toBe(1);
    expect(vm.getVar(debug.vars.sub_calls)).toBe(1); // s.call(Fanfare)
    expect(vm.getVar(debug.vars.cheers)).toBe(3); // macro unroll
    expect(vm.getVar(debug.vars.foe)).toBeLessThanOrEqual(0);
    expect(vm.getVar(debug.vars.hp)).toBeGreaterThan(0);
    // The win line interpolates remaining HP via a FMT slot.
    const winPage = host.events
      .filter((e) => e.kind === "say")
      .map((e) => debug.texts[(e as { textId: number }).textId])
      .find((t) => t.includes("You win"));
    expect(winPage).toContain("{v60}");

    // Re-talk takes the flag branch and stays short.
    const host2 = new AutoRpgHost([]);
    const vm2 = new RefVM(code, linked.scriptTable, host2);
    vm2.flags[debug.flags.beat_guide] = 1;
    host2.play(vm2, debug.scripts.GuideTalk);
    expect(host2.events.filter((e) => e.kind === "say")).toHaveLength(1);
  });

  test("gb pagination differs from gba (narrower box)", async () => {
    const gba = await compileGame(ENTRY, "gba");
    const gb = await compileGame(ENTRY, "gb");
    const gbaLines = gba.debug.texts.flatMap((t) => t.split("\n"));
    const gbLines = gb.debug.texts.flatMap((t) => t.split("\n"));
    expect(Math.max(...gbaLines.map((l) => l.length))).toBeLessThanOrEqual(28);
    expect(Math.max(...gbLines.map((l) => l.length))).toBeLessThanOrEqual(18);
  });
});
