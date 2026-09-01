import type { NanoAudioCommand, NanoAudioEvent } from "./svc.ts";
import { NANO_TRACKS, type NanoTrack } from "./tracks.ts";

export type NanoScreen = "main" | "music" | "songs" | "now-playing" | "placeholder";
export type NanoMenu = "main" | "music" | "songs";
export type NanoTransport = "mock" | "connecting" | "ready" | "error";

export interface NanoPlayerState {
  readonly screen: NanoScreen;
  readonly history: readonly NanoScreen[];
  readonly selected: Readonly<Record<NanoMenu, number>>;
  readonly placeholderTitle: string;
  readonly tracks: readonly NanoTrack[];
  readonly trackIndex: number;
  readonly playing: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly transport: NanoTransport;
}

export type NanoPlayerAction =
  | { readonly type: "wheel"; readonly direction: -1 | 1 }
  | { readonly type: "select" }
  | { readonly type: "back" }
  | { readonly type: "previous" }
  | { readonly type: "next" }
  | { readonly type: "toggle-play" }
  | { readonly type: "host"; readonly event: NanoAudioEvent }
  | { readonly type: "mock-tick"; readonly deltaMs: number };

export interface NanoTransition {
  readonly state: NanoPlayerState;
  readonly commands: readonly NanoAudioCommand[];
}

export const MAIN_MENU = ["Music", "Photos", "Extras", "Settings", "Shuffle Songs"] as const;
export const MUSIC_MENU = ["Now Playing", "Artists", "Albums", "Songs", "Playlists", "Shuffle Songs"] as const;

export function createNanoPlayerState(hasAudioService = false): NanoPlayerState {
  return {
    screen: "main",
    history: [],
    selected: { main: 0, music: 0, songs: 0 },
    placeholderTitle: "",
    tracks: NANO_TRACKS,
    trackIndex: 0,
    playing: false,
    positionMs: 0,
    durationMs: NANO_TRACKS[0].durationMs,
    transport: hasAudioService ? "connecting" : "mock",
  };
}

export function currentTrack(state: NanoPlayerState): NanoTrack {
  return state.tracks[state.trackIndex] ?? state.tracks[0] ?? NANO_TRACKS[0];
}

export function formatNanoTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function selectionLength(state: NanoPlayerState): number {
  if (state.screen === "main") return MAIN_MENU.length;
  if (state.screen === "music") return MUSIC_MENU.length;
  if (state.screen === "songs") return state.tracks.length;
  return 0;
}

function selectedKey(screen: NanoScreen): NanoMenu | null {
  return screen === "main" || screen === "music" || screen === "songs" ? screen : null;
}

function moveSelection(state: NanoPlayerState, direction: -1 | 1): NanoPlayerState {
  const key = selectedKey(state.screen);
  const length = selectionLength(state);
  if (!key || length === 0) return state;
  const value = (state.selected[key] + direction + length) % length;
  return { ...state, selected: { ...state.selected, [key]: value } };
}

function pushScreen(state: NanoPlayerState, screen: NanoScreen): NanoPlayerState {
  return { ...state, screen, history: [...state.history, state.screen] };
}

function localTrackState(state: NanoPlayerState, trackIndex: number, autoplay: boolean): NanoPlayerState {
  const normalized = (trackIndex + state.tracks.length) % state.tracks.length;
  const track = state.tracks[normalized];
  return {
    ...state,
    trackIndex: normalized,
    playing: autoplay,
    positionMs: 0,
    durationMs: track.durationMs,
  };
}

function playTrack(
  state: NanoPlayerState,
  trackIndex: number,
  openNowPlaying: boolean,
): NanoTransition {
  const next = localTrackState(state, trackIndex, true);
  return {
    state: openNowPlaying ? pushScreen(next, "now-playing") : next,
    commands: [{ t: "media", op: "play", index: next.trackIndex }],
  };
}

function shuffle(state: NanoPlayerState): NanoTransition {
  // Deterministic rather than random: tapes and mock mode replay identically.
  return playTrack(state, state.trackIndex + 1, true);
}

function selectMain(state: NanoPlayerState): NanoTransition {
  switch (state.selected.main) {
    case 0:
      return { state: pushScreen(state, "music"), commands: [] };
    case 1:
      return {
        state: { ...pushScreen(state, "placeholder"), placeholderTitle: "No Photos" },
        commands: [],
      };
    case 2:
      return {
        state: { ...pushScreen(state, "placeholder"), placeholderTitle: "PocketJS Extras" },
        commands: [],
      };
    case 3:
      return {
        state: { ...pushScreen(state, "placeholder"), placeholderTitle: "About This iPod" },
        commands: [],
      };
    default:
      return shuffle(state);
  }
}

function selectMusic(state: NanoPlayerState): NanoTransition {
  if (state.selected.music === 0) {
    return { state: pushScreen(state, "now-playing"), commands: [] };
  }
  if (state.selected.music === MUSIC_MENU.length - 1) return shuffle(state);
  return { state: pushScreen(state, "songs"), commands: [] };
}

function selectCurrent(state: NanoPlayerState): NanoTransition {
  if (state.screen === "main") return selectMain(state);
  if (state.screen === "music") return selectMusic(state);
  if (state.screen === "songs") return playTrack(state, state.selected.songs, true);
  return { state, commands: [] };
}

function back(state: NanoPlayerState): NanoPlayerState {
  const previous = state.history[state.history.length - 1];
  if (!previous) return state;
  return { ...state, screen: previous, history: state.history.slice(0, -1) };
}

function applyHostEvent(state: NanoPlayerState, event: NanoAudioEvent): NanoPlayerState {
  if (event.t === "media.hello") {
    const trackIndex = Math.min(event.index, event.tracks.length - 1);
    return {
      ...state,
      tracks: event.tracks,
      selected: {
        ...state.selected,
        songs: Math.min(state.selected.songs, event.tracks.length - 1),
      },
      trackIndex,
      playing: event.playing,
      positionMs: Math.min(event.positionMs, event.durationMs),
      durationMs: event.durationMs,
      transport: "ready",
    };
  }

  const trackIndex = Math.min(event.index, state.tracks.length - 1);
  return {
    ...state,
    trackIndex,
    playing: event.error ? false : event.playing,
    positionMs: Math.min(event.positionMs, event.durationMs),
    durationMs: event.durationMs,
    transport: event.error ? "error" : "ready",
  };
}

function mockTick(state: NanoPlayerState, deltaMs: number): NanoTransition {
  if (!state.playing || !Number.isFinite(deltaMs) || deltaMs <= 0) {
    return { state, commands: [] };
  }
  const positionMs = state.positionMs + deltaMs;
  if (positionMs < state.durationMs) {
    return { state: { ...state, positionMs }, commands: [] };
  }
  return {
    state: localTrackState(state, state.trackIndex + 1, true),
    commands: [],
  };
}

function skipTrack(state: NanoPlayerState, direction: -1 | 1): NanoTransition {
  return {
    state: localTrackState(state, state.trackIndex + direction, state.playing),
    commands: [{ t: "media", op: direction < 0 ? "previous" : "next" }],
  };
}

/** Pure iPod navigation/playback reducer plus explicit host commands. */
export function reduceNanoPlayer(
  state: NanoPlayerState,
  action: NanoPlayerAction,
): NanoTransition {
  switch (action.type) {
    case "wheel":
      return { state: moveSelection(state, action.direction), commands: [] };
    case "select":
      return selectCurrent(state);
    case "back":
      return { state: back(state), commands: [] };
    case "previous":
      return skipTrack(state, -1);
    case "next":
      return skipTrack(state, 1);
    case "toggle-play": {
      const playing = !state.playing;
      return {
        state: { ...state, playing },
        commands: [{ t: "media", op: "toggle" }],
      };
    }
    case "host":
      return { state: applyHostEvent(state, action.event), commands: [] };
    case "mock-tick":
      return mockTick(state, action.deltaMs);
  }
}
