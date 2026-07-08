// scripts/devtools-bridge.ts — the PSPLINK USB mailbox bridge as a module
// (DEVTOOLS.md §3). Owns pocketjs-dbg/{enable,in,out}.jsonl inside a
// usbhostfs-served dir, tails the device's out.jsonl into the WS hub and
// appends panel commands to in.jsonl. Consumers: scripts/devtools-psp.ts
// (thin CLI) and scripts/devtools.ts (the one-command orchestrator).
//
// Screenshot path: the device dumps raw VRAM to pocketjs-dbg/shot.raw and
// emits {t:"screenshotRaw"} on the mailbox; we intercept it here (never
// forwarded), crop the 512-px GE stride to 480 and encode the PNG the
// panel expects — the ~550 KB of pixels ride usbhostfs, not the JSON
// channel.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { encodePNG } from "../test/png.ts";

export interface BridgeEvent {
  type: "hub-connected" | "hub-lost" | "device-talking" | "hello" | "screenshot";
  detail?: string;
}

export interface BridgeOptions {
  /** usbhostfs root the PSP mounts as host0: */
  dir: string;
  /** dev-server (WS hub) port */
  port: number;
  onEvent?: (e: BridgeEvent) => void;
}

export interface Bridge {
  boxDir: string;
  stop(): void;
}

export function startBridge(opts: BridgeOptions): Bridge {
  const emit = opts.onEvent ?? (() => {});
  const boxDir = join(opts.dir, "pocketjs-dbg");
  const enablePath = join(boxDir, "enable");
  const inPath = join(boxDir, "in.jsonl");
  const outPath = join(boxDir, "out.jsonl");

  mkdirSync(boxDir, { recursive: true });
  writeFileSync(enablePath, "pocket devtools mailbox\n");
  writeFileSync(inPath, "");
  writeFileSync(outPath, "");

  let stopped = false;
  let ws: WebSocket | null = null;
  let backoff = 500;

  function connect(): void {
    if (stopped) return;
    const sock = new WebSocket(`ws://127.0.0.1:${opts.port}/ws?role=device`);
    sock.onopen = () => {
      backoff = 500;
      emit({ type: "hub-connected" });
    };
    sock.onmessage = (e) => {
      // Panel command -> mailbox. One JSON object per WS message; the PSP
      // splits batched lines itself.
      if (typeof e.data === "string" && e.data.trim()) {
        try {
          appendFileSync(inPath, e.data.trim() + "\n");
        } catch {
          // usbhostfs restart mid-write — the panel can just resend
        }
      }
    };
    sock.onclose = () => {
      ws = null;
      if (stopped) return;
      emit({ type: "hub-lost" });
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 8000);
    };
    sock.onerror = () => {
      // close fires next; stay quiet (the hub may not be up yet)
    };
    ws = sock;
  }
  connect();

  /** shot.raw -> data URL PNG (crop the 512-px stride to w x h). The GE
   *  writes the framebuffer with alpha 0 (the PSP display ignores it), so
   *  force it opaque — same reason e2e converts with `-alpha off`. */
  function convertShot(file: string, w: number, h: number, stride: number): string | null {
    const raw = readFileSync(join(boxDir, file));
    if (raw.length < stride * h * 4) return null;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      raw.copy(rgba, y * w * 4, y * stride * 4, y * stride * 4 + w * 4);
    }
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return "data:image/png;base64," + encodePNG(rgba, w, h).toString("base64");
  }

  function handleDeviceLine(line: string): void {
    let msg: Record<string, unknown> | null = null;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    if (msg?.t === "hello") emit({ type: "hello", detail: String(msg.app ?? "?") });
    if (msg?.t === "screenshotRaw") {
      try {
        const data = convertShot(
          String(msg.file ?? "shot.raw"),
          Number(msg.w ?? 480),
          Number(msg.h ?? 272),
          Number(msg.stride ?? 512),
        );
        if (data && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ t: "screenshot", frame: msg.frame ?? 0, data }));
          emit({ type: "screenshot", detail: `frame ${msg.frame}` });
        }
      } catch {
        // partial write — the user can click again
      }
      return; // never forward the raw notice itself
    }
    if (ws && ws.readyState === 1) ws.send(line);
  }

  let offset = 0;
  let sawDevice = false;
  const tail = setInterval(() => {
    let size: number;
    try {
      size = statSync(outPath).size;
    } catch {
      return; // file vanished (usbhostfs restart) — recreated on next write
    }
    if (size < offset) offset = 0; // truncated/recreated: start over
    if (size === offset) return;
    const buf = readFileSync(outPath);
    const text = buf.subarray(offset, size).toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return; // partial line: wait for the device to finish it
    offset += Buffer.byteLength(text.slice(0, lastNl + 1), "utf8");
    for (const line of text.slice(0, lastNl).split("\n")) {
      if (!line.trim()) continue;
      handleDeviceLine(line);
    }
    if (!sawDevice) {
      sawDevice = true;
      emit({ type: "device-talking" });
    }
  }, 100);

  return {
    boxDir,
    stop() {
      stopped = true;
      clearInterval(tail);
      ws?.close();
      try {
        if (existsSync(enablePath)) rmSync(enablePath);
      } catch {
        // usbhostfs may already be gone
      }
    },
  };
}
