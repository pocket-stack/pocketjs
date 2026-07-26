import { describe, expect, test } from "bun:test";
import {
  MAIN_MENU,
  MUSIC_MENU,
  createNanoPlayerState,
  currentTrack,
  formatNanoTime,
  reduceNanoPlayer,
} from "../apps/ipod-nano/state.ts";
import {
  NANO_AUDIO_SERVICE,
  connectNanoAudioService,
  parseNanoAudioBatch,
  parseNanoAudioEvent,
} from "../apps/ipod-nano/svc.ts";
import { NANO_TRACKS } from "../apps/ipod-nano/tracks.ts";

describe("iPod nano navigation reducer", () => {
  test("wheel selection wraps in both directions", () => {
    let state = createNanoPlayerState();
    state = reduceNanoPlayer(state, { type: "wheel", direction: -1 }).state;
    expect(state.selected.main).toBe(MAIN_MENU.length - 1);
    state = reduceNanoPlayer(state, { type: "wheel", direction: 1 }).state;
    expect(state.selected.main).toBe(0);
  });

  test("center enters Music and MENU restores the previous screen", () => {
    let state = createNanoPlayerState();
    state = reduceNanoPlayer(state, { type: "select" }).state;
    expect(state.screen).toBe("music");
    expect(state.history).toEqual(["main"]);
    expect(state.selected.music).toBe(0);
    state = reduceNanoPlayer(state, { type: "back" }).state;
    expect(state.screen).toBe("main");
    expect(state.history).toEqual([]);
  });

  test("Songs selection plays the chosen host index and opens Now Playing", () => {
    let state = createNanoPlayerState();
    state = reduceNanoPlayer(state, { type: "select" }).state; // Music
    for (let i = 0; i < 3; i++) {
      state = reduceNanoPlayer(state, { type: "wheel", direction: 1 }).state;
    }
    expect(MUSIC_MENU[state.selected.music]).toBe("Songs");
    state = reduceNanoPlayer(state, { type: "select" }).state;
    expect(state.screen).toBe("songs");
    state = reduceNanoPlayer(state, { type: "wheel", direction: 1 }).state;
    const result = reduceNanoPlayer(state, { type: "select" });
    expect(result.state.screen).toBe("now-playing");
    expect(currentTrack(result.state).id).toBe(NANO_TRACKS[1].id);
    expect(result.state.playing).toBe(true);
    expect(result.commands).toEqual([{ t: "media", op: "play", index: 1 }]);
  });

  test("previous/next preserve pause state and START emits toggle", () => {
    let state = createNanoPlayerState();
    let result = reduceNanoPlayer(state, { type: "previous" });
    expect(result.state.trackIndex).toBe(NANO_TRACKS.length - 1);
    expect(result.state.playing).toBe(false);
    expect(result.commands).toEqual([{ t: "media", op: "previous" }]);

    result = reduceNanoPlayer(result.state, { type: "toggle-play" });
    expect(result.state.playing).toBe(true);
    expect(result.commands).toEqual([{ t: "media", op: "toggle" }]);
    result = reduceNanoPlayer(result.state, { type: "next" });
    expect(result.state.trackIndex).toBe(0);
    expect(result.state.playing).toBe(true);
    expect(result.commands).toEqual([{ t: "media", op: "next" }]);
  });

  test("media.hello replaces fallback metadata and synchronizes playback", () => {
    const state = createNanoPlayerState(true);
    const synced = reduceNanoPlayer(state, {
      type: "host",
      event: {
        t: "media.hello",
        tracks: [
          { id: "local-a", title: "Local A", artist: "Artist A", durationMs: 10_000 },
          { id: "local-b", title: "Local B", artist: "Artist B", durationMs: 20_000 },
        ],
        index: 1,
        playing: true,
        positionMs: 999_000,
        durationMs: 20_000,
      },
    }).state;
    expect(synced.transport).toBe("ready");
    expect(synced.tracks).toHaveLength(2);
    expect(currentTrack(synced).id).toBe("local-b");
    expect(synced.positionMs).toBe(20_000);
    expect(synced.durationMs).toBe(20_000);
  });

  test("media.state clamps position and exposes host errors", () => {
    let state = createNanoPlayerState(true);
    state = reduceNanoPlayer(state, {
      type: "host",
      event: {
        t: "media.state",
        index: 2,
        playing: true,
        positionMs: 999_000,
        durationMs: 200_000,
      },
    }).state;
    expect(state.trackIndex).toBe(2);
    expect(state.positionMs).toBe(200_000);
    expect(state.transport).toBe("ready");

    state = reduceNanoPlayer(state, {
      type: "host",
      event: {
        t: "media.state",
        index: 2,
        playing: true,
        positionMs: 10,
        durationMs: 200_000,
        error: "decoder stopped",
      },
    }).state;
    expect(state.transport).toBe("error");
    expect(state.playing).toBe(false);
  });

  test("mock playback advances coarsely and deterministically rolls tracks", () => {
    let state = reduceNanoPlayer(createNanoPlayerState(), { type: "toggle-play" }).state;
    state = { ...state, positionMs: state.durationMs - 100 };
    const result = reduceNanoPlayer(state, { type: "mock-tick", deltaMs: 250 });
    expect(result.state.trackIndex).toBe(1);
    expect(result.state.positionMs).toBe(0);
    expect(result.state.playing).toBe(true);
    expect(result.commands).toEqual([]);
  });

  test("time labels use classic M:SS formatting", () => {
    expect(formatNanoTime(0)).toBe("0:00");
    expect(formatNanoTime(65_999)).toBe("1:05");
    expect(formatNanoTime(-1)).toBe("0:00");
  });
});

describe("iPod nano media service protocol", () => {
  const hello = {
    t: "media.hello",
    tracks: [
      { id: "one", title: "One", artist: "Pocket Artist", durationMs: 9_000 },
      { id: "two", title: "Two", artist: "Pocket Artist", durationMs: 11_000 },
    ],
    index: 1,
    playing: true,
    positionMs: 1_250,
    durationMs: 11_000,
  } as const;

  test("matches the channel authored by the Stage package", async () => {
    const profile = await Bun.file(
      new URL(
        "../engine/pocket3d/examples/handheld/assets/ipod-nano-2/profile.json",
        import.meta.url,
      ),
    ).json();
    expect(profile.media.service).toBe("audio-playlist@1");
    expect(profile.media.channel).toBe(NANO_AUDIO_SERVICE);
  });

  test("parses valid batches and drops malformed or unknown lines", () => {
    const state = {
      t: "media.state",
      index: 1,
      playing: false,
      positionMs: 2_500,
      durationMs: 11_000,
      error: "paused by host",
    } as const;
    const batch = [
      JSON.stringify(hello),
      "not json",
      JSON.stringify(state),
      JSON.stringify({ t: "future-message" }),
      "",
    ].join("\n");
    expect(parseNanoAudioBatch(batch)).toEqual([hello, state]);
  });

  test("rejects invalid tracks, indices and numeric state", () => {
    expect(parseNanoAudioEvent('{"t":"media.hello","tracks":[],"index":0,"playing":false,"positionMs":0,"durationMs":0}')).toBeNull();
    expect(
      parseNanoAudioEvent(
        '{"t":"media.hello","tracks":[{"id":"x","title":"X","artist":"A","durationMs":5}],"index":1,"playing":false,"positionMs":0,"durationMs":5}',
      ),
    ).toBeNull();
    expect(
      parseNanoAudioEvent(
        '{"t":"media.state","index":0,"playing":true,"positionMs":-1,"durationMs":5}',
      ),
    ).toBeNull();
    expect(
      parseNanoAudioEvent(
        '{"t":"media.state","index":0,"playing":true,"positionMs":1,"durationMs":5,"error":7}',
      ),
    ).toBeNull();
  });

  test("feature-detects the queue and serializes media commands", () => {
    const sent: string[] = [];
    const opens: string[] = [];
    const service = connectNanoAudioService({
      svcOpen(app) {
        opens.push(app);
        return true;
      },
      svcPoll() {
        return `${JSON.stringify(hello)}\n`;
      },
      svcSend(line) {
        sent.push(line);
      },
    });
    expect(opens).toEqual([NANO_AUDIO_SERVICE]);
    expect(service?.poll()).toEqual([hello]);
    service?.send({ t: "media", op: "play", index: 1 });
    service?.send({ t: "media", op: "toggle" });
    expect(sent.map((line) => JSON.parse(line))).toEqual([
      { t: "media", op: "play", index: 1 },
      { t: "media", op: "toggle" },
    ]);
  });

  test("falls back cleanly when any service operation is absent", () => {
    expect(connectNanoAudioService({})).toBeNull();
    expect(
      connectNanoAudioService({ svcOpen: () => false, svcPoll: () => undefined, svcSend() {} }),
    ).toBeNull();
  });
});
