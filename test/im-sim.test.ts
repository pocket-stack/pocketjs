// test/im-sim.test.ts — Pocket Talk (demos/im) under the deterministic sim.
//
// The IM demo stacks everything that flakes in ordinary UI tests: a long-poll
// sync loop, staged delivery/read receipts, typing indicators, ambient pushes
// into background conversations, measurement-driven word wrap, a virtual
// scroll window, history pagination with a scroll rebase, and an on-screen
// keyboard journey that types a message key by key. All of it rides the
// virtual clock, so the whole thing replays byte-exact — and the DevTools
// tree probe can assert IM semantics (windowing, receipts, offline contacts)
// as content, not pixels.

import { describe, expect, test } from "bun:test";
import { runScenario, treeHasText, type Trace } from "../host-sim/sim.ts";
import { BTN } from "../spec/spec.ts";

// ---------------------------------------------------------------------------
// Journey A — open MAYA, scroll history, jump back, type "yo!", send, get the
// full receipt/typing/reply choreography. Times on the 0.5 s grid.
// ---------------------------------------------------------------------------

const TYPE_AND_SEND = [
  { at: 1.0, press: BTN.CIRCLE }, //  open MAYA CHEN (autofocused: most recent)
  { at: 2.0, hold: BTN.UP }, //       scroll up into history (triggers a page fetch)
  { at: 4.0, hold: 0 },
  { at: 4.5, press: BTN.SELECT }, //  jump back to latest
  { at: 5.0, press: BTN.TRIANGLE }, // open the keyboard (focus lands on '1')
  { at: 5.5, press: BTN.DOWN }, //    'q'
  { at: 6.0, press: BTN.RIGHT },
  { at: 6.5, press: BTN.RIGHT },
  { at: 7.0, press: BTN.RIGHT },
  { at: 7.5, press: BTN.RIGHT },
  { at: 8.0, press: BTN.RIGHT }, //   'y'
  { at: 8.5, press: BTN.CIRCLE },
  { at: 9.0, press: BTN.RIGHT },
  { at: 9.5, press: BTN.RIGHT },
  { at: 10.0, press: BTN.RIGHT }, //  'o'
  { at: 10.5, press: BTN.CIRCLE },
  { at: 11.0, press: BTN.DOWN }, //   'l'
  { at: 11.5, press: BTN.DOWN }, //   '?'
  { at: 12.0, press: BTN.RIGHT }, //  '!'
  { at: 12.5, press: BTN.CIRCLE },
  { at: 13.0, press: BTN.START }, //  send "yo!"
];
const A_SECONDS = 21; // reply lands ~18.5 (typing runs 3 s), settle to 21

const scenarioA = (hz: number) => ({
  app: "im-main",
  hz,
  seconds: A_SECONDS,
  script: TYPE_AND_SEND,
});

const a60: Trace = await runScenario(scenarioA(60));

describe("determinism", () => {
  test("same tape, same world: repeat runs are hash-identical", async () => {
    const again = await runScenario(scenarioA(60));
    expect(again.hashes).toEqual(a60.hashes);
    expect(again.effects).toEqual(a60.effects);
  });

  test("chaos cannot reach the world: sleeps + garbage + GC change nothing", async () => {
    const chaos = await runScenario(scenarioA(60), { maxSleepMs: 3, gcEvery: 120 });
    expect(chaos.hashes).toEqual(a60.hashes);
    expect(chaos.effects).toEqual(a60.effects);
  });

  test("a low-rate world is deterministic too", async () => {
    // Scroll speed is per-frame (PSP runs a fixed 60 Hz), so a 4 Hz world
    // takes a different trajectory — but the SAME one, every run.
    const x = await runScenario(scenarioA(4));
    const y = await runScenario(scenarioA(4));
    expect(y.hashes).toEqual(x.hashes);
    expect(y.effects).toEqual(x.effects);
  });
});

describe("the sync loop is on the virtual clock", () => {
  test("request/response effects land at exact virtual seconds", () => {
    const named = a60.effects.filter((e) => e.kind !== "im/poll");
    const sec = (e: { frame: number }) => e.frame / a60.hz;
    expect(named.map((e) => `${e.t}:${e.kind}`)).toEqual([
      "command:im/bootstrap",
      "delivery:im/bootstrap",
      "command:im/history",
      "delivery:im/history",
      "command:im/send",
      "delivery:im/send",
    ]);
    expect(sec(named[0])).toBe(0); //     bootstrap issued at mount
    expect(sec(named[1])).toBe(0.5); //   … delivered half a second later
    expect(named[3].frame - named[2].frame).toBe(60); // history latency: 1 s
    expect(sec(named[4])).toBe(13.0); //  send fired by the START press
    expect(sec(named[5])).toBe(13.5); //  ack
  });

  test("the long-poll ticks every half second", () => {
    const polls = a60.effects.filter((e) => e.kind === "im/poll" && e.t === "delivery");
    expect(polls.length).toBeGreaterThan(30);
    for (let i = 1; i < polls.length; i++) {
      expect(polls[i].frame - polls[i - 1].frame).toBe(30);
    }
  });
});

describe("the journey actually happened", () => {
  test("typed message, receipts, reply — and the window stayed virtual", () => {
    expect(treeHasText(a60.tree, "yo!")).toBe(true); //          typed via the OSK
    expect(treeHasText(a60.tree, "✓✓")).toBe(true); //           receipts arrived
    expect(treeHasText(a60.tree, "EXACTLY the energy")).toBe(true); // MAYA replied
    expect(treeHasText(a60.tree, "IS TYPING")).toBe(false); //   …and stopped typing
    // Virtualization: sitting at the bottom, the top of the seeded history
    // must not be mounted at all.
    expect(treeHasText(a60.tree, "did you end up trying that grid layout")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Journey B — scroll MAYA all the way up: a history page prepends (with the
// no-jump rebase) and the thread ends at the beginning-of-conversation chip.
// ---------------------------------------------------------------------------

test("pagination reaches the beginning; the bottom unmounts", async () => {
  const b = await runScenario({
    app: "im-main",
    hz: 60,
    seconds: 10,
    script: [
      { at: 1.0, press: BTN.CIRCLE },
      // The prepend rebase shifts the scroll down by the added page height,
      // so reaching the very top takes the seed height plus a full page.
      { at: 2.0, hold: BTN.UP },
      { at: 7.5, hold: 0 },
    ],
  });
  expect(treeHasText(b.tree, "BEGINNING OF THE CONVERSATION")).toBe(true);
  expect(treeHasText(b.tree, "did you end up trying that grid layout")).toBe(true);
  // The newest message sits ~1300 px below — outside the mount window.
  expect(treeHasText(b.tree, "knew it. ok ping me")).toBe(false);
});

// ---------------------------------------------------------------------------
// Journey C — DAD is offline: delivery receipt only, no read, no typing, no
// reply. (The OSK types "qq" — DOWN to 'q', CIRCLE twice.)
// ---------------------------------------------------------------------------

test("offline contacts deliver but never read or reply", async () => {
  const c = await runScenario({
    app: "im-main",
    hz: 60,
    seconds: 9,
    script: [
      { at: 1.0, press: BTN.DOWN },
      { at: 1.5, press: BTN.DOWN },
      { at: 2.0, press: BTN.DOWN }, //  focus DAD (recency-sorted last)
      { at: 2.5, press: BTN.CIRCLE },
      { at: 3.0, press: BTN.TRIANGLE },
      { at: 3.5, press: BTN.DOWN }, //  'q'
      { at: 4.0, press: BTN.CIRCLE },
      { at: 4.5, press: BTN.CIRCLE }, // draft "qq"
      { at: 5.0, press: BTN.START },
    ],
  });
  expect(treeHasText(c.tree, "LAST SEEN YESTERDAY")).toBe(true);
  expect(treeHasText(c.tree, "qq")).toBe(true);
  expect(treeHasText(c.tree, "IS TYPING")).toBe(false);
  expect(treeHasText(c.tree, "ask your mother")).toBe(false); // no scripted reply
});

// ---------------------------------------------------------------------------
// Journey D — sit on the list: ambient pushes bump badges and previews.
// ---------------------------------------------------------------------------

test("ambient traffic updates unread badges and previews live", async () => {
  const d = await runScenario({ app: "im-main", hz: 60, seconds: 8 });
  // Seeds total 4 unread; NOVA's ambient build report (t=7 s) makes it 5 and
  // becomes the conversation's preview line.
  expect(treeHasText(d.tree, "5 UNREAD")).toBe(true);
  expect(treeHasText(d.tree, "nightly build 412")).toBe(true);
});
