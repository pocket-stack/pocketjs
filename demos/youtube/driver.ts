// demos/youtube/driver.ts — the effect driver: runEffect("yt/*") -> the Mac.
//
// Two transports behind one driver, resolved lazily on first use:
//   - "usb": the svc mailbox ops (spec ops 30..33) — PSP under PSPLINK (or
//     PPSSPP with the service pointed at the memstick dir). Commands append
//     to out.jsonl; replies arrive via svcPoll, which pumpDriver() drains
//     once per frame (the app calls it from onFrame).
//   - "http": the browser host — fetch against the service's --http port.
//   - "none": neither — the app shows its connect screen and retries.
//
// Replies route by the echoed command id (protocol.ts); push messages with
// no id (e.g. "ended") go to the onHostPush subscriber.
//
// Cards are bulk bytes, not protocol lines: loadCard() queues them through a
// one-per-frame loader (a native loadImgFile is a ~15 KB synchronous USB
// read — twelve at once would hitch a whole frame's budget).

import { getOps, type HostOps } from "@pocketjs/framework/host";
import { installEffectDriver } from "@pocketjs/framework/effects";
import { packbitsDecode, PSM } from "../../spec/spec.ts";
import type { DeviceCmd, HostMsg } from "./protocol.ts";

const HTTP_BASE = "http://127.0.0.1:8620";

export type Transport = "usb" | "http" | "none";

let transport: Transport | null = null;
const pending = new Map<number, (msg: HostMsg) => void>();
let pushHandler: ((msg: HostMsg) => void) | null = null;
let httpEventCursor = 0;
let frameCounter = 0;

function ops(): HostOps {
  return getOps();
}

/** Resolve (and cache) the transport. Re-probes on every call while "none"
 *  so starting the Mac service after the app recovers without a reboot. */
export function resolveTransport(): Transport {
  if (transport && transport !== "none") return transport;
  const o = ops();
  if (o.svcOpen && o.svcOpen("youtube")) {
    transport = "usb";
    return transport;
  }
  transport = typeof fetch === "function" && !o.svcOpen ? "http" : "none";
  return transport;
}

export function onHostPush(handler: (msg: HostMsg) => void): void {
  pushHandler = handler;
}

function routeMsg(msg: HostMsg): void {
  const id = "id" in msg ? msg.id : undefined;
  const deliver = id !== undefined ? pending.get(id) : undefined;
  if (deliver) {
    pending.delete(id!);
    deliver(msg);
  } else {
    pushHandler?.(msg);
  }
}

/** Install the app's effect driver. Kinds: yt/hello|search|play|pause|
 *  resume|seek|stop, payload per protocol.ts minus t/id. */
export function installYoutubeDriver(): void {
  installEffectDriver((cmd, deliver) => {
    if (!cmd.kind.startsWith("yt/")) {
      throw new Error(`pocket-youtube driver: unknown effect kind "${cmd.kind}"`);
    }
    const wire = {
      t: cmd.kind.slice(3),
      id: cmd.id,
      ...(cmd.payload as Record<string, unknown> | undefined),
    } as DeviceCmd;
    const t = resolveTransport();
    if (t === "none") {
      deliver({ t: "error", id: cmd.id, message: "offline" } satisfies HostMsg);
      return;
    }
    pending.set(cmd.id, deliver as (msg: HostMsg) => void);
    if (t === "usb") {
      ops().svcSend?.(JSON.stringify(wire));
      return;
    }
    fetch(`${HTTP_BASE}/cmd`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(wire),
    })
      .then((r) => r.json())
      .then((msg) => routeMsg(msg as HostMsg))
      .catch(() => routeMsg({ t: "error", id: cmd.id, message: "host unreachable" }));
  });
}

/** Once-per-frame pump: drain svc lines (usb), poll pushes (http), and feed
 *  the card loader. The app root calls this from onFrame. */
export function pumpDriver(): void {
  frameCounter++;
  // Each svcPoll is a few usbhostfs round trips — every 5th frame keeps the
  // idle USB chatter down (same reasoning as the DevTools shim's 10) while
  // replies still land at human latency (+83 ms worst case).
  if (transport === "usb" && frameCounter % 5 === 0) {
    const batch = ops().svcPoll?.();
    if (batch) {
      for (const line of batch.split("\n")) {
        if (!line.trim()) continue;
        try {
          routeMsg(JSON.parse(line) as HostMsg);
        } catch {
          // a torn line stays in the file until complete; a malformed one is dropped
        }
      }
    }
  } else if (transport === "http" && frameCounter % 90 === 0) {
    fetch(`${HTTP_BASE}/events?since=${httpEventCursor}`)
      .then((r) => r.json())
      .then((j) => {
        const data = j as { next: number; events: HostMsg[] };
        httpEventCursor = data.next;
        for (const msg of data.events) {
          if (!("id" in msg)) pushHandler?.(msg);
        }
      })
      .catch(() => {});
  }
  pumpCards();
}

// ---------------------------------------------------------------------------
// Card textures (bulk side-file bytes -> texture handles, one per frame)
// ---------------------------------------------------------------------------

interface CardReq {
  path: string;
  cb: (handle: number) => void;
}

const cardQueue: CardReq[] = [];

/** Queue a card image; cb fires (possibly frames later) with a texture
 *  handle or -1. Callers own the handle (freeTexture on cleanup). */
export function loadCard(path: string, cb: (handle: number) => void): void {
  cardQueue.push({ path, cb });
}

function pumpCards(): void {
  const req = cardQueue.shift();
  if (!req) return;
  const o = ops();
  if (transport === "usb" && o.loadImgFile) {
    req.cb(o.loadImgFile(req.path));
    return;
  }
  if (transport === "http") {
    fetch(`${HTTP_BASE}/svc/${req.path}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => req.cb(uploadImgBlob(new Uint8Array(buf))))
      .catch(() => req.cb(-1));
    return;
  }
  req.cb(-1);
}

/** Upload an IMG-entry blob on hosts without the native op: uploadImgEntry
 *  when present, else parse (header + optional RLE) and uploadTexture. */
function uploadImgBlob(blob: Uint8Array): number {
  const o = ops();
  if (o.uploadImgEntry) return o.uploadImgEntry(blob);
  if (blob.length < 8) return -1;
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const w = dv.getUint16(0, true);
  const h = dv.getUint16(2, true);
  const psm = blob[4];
  const flags = blob[5];
  if (psm !== PSM.PSM_T8) return -1;
  const palette = blob.subarray(8, 8 + 1024);
  let stream: Uint8Array | null = blob.subarray(8 + 1024);
  if (flags & 1) stream = packbitsDecode(stream, w * h);
  if (!stream || stream.length !== w * h) return -1;
  const data = new Uint8Array(1024 + w * h);
  data.set(palette, 0);
  data.set(stream, 1024);
  return o.uploadTexture(data, w, h, PSM.PSM_T8);
}
