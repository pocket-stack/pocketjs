// test/youtube-sim.test.ts — Pocket YouTube (demos/youtube) under the sim.
//
// The host service is a real process on a real cable, so the sim injects a
// canned host through __pocketEffectDriver (the host-override slot the
// effect shell reserves for exactly this) and drives the full journey:
// connect handshake -> OSK search -> host-rendered result cards -> play ->
// pause. Titles inside cards are images (host-side rendering is the point),
// so tree assertions ride the player HUD text, the status line and the
// phase furniture — all device text.

import { describe, expect, test } from "bun:test";
import {
  bootWorld,
  fnv1a,
  scriptToMasks,
  treeHasText,
  type ScriptEvent,
} from "../host-sim/sim.ts";
import { BTN } from "../spec/spec.ts";
import type { HostMsg, ResultItem } from "../demos/youtube/protocol.ts";

const ITEMS: ResultItem[] = [
  {
    videoId: "vapor01",
    title: "Vue Vapor on a PSP",
    channel: "pocket-stack",
    durationS: 754,
    views: 120000,
    card: "thumbs/vapor01.img",
  },
  {
    videoId: "vapor02",
    title: "第二个视频",
    channel: "频道",
    durationS: 61,
    views: 42,
    card: "thumbs/vapor02.img",
  },
];

type Cmd = { kind: string; id: number; payload: unknown };

/** The canned Mac: answers everything instantly (deliveries still apply at
 *  the next frame boundary — the shell owns the timing). */
function cannedHost() {
  const seen: string[] = [];
  const driver = (cmd: Cmd, deliver: (r: unknown) => void) => {
    seen.push(cmd.kind);
    const id = cmd.id;
    switch (cmd.kind) {
      case "yt/hello":
        deliver({ t: "ready", id } satisfies HostMsg);
        break;
      case "yt/search":
        deliver({ t: "results", id, items: ITEMS } satisfies HostMsg);
        break;
      case "yt/play":
        deliver({
          t: "playing",
          id,
          videoId: (cmd.payload as { videoId: string }).videoId,
          title: "Vue Vapor on a PSP",
          durationS: 754,
          fps: 15,
          stream: "media/play-1.pkst",
          position: 0,
        } satisfies HostMsg);
        break;
      default:
        deliver({ t: "state", id, playing: cmd.kind === "yt/resume", position: 0 } satisfies HostMsg);
    }
  };
  return { driver, seen };
}

async function run(seconds: number, script: ScriptEvent[], driver?: (cmd: Cmd, deliver: (r: unknown) => void) => void) {
  const hz = 60;
  const frames = seconds * hz;
  const world = await bootWorld("youtube-main", hz, { __pocketEffectDriver: driver });
  const { masks, analogs } = scriptToMasks(script, hz, frames);
  const hashes: string[] = [];
  for (let f = 0; f < frames; f++) {
    world.frame(masks[f], analogs[f]);
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick();
    hashes.push(fnv1a(world.render()));
  }
  return { hashes, tree: world.getTree(), effects: world.effects.slice() };
}

// Journey: browse arrives via the handshake, △ opens the OSK, type "q"
// (DOWN to the letter row, ○ to press), START searches, ○ plays the
// focused result, ○ pauses playback.
const JOURNEY: ScriptEvent[] = [
  { at: 1.0, press: BTN.TRIANGLE }, // open the keyboard
  { at: 1.5, press: BTN.DOWN }, //    focus 'q'
  { at: 2.0, press: BTN.CIRCLE }, //  type it
  { at: 2.5, press: BTN.START }, //   close + search
  { at: 3.5, press: BTN.CIRCLE }, //  play the focused (first) result
  { at: 4.5, press: BTN.CIRCLE }, //  pause
];

const canned = cannedHost();
const main = await run(6, JOURNEY, canned.driver);

describe("the journey happened", () => {
  test("handshake, search, play, pause — in order", () => {
    const kinds = main.effects.filter((e) => e.t === "command").map((e) => e.kind);
    expect(kinds).toEqual(["yt/hello", "yt/search", "yt/play", "yt/pause"]);
  });

  test("the player HUD shows the host's title and the pause state", () => {
    expect(treeHasText(main.tree, "Vue Vapor on a PSP")).toBe(true);
    expect(treeHasText(main.tree, "PAUSED")).toBe(true);
    expect(treeHasText(main.tree, "0:00 / 12:34")).toBe(true);
    expect(treeHasText(main.tree, "× BACK")).toBe(true);
  });
});

describe("determinism", () => {
  test("same tape, same world", async () => {
    const again = await run(6, JOURNEY, cannedHost().driver);
    expect(again.hashes).toEqual(main.hashes);
    expect(again.effects).toEqual(main.effects);
  }, 30000);
});

describe("connect phase", () => {
  test("an offline host keeps the connect screen up and retries hello", async () => {
    // A driver that answers nothing: commands hang forever (worse than an
    // error — the app must not deadlock on it).
    const silent = await run(5, [], () => {});
    expect(treeHasText(silent.tree, "CONNECT USB")).toBe(true);
    const hellos = silent.effects.filter((e) => e.t === "command" && e.kind === "yt/hello");
    expect(hellos.length).toBeGreaterThanOrEqual(2); // the 2 s retry pump
  }, 30000);

  test("results render the browse chrome (cards load out-of-band)", async () => {
    const c = cannedHost();
    const browse = await run(4, JOURNEY.slice(0, 4), c.driver);
    expect(treeHasText(browse.tree, "1/2")).toBe(true); // focus counter
    expect(treeHasText(browse.tree, "○ PLAY")).toBe(true);
  }, 30000);
});
