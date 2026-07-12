// test/audio.test.ts — Pocket Audio runtime (AUDIO.md): src/sound.ts's
// module-level semantics, plus one render()-level wiring check.
//
// Run: bun test --conditions=browser test/audio.test.ts
// (--conditions=browser: see renderer.test.ts — the SSR solid build no-ops.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

if (Bun.resolveSync("solid-js", import.meta.dir).endsWith("server.js")) {
  throw new Error("solid-js resolved to its SSR build — run: bun test --conditions=browser");
}

import {
  audioSupported,
  defineSfx,
  getVolume,
  isMuted,
  pauseBgm,
  playBgm,
  playSfx,
  playSynth,
  resumeBgm,
  setMuted,
  setVolume,
  stopBgm,
  type AudioOps,
} from "../src/audio.ts";
import { initAudio, resetAudio } from "../src/sound.ts";
import { installHost, type Host, type HostOps } from "../src/host.ts";
import { render as publicRender } from "../src/index.ts";
import { createElement, resetRendererState } from "../src/renderer.ts";
import { resetStyles } from "../src/styles.ts";
import { resetInput } from "../src/input.ts";
import { resetPack } from "../src/pak.ts";
import { ROOT_ID } from "../spec/spec.ts";

type Call = [string, ...unknown[]];

/** Records every call, mirroring makeMockHost/makeDevHost in the other test
 *  files. Every method is implemented by default; individual methods are
 *  deleted per-test to exercise the "missing method" no-op contract. */
function makeMockAudio(): AudioOps & { calls: Call[]; of(name: string): Call[] } {
  const calls: Call[] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    of(name: string) {
      return calls.filter((c) => c[0] === name);
    },
    playSfx: rec("playSfx"),
    playSynth: rec("playSynth"),
    playBgm: rec("playBgm"),
    stopBgm: rec("stopBgm"),
    pauseBgm: rec("pauseBgm"),
    setChannelVolume: rec("setChannelVolume"),
  };
}

// ---------------------------------------------------------------------------
// (1) no host mounted: every public function is a silent no-op
// ---------------------------------------------------------------------------

describe("no audio host mounted", () => {
  beforeEach(() => {
    resetAudio();
  });

  test("every public function is callable and throws nothing", () => {
    expect(audioSupported()).toBe(false);
    expect(() => {
      defineSfx("blip", { wave: "square", freq: 880, durMs: 40 });
      playSfx("blip");
      playSfx("unregistered");
      playSynth({ wave: "noise", freq: 220, durMs: 100 });
      playBgm("theme1");
      pauseBgm();
      resumeBgm();
      stopBgm();
      setVolume("master", 0.5);
      setVolume("sfx", 2); // out of range — must clamp, not throw
      setMuted(true);
      setMuted(false);
      isMuted();
      getVolume("bgm");
    }).not.toThrow();
  });

  test("runtime-held volume/mute state still works with no host", () => {
    setVolume("master", 0.4);
    expect(getVolume("master")).toBe(0.4);
    setMuted(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) injected mock AudioOps
// ---------------------------------------------------------------------------

describe("injected AudioOps", () => {
  let audio: ReturnType<typeof makeMockAudio>;

  beforeEach(() => {
    resetAudio();
    audio = makeMockAudio();
    initAudio(audio);
  });
  afterEach(() => {
    resetAudio();
  });

  test("initAudio pushes all three channel volumes", () => {
    expect(audio.of("setChannelVolume")).toEqual([
      ["setChannelVolume", 0, 1],
      ["setChannelVolume", 1, 1],
      ["setChannelVolume", 2, 1],
    ]);
  });

  test("audioSupported() is true once a host is mounted", () => {
    expect(audioSupported()).toBe(true);
  });

  describe("playSfx / playSynth / defineSfx", () => {
    test("registered name routes to playSynth with defaults filled + wave mapped", () => {
      defineSfx("blip", { wave: "square", freq: 880, durMs: 40 });
      playSfx("blip");
      expect(audio.of("playSfx")).toEqual([]);
      // wave ordinal (square = 0), freqEnd defaults to freq, attackMs 0,
      // releaseMs 15, volume 1.
      expect(audio.of("playSynth")).toEqual([["playSynth", 0, 880, 880, 40, 0, 15, 1]]);
    });

    test("unregistered name routes to the playSfx op with the bare name", () => {
      playSfx("explosion", { volume: 0.5, pan: -1 });
      expect(audio.of("playSynth")).toEqual([]);
      expect(audio.of("playSfx")).toEqual([["playSfx", "explosion", 0.5, -1]]);
    });

    test("playSynth fills defaults and maps every waveform ordinal", () => {
      playSynth({ wave: "noise", freq: 100, freqEnd: 50, durMs: 500, attackMs: 5, releaseMs: 200, volume: 0.3 });
      expect(audio.of("playSynth")).toEqual([
        ["playSynth", 6 /* Noise */, 100, 50, 500, 5, 200, 0.3],
      ]);
    });

    test("playSfx opts.volume overrides a registered synth's default volume", () => {
      defineSfx("laser", { wave: "square", freq: 1760, freqEnd: 110, durMs: 80, volume: 1 });
      playSfx("laser", { volume: 0.2 });
      expect(audio.of("playSynth")).toEqual([["playSynth", 0, 1760, 110, 80, 0, 15, 0.2]]);
    });
  });

  describe("volume + mute", () => {
    test("setVolume clamps to 0..1", () => {
      setVolume("sfx", 5);
      expect(getVolume("sfx")).toBe(1);
      setVolume("sfx", -5);
      expect(getVolume("sfx")).toBe(0);
    });

    test("mute pushes master 0 and unmute restores the prior master", () => {
      setVolume("master", 0.8);
      audio.calls.length = 0;
      setMuted(true);
      expect(isMuted()).toBe(true);
      expect(audio.of("setChannelVolume")).toEqual([["setChannelVolume", 0, 0]]);
      audio.calls.length = 0;
      setMuted(false);
      expect(isMuted()).toBe(false);
      expect(audio.of("setChannelVolume")).toEqual([["setChannelVolume", 0, 0.8]]);
    });

    test("setVolume('master') while muted updates the remembered value without unmuting", () => {
      setVolume("master", 0.8);
      setMuted(true);
      audio.calls.length = 0;
      setVolume("master", 0.3);
      expect(isMuted()).toBe(true); // still muted
      expect(audio.of("setChannelVolume")).toEqual([]); // host stays at 0, no push
      expect(getVolume("master")).toBe(0.3); // remembered value updated
      audio.calls.length = 0;
      setMuted(false);
      expect(audio.of("setChannelVolume")).toEqual([["setChannelVolume", 0, 0.3]]);
    });

    test("setMuted is idempotent (no duplicate pushes)", () => {
      setMuted(true);
      audio.calls.length = 0;
      setMuted(true);
      expect(audio.of("setChannelVolume")).toEqual([]);
    });
  });

  describe("BGM", () => {
    test("playBgm defaults: loop=true, fadeMs=0, volume=1", () => {
      playBgm("theme1");
      expect(audio.of("playBgm")).toEqual([["playBgm", "theme1", 1, 0, 1]]);
    });

    test("same key while playing is a no-op", () => {
      playBgm("theme1");
      audio.calls.length = 0;
      playBgm("theme1", { fadeMs: 500 });
      expect(audio.of("playBgm")).toEqual([]);
    });

    test("switching key forwards fadeMs", () => {
      playBgm("theme1");
      audio.calls.length = 0;
      playBgm("theme2", { fadeMs: 300 });
      expect(audio.of("playBgm")).toEqual([["playBgm", "theme2", 1, 300, 1]]);
    });

    test("stopBgm forwards fadeMs", () => {
      playBgm("theme1");
      audio.calls.length = 0;
      stopBgm({ fadeMs: 250 });
      expect(audio.of("stopBgm")).toEqual([["stopBgm", 250]]);
    });

    test("pauseBgm is idempotent", () => {
      playBgm("theme1");
      audio.calls.length = 0;
      pauseBgm();
      pauseBgm();
      expect(audio.of("pauseBgm")).toEqual([["pauseBgm", 1]]);
    });

    test("resumeBgm after stopBgm is a no-op", () => {
      playBgm("theme1");
      stopBgm();
      audio.calls.length = 0;
      resumeBgm();
      expect(audio.of("pauseBgm")).toEqual([]);
    });

    test("resumeBgm restores the cursor after pauseBgm", () => {
      playBgm("theme1");
      pauseBgm();
      audio.calls.length = 0;
      resumeBgm();
      expect(audio.of("pauseBgm")).toEqual([["pauseBgm", 0]]);
    });
  });

  describe("resetAudio", () => {
    test("stops a playing bgm and clears every field back to defaults", () => {
      setVolume("master", 0.3);
      setMuted(true);
      defineSfx("blip", { wave: "square", freq: 880, durMs: 40 });
      playBgm("theme1");
      audio.calls.length = 0;

      resetAudio();
      expect(audio.of("stopBgm")).toEqual([["stopBgm", 0]]);

      // module state is back to defaults: playing the same key again is NOT
      // a no-op (bgm state was cleared), and there is no host anymore.
      expect(audioSupported()).toBe(false);
      expect(isMuted()).toBe(false);
      expect(getVolume("master")).toBe(1);
      audio.calls.length = 0;
      playBgm("theme1"); // no host now — silent no-op, no throw
      expect(audio.of("playBgm")).toEqual([]);
    });
  });

  describe("mock host missing optional methods", () => {
    test("a mock missing every method never throws", () => {
      initAudio({});
      expect(() => {
        defineSfx("blip", { wave: "square", freq: 880, durMs: 40 });
        playSfx("blip");
        playSfx("unregistered");
        playSynth({ wave: "sine", freq: 440, durMs: 10 });
        playBgm("theme1");
        pauseBgm();
        resumeBgm();
        stopBgm();
        setVolume("master", 0.5);
        setMuted(true);
        setMuted(false);
      }).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// (3) render()-level wiring
// ---------------------------------------------------------------------------

function makeMockHost(): Host & { ops: HostOps } {
  let nextId = ROOT_ID + 1;
  const noop = () => {};
  const ops: HostOps = {
    createNode: () => nextId++,
    destroyNode: noop,
    insertBefore: noop,
    removeChild: noop,
    setStyle: noop,
    setProp: noop,
    setText: noop,
    replaceText: noop,
    uploadTexture: () => 0,
    setImage: noop,
    setSprite: noop,
    animate: () => 1,
    cancelAnim: noop,
    setFocus: noop,
    measureText: () => 0,
  };
  return { ops, kind: "injected", strict: true };
}

describe("render({ audio }) wiring (index.ts)", () => {
  let host: Host & { ops: HostOps };

  beforeEach(() => {
    host = makeMockHost();
    installHost(host);
    resetRendererState();
    resetStyles();
    resetPack();
    resetInput();
    resetAudio();
  });
  afterEach(() => {
    resetAudio();
  });

  test("render() wires opts.audio through initAudio, dispose() stops bgm + resets", () => {
    const audio = makeMockAudio();
    const dispose = publicRender(() => createElement("view"), { ops: host.ops, audio });

    expect(audioSupported()).toBe(true);
    expect(audio.of("setChannelVolume").length).toBe(3);

    playBgm("theme1");
    audio.calls.length = 0;

    dispose();
    expect(audio.of("stopBgm")).toEqual([["stopBgm", 0]]);
    expect(audioSupported()).toBe(false); // resetAudio() nulled the host
  });
});
