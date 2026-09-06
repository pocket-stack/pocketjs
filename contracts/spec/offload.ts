/** Offload v1. JSON records are length-prefixed UTF-8 on the wire.
 * The UI copies bounded records; only the provider executes capabilities. */
export const OFFLOAD = Object.freeze({
  version: 1, recordBytes: 4096, payloadChars: 2500, pending: 8,
  deliveriesPerFrame: 1, submissionsPerFrame: 2, timeoutFrames: 600,
  port: 8741,
});

export interface OffloadOps {
  /** Positive authenticated connection generation; zero/negative = offline. */
  session(): number;
  /** Nonwaiting bounded copy. False means no credit; caller retains work. */
  submit(record: string): boolean;
  /** At most one complete record per host frame. Never performs IO. */
  take(): string | undefined;
  /** Optional bounded 2-bit coverage upload. At most 512x16, one per frame.
   * Foreground is ABGR; alpha comes from coverage. Optional columns provide one
   * lowercase hex palette index per pixel column; palette is 1..16 RGB hex colors.
   * Coloring uses the same scratch buffer and one upload. Returns a texture handle. */
  uploadCoverage?(base64: string, width: number, height: number, foreground: number, columns?: string, palette?: string): number;
}
export interface OffloadRequest { v: 1; id: number; method: string; payload: string }
export interface OffloadReply { id: number; payload?: string; error?: string }
