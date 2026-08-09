// Byte codecs shared by the module SDKs (db, fs, net). Internal — not a
// framework subpath. QuickJS has no btoa/Buffer/TextEncoder/TextDecoder, so
// the codecs are spelled out; every caller is a cold path (payloads cross
// the boundary far less often than draw ops).

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

const B64_INV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INV[B64[i]] = i;

export function base64ToBytes(s: string): Uint8Array {
  while (s.endsWith("=")) s = s.slice(0, -1);
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64_INV[s[i]] << 18) |
      ((B64_INV[s[i + 1]] ?? 0) << 12) |
      ((B64_INV[s[i + 2]] ?? 0) << 6) |
      (B64_INV[s[i + 3]] ?? 0);
    out[o++] = n >> 16;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

/** UTF-8 encode. Lone surrogates become U+FFFD, so the output is always
 *  well-formed UTF-8 (the byte shape every module boundary requires). */
export function stringToUtf8(s: string): Uint8Array {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    let code = s.codePointAt(i)!;
    if (code > 0xffff) i++;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out[o++] = code;
    else if (code < 0x800) {
      out[o++] = 0xc0 | (code >> 6);
      out[o++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[o++] = 0xe0 | (code >> 12);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    } else {
      out[o++] = 0xf0 | (code >> 18);
      out[o++] = 0x80 | ((code >> 12) & 0x3f);
      out[o++] = 0x80 | ((code >> 6) & 0x3f);
      out[o++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

/** UTF-8 decode, strict: malformed sequences throw (a file that fails
 *  .text() is a bytes file — read it with .bytes()). */
export function utf8ToString(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const a = bytes[i++];
    if (a < 0x80) {
      out += String.fromCharCode(a);
      continue;
    }
    let n: number;
    let extra: number;
    if ((a & 0xe0) === 0xc0) {
      n = a & 0x1f;
      extra = 1;
    } else if ((a & 0xf0) === 0xe0) {
      n = a & 0x0f;
      extra = 2;
    } else if ((a & 0xf8) === 0xf0) {
      n = a & 0x07;
      extra = 3;
    } else {
      throw new Error("invalid UTF-8");
    }
    if (i + extra > bytes.length) throw new Error("invalid UTF-8");
    for (let k = 0; k < extra; k++) {
      const b = bytes[i++];
      if ((b & 0xc0) !== 0x80) throw new Error("invalid UTF-8");
      n = (n << 6) | (b & 0x3f);
    }
    // Reject overlong encodings and surrogate-range codepoints.
    if (
      n > 0x10ffff ||
      (n >= 0xd800 && n <= 0xdfff) ||
      (extra === 1 && n < 0x80) ||
      (extra === 2 && n < 0x800) ||
      (extra === 3 && n < 0x10000)
    ) {
      throw new Error("invalid UTF-8");
    }
    if (n < 0x10000) {
      out += String.fromCharCode(n);
    } else {
      n -= 0x10000;
      out += String.fromCharCode(0xd800 + (n >> 10), 0xdc00 + (n & 0x3ff));
    }
  }
  return out;
}
