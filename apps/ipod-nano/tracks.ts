// Display metadata is deliberately kept in TypeScript literals instead of a
// runtime JSON library. PocketJS' build pass can therefore see every glyph it
// must bake for the fixed 176x132 screen. The macOS Stage maps these stable ids
// to local audio files; file paths never cross into the guest.

export interface NanoTrack {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
  readonly durationMs: number;
}

export const NANO_TRACKS: readonly NanoTrack[] = [
  {
    id: "neon-boardwalk",
    title: "Neon Boardwalk",
    artist: "Pocket Sessions",
    album: "Pocket Sessions",
    durationMs: 24_000,
  },
  {
    id: "silver-static",
    title: "Silver Static",
    artist: "Pocket Sessions",
    album: "Pocket Sessions",
    durationMs: 24_000,
  },
  {
    id: "night-bus-loop",
    title: "Night Bus Loop",
    artist: "Pocket Sessions",
    album: "Pocket Sessions",
    durationMs: 24_000,
  },
] as const;
