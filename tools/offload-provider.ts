/** Desktop transport. Capability implementations execute in a Worker owned by
 * each authenticated device connection, never inside the socket callbacks. */
import { connect } from "node:net";
import { OFFLOAD, type OffloadRequest, type OffloadReply } from "../contracts/spec/offload.ts";
import { OffloadDecoder, encodeOffloadRecord } from "./offload-wire.ts";

export function connectOffloadProvider(options: {
  address: string; key: string; worker: string | URL; data?: unknown;
  port?: number; log?: (message: string) => void;
}) {
  if (!/^[0-9a-f]{64}$/.test(options.key)) throw new Error("Expected a 256-bit pairing key");
  let stopped = false;
  let closeCurrent = () => {};
  let retry: ReturnType<typeof setTimeout> | undefined;
  const attach = () => {
    if (stopped) return;
    const socket = connect({ host: options.address, port: options.port ?? OFFLOAD.port });
    const decoder = new OffloadDecoder();
    let worker: Worker | undefined;
    const pending = new Set<number>();
    const deadlines = new Map<number, ReturnType<typeof setTimeout>>();
    closeCurrent = () => socket.destroy();
    socket.setNoDelay(true);
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("connect", () => {
      socket.write(options.key);
      worker = new Worker(options.worker, { type: "module" });
      worker.postMessage({ init: options.data });
      worker.onerror = () => socket.destroy();
      worker.onmessage = (event: MessageEvent<OffloadReply>) => {
        const reply = event.data;
        if (!pending.delete(reply.id)) return socket.destroy();
        clearTimeout(deadlines.get(reply.id)); deadlines.delete(reply.id);
        try {
          if (typeof reply.payload === "string" && reply.payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
          const record = encodeOffloadRecord(JSON.stringify(reply));
          if (socket.writableLength > OFFLOAD.recordBytes * OFFLOAD.pending) return socket.destroy();
          socket.write(record);
        } catch { socket.destroy(); }
      };
      options.log?.("Transport connected; waiting for paired device requests");
    });
    socket.on("data", chunk => {
      try {
        decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk, raw => {
          const request = JSON.parse(raw) as OffloadRequest;
          if (request.v === 1 && request.id === 0 && request.method === "offload.metrics" && typeof request.payload === "string" && request.payload.length < 160) {
            options.log?.(`Device ${request.payload}`); return;
          }
          if (request.v !== 1 || !Number.isSafeInteger(request.id) || request.id < 1 ||
              typeof request.method !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.method) ||
              typeof request.payload !== "string" || request.payload.length > OFFLOAD.payloadChars ||
              pending.size >= OFFLOAD.pending || pending.has(request.id)) throw new Error("Invalid request");
          pending.add(request.id);
          // Terminate a wedged provider worker. Sent mutations are never retried.
          deadlines.set(request.id, setTimeout(() => socket.destroy(), 9000));
          worker!.postMessage(request);
        });
      } catch { socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      worker?.terminate();
      for (const timer of deadlines.values()) clearTimeout(timer);
      if (!stopped) retry = setTimeout(attach, 1500);
    });
  };
  attach();
  return { close() { stopped = true; clearTimeout(retry); closeCurrent(); } };
}

/** Worker-side allowlist. A missing method cannot open arbitrary resources. */
export async function dispatchOffload(
  methods: Readonly<Record<string, (payload: string) => string | Promise<string>>>,
  request: OffloadRequest,
): Promise<OffloadReply> {
  try {
    const handler = Object.prototype.hasOwnProperty.call(methods, request.method) ? methods[request.method] : undefined;
    if (!handler) throw new Error("Capability not granted");
    const payload = await handler(request.payload);
    if (payload.length > OFFLOAD.payloadChars) throw new Error("Result budget exceeded");
    const reply = { id: request.id, payload };
    encodeOffloadRecord(JSON.stringify(reply));
    return reply;
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message.slice(0, 160) : "Provider failed" };
  }
}
