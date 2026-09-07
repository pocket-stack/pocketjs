/** PSPLINK host0 adapter. Immutable response files are atomically replaced;
 * eight reusable request slots bound disk and worker backlog. Codecs stay in
 * the same process-isolated executor used by the LAN provider. */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  OFFLOAD,
  type OffloadRequest,
  type OffloadProviderReply,
} from "../contracts/spec/offload.ts";
import { validateMesh } from "./offload-wire.ts";
export const USB_HEADER = 64,
  USB_MAGIC = 0x31424f50;
export const usbSlot = (app: string) =>
  createHash("sha256").update(app).digest("hex").slice(0, 16);
export function usbHash(bytes: Uint8Array) {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
export function usbPacket(
  epoch: number,
  boot: number,
  sequence: number,
  kind: number,
  id: number,
  width: number,
  height: number,
  payload: Uint8Array,
) {
  const b = Buffer.alloc(USB_HEADER + payload.length);
  for (const [at, value] of [
    [0, USB_MAGIC],
    [4, epoch],
    [8, boot],
    [12, sequence],
    [16, kind],
    [20, id],
    [24, width],
    [28, height],
    [32, payload.length],
    [36, usbHash(payload)],
  ])
    b.writeUInt32LE(value >>> 0, at);
  b.set(payload, USB_HEADER);
  return b;
}
export function connectOffloadUsbProvider(options: {
  directory: string;
  app: string;
  worker: string | URL;
  data?: unknown;
  log?(message: string): void;
}) {
  const root = resolve(
    options.directory,
    "pocket-offload",
    usbSlot(options.app),
  );
  mkdirSync(root, { recursive: true });
  let epoch = randomBytes(4).readUInt32LE() || 1;
  const pending = new Map<
    number,
    {
      slot: number;
      boot: number;
      sequence: number;
      request: OffloadRequest;
      at: number;
    }
  >();
  const seen = Array(8).fill("");
  let stopped = false,
    heartbeat = 0,
    serial = 0,
    loaded = false,
    lastStats = "";
  function publish(name: string, bytes: Uint8Array) {
    const path = resolve(root, name);
    writeFileSync(path + ".tmp", bytes);
    renameSync(path + ".tmp", path);
  }
  function offline() {
    try {
      unlinkSync(resolve(root, "ready"));
    } catch {}
  }
  const entry =
    options.worker instanceof URL
      ? options.worker.href
      : pathToFileURL(resolve(options.worker)).href;
  let child: ReturnType<typeof Bun.spawn>;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  function spawn() {
    child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("./offload-process.ts", import.meta.url)),
        entry,
      ],
      {
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        serialization: "advanced",
        ipc(reply: OffloadProviderReply) {
          if (
            !reply ||
            typeof reply !== "object" ||
            !Number.isSafeInteger(reply.id)
          )
            return;
          const p = pending.get(reply.id);
          if (!p || stopped || !loaded) return;
          pending.delete(reply.id);
          if (seen[p.slot] !== `${p.boot}/${p.sequence}`) return;
          try {
            let kind = 0,
              width = 0,
              height = 0,
              payload: Uint8Array;
            if (reply.mesh) {
              if (p.request.response !== "mesh")
                throw Error("Unrequested mesh");
              ({ width, height } = validateMesh(reply.mesh.bytes));
              kind = 1;
              payload = reply.mesh.bytes;
            } else if (reply.image) {
              const im = reply.image;
              if (
                p.request.response !== "image" ||
                im.format !== "r5g6b5" ||
                ![im.width, im.height].every(
                  (n) =>
                    Number.isInteger(n) &&
                    n >= 16 &&
                    n <= 256 &&
                    !(n & (n - 1)),
                ) ||
                im.pixels.length !== im.width * im.height * 2
              )
                throw Error("Invalid image");
              kind = 2;
              width = im.width;
              height = im.height;
              payload = im.pixels;
            } else {
              payload = Buffer.from(
                JSON.stringify({ ...reply, id: p.request.id }),
              );
              if (payload.length > OFFLOAD.recordBytes)
                throw Error("JSON budget exceeded");
            }
            publish(
              `res${p.slot}`,
              usbPacket(
                epoch,
                p.boot,
                p.sequence,
                kind,
                p.request.id,
                width,
                height,
                payload,
              ),
            );
            options.log?.(
              `USB reply ${p.request.method} id=${p.request.id} bytes=${payload.length} ms=${Date.now() - p.at}${reply.error ? ` error=${reply.error}` : ""}`,
            );
          } catch (error) {
            publish(
              `res${p.slot}`,
              usbPacket(
                epoch,
                p.boot,
                p.sequence,
                0,
                p.request.id,
                0,
                0,
                Buffer.from(
                  JSON.stringify({
                    id: p.request.id,
                    error: String(error).slice(0, 160),
                  }),
                ),
              ),
            );
          }
        },
        onExit() {
          loaded = false;
          offline();
          pending.clear();
          seen.fill("");
          options.log?.("USB provider executor stopped");
          if (!stopped)
            restartTimer = setTimeout(() => {
              epoch = randomBytes(4).readUInt32LE() || 1;
              spawn();
            }, 500);
        },
      },
    );
    child.send({ init: options.data });
    loaded = true;
  }
  spawn();
  const pulse = setInterval(() => {
    if (!loaded || stopped) return;
    const b = Buffer.alloc(USB_HEADER);
    b.writeUInt32LE(USB_MAGIC, 0);
    b.writeUInt32LE(epoch, 4);
    b.writeUInt32LE(++heartbeat, 8);
    publish("ready", b);
    try {
      const b = readFileSync(resolve(root, "stats"));
      const s = b.toString();
      if (s.length > 0 && s !== lastStats) {
        lastStats = s;
        options.log?.(`PSP ${s.trim()}`);
      }
    } catch {}
  }, 250);
  const pump = setInterval(() => {
    if (stopped || !loaded) return;
    for (let slot = 0; slot < 8 && pending.size < 8; slot++) {
      let b: Buffer;
      try {
        const path = resolve(root, `req${slot}`);
        if (statSync(path).size > USB_HEADER + OFFLOAD.recordBytes) continue;
        b = readFileSync(path);
      } catch {
        continue;
      }
      if (
        b.length < USB_HEADER ||
        b.length > USB_HEADER + OFFLOAD.recordBytes ||
        b.readUInt32LE(0) !== USB_MAGIC ||
        b.readUInt32LE(4) !== epoch
      )
        continue;
      const boot = b.readUInt32LE(8),
        sequence = b.readUInt32LE(12),
        key = `${boot}/${sequence}`;
      if (
        !boot ||
        !sequence ||
        seen[slot] === key ||
        b.readUInt32LE(32) !== b.length - USB_HEADER ||
        usbHash(b.subarray(USB_HEADER)) !== b.readUInt32LE(36)
      )
        continue;
      let request: OffloadRequest;
      try {
        request = JSON.parse(b.toString("utf8", USB_HEADER));
      } catch {
        continue;
      }
      if (
        !request ||
        typeof request !== "object" ||
        request.v !== 1 ||
        !Number.isSafeInteger(request.id) ||
        request.id < 1 ||
        request.id > 0xffffffff ||
        typeof request.method !== "string" ||
        !/^[a-z][a-z0-9_.-]{0,63}$/.test(request.method) ||
        typeof request.payload !== "string" ||
        request.payload.length > OFFLOAD.payloadChars ||
        (request.response !== undefined &&
          request.response !== "image" &&
          request.response !== "mesh")
      )
        continue;
      seen[slot] = key;
      const id = ++serial;
      pending.set(id, { slot, boot, sequence, request, at: Date.now() });
      child.send({ ...request, id });
    }
    // Execution credit is released only after the child exits. A timeout
    // rotates the entire session; late replies cannot attach to a new slot.
    for (const p of pending.values())
      if (Date.now() - p.at > 12000) {
        loaded = false;
        offline();
        child.kill();
        break;
      }
  }, 10);
  options.log?.(`USB provider ${root}`);
  return {
    root,
    get epoch() {
      return epoch;
    },
    close() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      clearInterval(pulse);
      clearInterval(pump);
      offline();
      if (child.exitCode === null) child.kill();
    },
  };
}
