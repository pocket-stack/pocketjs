/** Desktop transport. Capability implementations execute in a Worker owned by
 * each authenticated device connection, never inside the socket callbacks. */
import { connect } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { OFFLOAD, type OffloadRequest, type OffloadProviderReply, type OffloadImage } from "../contracts/spec/offload.ts";
import { OffloadDecoder, encodeOffloadRecord, encodeOffloadImage } from "./offload-wire.ts";
export type { OffloadImage } from "../contracts/spec/offload.ts";

export function connectOffloadProvider(options: {
  address: string; key: string; worker: string | URL; data?: unknown;
  port?: number; log?: (message: string) => void;
  /** Process mode isolates native codecs and fetch teardown from the transport.
   * Both modes use the same self.onmessage/postMessage provider module API. */
  isolation?: "thread" | "process";
}) {
  if (!/^[0-9a-f]{64}$/.test(options.key)) throw new Error("Expected a 256-bit pairing key");
  let stopped = false;
  let closeCurrent = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let lastConnectFailure = "";
  const attach = () => {
    if (stopped) return;
    const socket = connect({ host: options.address, port: options.port ?? OFFLOAD.port });
    const decoder = new OffloadDecoder();
    const session = ++generation;
    const log = (message: string) => options.log?.(`Session ${session}: ${message}`);
    let worker: { postMessage(value: unknown): void; terminate(): void | Promise<unknown> } | undefined;
    let closed = false, reason = "device closed connection";
    const pending = new Map<number, boolean>();
    const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
    const replies: Buffer[] = [];
    let writing = false, held: Buffer | undefined, consumed = 0;
    const canRead = () => !writing && replies.length === 0 && pending.size < OFFLOAD.pending;
    const fail = (why: string) => { if (closed) return; reason = why; socket.destroy(); };
    const connecting = setTimeout(() => fail("connect timeout"), 5000);
    closeCurrent = () => fail("provider stopped");
    socket.setNoDelay(true);
    socket.setTimeout(15000, () => fail("device idle timeout"));
    socket.on("connect", () => {
      clearTimeout(connecting); lastConnectFailure = "";
      socket.write(options.key);
      const replyToDevice = (reply: OffloadProviderReply) => {
        if (closed || socket.destroyed) return;
        if (!reply || !Number.isSafeInteger(reply.id) || reply.id < 1 || reply.id > 0xffffffff) return fail("invalid provider reply ID");
        const expectsImage = pending.get(reply.id);
        if (!pending.delete(reply.id)) return fail("unexpected provider reply ID");
        clearTimeout(deadlines.get(reply.id)); deadlines.delete(reply.id);
        try {
          if (typeof reply.payload === "string" && reply.payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
          if (reply.image && !expectsImage) throw new Error("Unrequested image response");
          const record = reply.image ? encodeOffloadImage(reply.id, reply.image) : encodeOffloadRecord(JSON.stringify(reply));
          // Each queued reply replaces one admitted request. Slow LAN writes
          // consume credit; they are not an invalid connection.
          if (replies.length >= OFFLOAD.pending) return fail("provider reply credit exceeded");
          replies.push(record); flush();
        } catch { fail("invalid provider response"); }
      };
      try {
        if (options.isolation === "process") {
          const entry = options.worker instanceof URL ? options.worker.href : options.worker.startsWith("file:") ? options.worker : pathToFileURL(resolve(options.worker)).href;
          const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./offload-process.ts", import.meta.url)), entry], {
            stdin: "ignore", stdout: "inherit", stderr: "inherit", serialization: "advanced",
            ipc: replyToDevice,
            onExit(_child, code, signal) { if (!closed) fail(`provider process exited (code=${code}, signal=${signal ?? "none"})`); },
          });
          worker = { postMessage: value => child.send(value), terminate() {
            if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
            return child.exited;
          } };
          log(`provider process pid=${child.pid}`);
        } else {
          const thread = new Worker(options.worker, { type: "module" });
          thread.onerror = () => fail("provider worker error");
          thread.onmessage = event => replyToDevice(event.data);
          worker = thread;
        }
        worker.postMessage({ init: options.data });
        log("transport connected; waiting for paired device requests");
      } catch { fail("provider executor could not start"); }
    });
    const requestFromDevice = (raw: string) => {
      const request = JSON.parse(raw) as OffloadRequest;
      if (request.v === 1 && request.id === 0 && request.method === "offload.metrics" && typeof request.payload === "string" && request.payload.length < 160) {
        options.log?.(`Device ${request.payload}`); return canRead();
      }
      if (request.v !== 1 || !Number.isSafeInteger(request.id) || request.id < 1 || request.id > 0xffffffff ||
          typeof request.method !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.method) ||
          typeof request.payload !== "string" || request.payload.length > OFFLOAD.payloadChars ||
          request.response !== undefined && request.response !== "image" ||
          pending.size >= OFFLOAD.pending || pending.has(request.id)) throw new Error("Invalid request");
      pending.set(request.id, request.response === "image");
      deadlines.set(request.id, setTimeout(() => fail(`request deadline: ${request.method} id=${request.id}`), 9000));
      worker!.postMessage(request);
      return canRead();
    };
    function read() {
      if (closed || socket.destroyed) return;
      try {
        if (held && canRead()) {
          consumed += decoder.push(held.subarray(consumed), requestFromDevice, canRead);
          if (consumed === held.length) { held = undefined; consumed = 0; }
        }
        if (canRead() && !held) socket.resume(); else socket.pause();
      } catch { fail("invalid device request or provider unavailable"); }
    }
    function flush() {
      if (closed || socket.destroyed) return;
      while (!writing && replies.length) writing = !socket.write(replies.shift()!);
      read();
    }
    socket.on("drain", () => { writing = false; flush(); });
    socket.on("data", chunk => {
      socket.pause();
      if (held) return fail("device input credit exceeded");
      held = typeof chunk === "string" ? Buffer.from(chunk) : chunk; consumed = 0; read();
    });
    socket.on("error", (error: NodeJS.ErrnoException) => { reason = `socket ${error.code ?? "error"}`; });
    socket.on("close", () => {
      closed = true;
      clearTimeout(connecting);
      for (const timer of deadlines.values()) clearTimeout(timer);
      if (worker) log(`disconnected: ${reason}; pending=${pending.size}`);
      else if (!stopped && reason !== lastConnectFailure) { log(`waiting for device: ${reason}`); lastConnectFailure = reason; }
      held = undefined; replies.length = 0; pending.clear(); deadlines.clear();
      // Reap the old process before starting another; its late replies cannot
      // enter a replacement session, including after request IDs restart.
      const reconnect = () => {
        if (!stopped) retry = setTimeout(attach, 1500);
      };
      Promise.resolve().then(() => worker?.terminate()).then(reconnect, reconnect);
    });
  };
  attach();
  return { close() { stopped = true; clearTimeout(retry); closeCurrent(); } };
}

/** Worker-side allowlist. A missing method cannot open arbitrary resources. */
export async function dispatchOffload(
  methods: Readonly<Record<string, (payload: string) => string | OffloadImage | Promise<string | OffloadImage>>>,
  request: OffloadRequest,
): Promise<OffloadProviderReply> {
  try {
    const handler = Object.prototype.hasOwnProperty.call(methods, request.method) ? methods[request.method] : undefined;
    if (!handler) throw new Error("Capability not granted");
    const payload = await handler(request.payload);
    if (typeof payload !== "string") {
      if (request.response !== "image") throw new Error("Image response was not requested");
      encodeOffloadImage(request.id, payload);
      return { id: request.id, image: payload };
    }
    if (payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
    const reply = { id: request.id, payload };
    encodeOffloadRecord(JSON.stringify(reply));
    return reply;
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message.slice(0, 160) : "Provider failed" };
  }
}
