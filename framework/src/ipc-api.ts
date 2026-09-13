// IPC module SDK — the thin guest-side algebra over the `ipc` host module.
// One SOCK_SEQPACKET connection to the local daemon (forkliftd on D211).
//
//   ipc.connect(path)   -> boolean  bind the socket
//   ipc.send(bytes)     -> number   bytes queued (-1: retry next frame)
//   ipc.recv(capacity?) -> ArrayBuffer  one datagram (empty when idle)
//   ipc.close()                     release the socket
//
// Hosts without the module leave `globalThis.ipc` unset; the accessor below
// returns null and callers fall back to their in-process transport.

/** The mounted ipc namespace — one method per host op. */
export interface IpcOps {
  /** Bind a SOCK_SEQPACKET socket; false when the path is rejected. */
  connect(path: string): boolean;
  /** Release the socket (no-op when closed). */
  close(): void;
  /** BORROWED for the call; returns bytes queued (0..length) or -1. */
  send(data: Uint8Array | ArrayBuffer): number;
  /** One datagram, at most `capacity`; empty ArrayBuffer when idle. */
  recv(capacity?: number): ArrayBuffer;
}

/** The ipc module namespace, or null where the host doesn't mount one.
 *  A live lookup (not cached): hosts install `globalThis.ipc` before eval. */
export function ipcHost(): IpcOps | null {
  const ns = (globalThis as { ipc?: unknown }).ipc;
  if (!ns || typeof ns !== "object") return null;
  return typeof (ns as IpcOps).connect === "function" ? (ns as IpcOps) : null;
}
