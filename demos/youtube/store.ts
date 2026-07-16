// demos/youtube/store.ts — Pocket YouTube's state machine.
//
// Three phases: "connect" (no transport yet — the Mac service is not
// running or the USB cable is out), "browse" (search + results) and
// "player" (a stream is up). Every transition is a delivery from the effect
// shell (driver.ts) or a button edge — no timers, no promises, the
// determinism rules the rest of the repo lives by.

import { createSignal } from "solid-js";
import { runEffect } from "@pocketjs/framework/effects";
import { virtualFrame } from "@pocketjs/framework/clock";
import { onHostPush, resolveTransport, type Transport } from "./driver.ts";
import type { HostMsg, ResultItem } from "./protocol.ts";

export interface PlayerState {
  videoId: string;
  title: string;
  durationS: number;
  fps: number;
  /** svc-relative .pkst path (videoOpen input). */
  stream: string;
  playing: boolean;
  /** True once the host reported the source exhausted. */
  ended: boolean;
}

export type Phase = "connect" | "browse" | "player";

export function createYoutubeStore() {
  const [phase, setPhase] = createSignal<Phase>("connect");
  const [transport, setTransport] = createSignal<Transport>("none");
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal<ResultItem[]>([]);
  const [focused, setFocused] = createSignal(0);
  const [searching, setSearching] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [player, setPlayer] = createSignal<PlayerState | null>(null);
  /** Bumped on every "playing" reply — the player screen re-opens the
   *  stream when it changes (fresh .pkst file per play/replay). */
  const [playSerial, setPlaySerial] = createSignal(0);
  let lastHello = -1;

  onHostPush((msg: HostMsg) => {
    if (msg.t === "ended") {
      const p = player();
      if (p) setPlayer({ ...p, ended: true, playing: false });
    }
  });

  const hello = (): void => {
    lastHello = virtualFrame();
    runEffect<HostMsg>("yt/hello", {}, (msg) => {
      if (msg.t === "ready") {
        setTransport(resolveTransport());
        if (phase() === "connect") setPhase("browse");
      }
    });
  };

  /** connect-phase retry pump (driven by the app's onFrame): re-probe the
   *  transport every ~2 s until the host answers. */
  const connectTick = (): void => {
    if (phase() !== "connect") return;
    const now = virtualFrame();
    if (lastHello < 0 || now - lastHello >= 120) hello();
  };

  const search = (): void => {
    const q = query().trim();
    if (!q || searching()) return;
    setSearching(true);
    setStatus("SEARCHING…");
    runEffect<HostMsg>("yt/search", { q }, (msg) => {
      setSearching(false);
      if (msg.t === "results") {
        setResults(msg.items);
        setFocused(0);
        setStatus(msg.items.length === 0 ? "NO RESULTS" : "");
      } else if (msg.t === "error") {
        setStatus(msg.message === "offline" ? "HOST OFFLINE" : `ERROR: ${msg.message}`);
        if (msg.message === "offline") setPhase("connect");
      }
    });
  };

  const play = (item: ResultItem): void => {
    setStatus("RESOLVING…");
    runEffect<HostMsg>("yt/play", { videoId: item.videoId }, (msg) => {
      if (msg.t === "playing") {
        setStatus("");
        setPlayer({
          videoId: msg.videoId,
          title: msg.title,
          durationS: msg.durationS,
          fps: msg.fps,
          stream: msg.stream,
          playing: true,
          ended: false,
        });
        setPlaySerial(playSerial() + 1);
        setPhase("player");
      } else if (msg.t === "error") {
        setStatus(`ERROR: ${msg.message}`);
      }
    });
  };

  const togglePause = (): void => {
    const p = player();
    if (!p || p.ended) return;
    const kind = p.playing ? "yt/pause" : "yt/resume";
    setPlayer({ ...p, playing: !p.playing });
    runEffect<HostMsg>(kind, {}, () => {});
  };

  /** Absolute seek; the host clamps to the source range. */
  const seekTo = (seconds: number): void => {
    const p = player();
    if (!p) return;
    setPlayer({ ...p, playing: true, ended: false });
    runEffect<HostMsg>("yt/seek", { to: Math.max(0, seconds) }, () => {});
  };

  const stopPlayback = (): void => {
    if (!player()) return;
    setPlayer(null);
    setPhase("browse");
    runEffect<HostMsg>("yt/stop", {}, () => {});
  };

  return {
    phase,
    transport,
    query,
    setQuery,
    results,
    focused,
    setFocused,
    searching,
    status,
    player,
    playSerial,
    connectTick,
    hello,
    search,
    play,
    togglePause,
    seekTo,
    stopPlayback,
  };
}

export type YoutubeStore = ReturnType<typeof createYoutubeStore>;
