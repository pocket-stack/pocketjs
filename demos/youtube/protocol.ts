// demos/youtube/protocol.ts — the mailbox protocol both sides speak.
//
// Types only (imported by the PSP app AND the Mac host service): the wire is
// JSON lines over pocket-svc/youtube/{out,in}.jsonl (spec.ts SVC), bulk
// bytes ride side files (cards as IMG entries, video as a .pkst stream).
// Every request carries the app's effect-command id; the reply echoes it, so
// the app's driver can route deliveries without ordering assumptions.

/** PSP -> host (out.jsonl). */
export type DeviceCmd =
  | { t: "hello"; id: number }
  | { t: "search"; id: number; q: string }
  /** Next batch of the LAST search; replies `results` with only NEW items. */
  | { t: "more"; id: number }
  | { t: "play"; id: number; videoId: string }
  | { t: "pause"; id: number }
  | { t: "resume"; id: number }
  | { t: "seek"; id: number; to: number }
  | { t: "stop"; id: number };

export interface ResultItem {
  videoId: string;
  title: string;
  channel: string;
  durationS: number;
  views: number;
  /** svc-relative IMG-entry path for loadImgFile (256x64 card). */
  card: string;
}

/** Host -> PSP (in.jsonl). `id` echoes the request; hostPush events omit it. */
export type HostMsg =
  | { t: "ready"; id: number }
  | { t: "results"; id: number; items: ResultItem[] }
  | {
      t: "playing";
      id: number;
      videoId: string;
      title: string;
      durationS: number;
      fps: number;
      /** svc-relative .pkst path for videoOpen. */
      stream: string;
      /** Seconds the stream's frame indices are based at (0 or the seek). */
      position: number;
    }
  | { t: "state"; id: number; playing: boolean; position: number }
  | { t: "ended" }
  | { t: "error"; id: number; message: string };
