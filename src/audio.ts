// Audio-facing public API (AUDIO.md).

export {
  audioSupported,
  defineSfx,
  playSfx,
  playSynth,
  playBgm,
  pauseBgm,
  resumeBgm,
  stopBgm,
  setVolume,
  getVolume,
  setMuted,
  isMuted,
  type AudioOps,
  type SynthDesc,
} from "./sound.ts";
