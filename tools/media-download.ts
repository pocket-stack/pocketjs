/** Immutable transfer file: header, PKMV stream, keyframe index, UTF-8 WebVTT.
 * The native storage worker commits the file only after its CRC matches. */
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { MediaSource } from "../contracts/spec/media.ts";

export const MEDIA_DOWNLOAD = { headerBytes: 256, chunkBytes: 32768, maxBytes: 0x7fffffff, maxCaptions: 4 * 1024 * 1024, indexRecordBytes: 12 } as const;
export function mediaCRC(bytes: Uint8Array, crc = 0xffffffff): number {
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return crc >>> 0;
}
export function downloadHeader(input: { mediaBytes: number; indexBytes: number; captionBytes: number; durationMs: number; crc: number; title: string; language: string }) {
  const { mediaBytes, indexBytes, captionBytes, durationMs } = input;
  if (![mediaBytes, indexBytes, captionBytes, durationMs].every(v => Number.isInteger(v) && v >= 0)
    || (mediaBytes !== 0 && mediaBytes < 48) || indexBytes % 12 || indexBytes > 86401 * 12
    || captionBytes > MEDIA_DOWNLOAD.maxCaptions || durationMs > 86400000
    || mediaBytes + indexBytes + captionBytes + 256 > MEDIA_DOWNLOAD.maxBytes
    || (!!mediaBytes !== !!indexBytes)) throw new Error("Invalid download sizes");
  const out = Buffer.alloc(256); out.write("PKDL"); out.writeUInt16LE(1, 4); out.writeUInt16LE(256, 6);
  [mediaBytes, indexBytes, captionBytes, durationMs, input.crc >>> 0].forEach((v, i) => out.writeUInt32LE(v, 8 + i * 4));
  const utf8 = (text: string, at: number, max: number) => {
    let bytes = Buffer.from(text.replace(/[\x00-\x1f]/g, " "));
    if (bytes.length >= max) { let end = max - 1; while ((bytes[end] & 0xc0) === 0x80) end--; bytes = bytes.subarray(0, end); }
    out.set(bytes, at);
  };
  utf8(input.title, 32, 160); utf8(input.language, 192, 32);
  return out;
}

/** A ticket is single use. Each acknowledged 32 KiB block permits the next
 * disk read; neither the producer nor the native socket queue grows with film length. */
export async function createMediaDownloadServer(options: { advertiseHost: string; port?: number }) {
  type Ticket = { path: string; expires: number; release: () => void };
  const tickets = new Map<string, Ticket>(), connections = new Map<Socket, () => void>();
  const server = createServer(socket => {
    socket.setNoDelay(true); socket.setTimeout(15000, () => socket.destroy()); socket.on("error", () => {});
    let token = Buffer.alloc(0), started = false, credit = false, wake: (() => void) | undefined;
    const release = () => { wake?.(); }; connections.set(socket, release);
    socket.once("close", () => { connections.delete(socket); release(); });
    socket.on("data", (chunk: Buffer) => {
      if (started) {
        if (chunk.length !== 1 || chunk[0] !== 1 || credit) return socket.destroy();
        credit = true; wake?.(); wake = undefined; return;
      }
      token = Buffer.concat([token, chunk]);
      if (token.length > 64) return socket.destroy();
      if (token.length !== 64) return;
      started = true;
      const ticket = tickets.get(token.toString()); tickets.delete(token.toString());
      if (!ticket || ticket.expires < Date.now()) { ticket?.release(); return socket.destroy(); }
      void (async () => {
        let file: Awaited<ReturnType<typeof open>> | undefined;
        try {
          file = await open(ticket.path, "r");
          const size = (await file.stat()).size;
          for (let offset = 0; offset < size;) {
            const count = offset === 0 ? 256 : Math.min(MEDIA_DOWNLOAD.chunkBytes, size - offset);
            const bytes = Buffer.alloc(count);
            if ((await file.read(bytes, 0, count, offset)).bytesRead !== count) throw new Error("Truncated download");
            if (socket.destroyed) break;
            socket.write(bytes); offset += count;
            while (!credit && !socket.destroyed) await new Promise<void>(resolve => { wake = resolve; });
            credit = false;
          }
          socket.end();
        } catch { socket.destroy(); }
        finally { await file?.close(); ticket.release(); }
      })();
    });
  });
  const expiry = setInterval(() => { for (const [token, ticket] of tickets) if (ticket.expires < Date.now()) { tickets.delete(token); ticket.release(); } }, 10000);
  expiry.unref();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "0.0.0.0", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing download listener");
  return {
    async publish(path: string, release: () => void = () => {}): Promise<MediaSource> {
      if (tickets.size + connections.size >= 4 || (await stat(path)).size > MEDIA_DOWNLOAD.maxBytes) throw new Error("Download capacity exceeded");
      const token = randomBytes(32).toString("hex"); tickets.set(token, { path, expires: Date.now() + 120000, release });
      return { host: options.advertiseHost, port: address.port, token };
    },
    close() { clearInterval(expiry); for (const ticket of tickets.values()) ticket.release(); tickets.clear(); for (const socket of connections.keys()) socket.destroy(); server.close(); },
  };
}
