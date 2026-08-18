/**
 * QuickJS-safe one-shot UTF-8 codecs for the HTTP SDK. These functions do not
 * read TextEncoder, TextDecoder, Buffer, or any other optional global.
 */

const Uint8ArrayIntrinsic = Uint8Array;
const StringIntrinsic = String;
const reflectApply = Reflect.apply;
const stringCharCodeAt = StringIntrinsic.prototype.charCodeAt;
const stringFromCharCode = StringIntrinsic.fromCharCode;
const arrayJoin = Array.prototype.join;
const numberIsSafeInteger = Number.isSafeInteger;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8ArrayIntrinsic.prototype,
) as object;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;

const REPLACEMENT_CODE_POINT = 0xfffd;
const DECODE_CHUNK_CODE_UNITS = 256;

function codeUnitAt(value: string, index: number): number {
  return reflectApply(stringCharCodeAt, value, [index]) as number;
}

function scalarAt(value: string, index: number): number {
  const first = codeUnitAt(value, index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
    const second = codeUnitAt(value, index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
    }
  }
  return first >= 0xd800 && first <= 0xdfff
    ? REPLACEMENT_CODE_POINT
    : first;
}

function encodedScalarBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Encode with TextEncoder's USVString replacement behavior. A null result
 * means the exact output would exceed maximumBytes; no output allocation has
 * occurred in that case.
 */
export function encodeUtf8(
  value: string,
  maximumBytes: number,
): Uint8Array | null {
  if (!numberIsSafeInteger(maximumBytes) || maximumBytes < 0) return null;

  let byteLength = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = scalarAt(value, index);
    const required = encodedScalarBytes(codePoint);
    if (byteLength > maximumBytes - required) return null;
    byteLength += required;
    index += codePoint > 0xffff ? 2 : 1;
  }

  const output = new Uint8ArrayIntrinsic(byteLength);
  let offset = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = scalarAt(value, index);
    index += codePoint > 0xffff ? 2 : 1;
    if (codePoint <= 0x7f) {
      output[offset++] = codePoint;
    } else if (codePoint <= 0x7ff) {
      output[offset++] = 0xc0 | (codePoint >> 6);
      output[offset++] = 0x80 | (codePoint & 0x3f);
    } else if (codePoint <= 0xffff) {
      output[offset++] = 0xe0 | (codePoint >> 12);
      output[offset++] = 0x80 | ((codePoint >> 6) & 0x3f);
      output[offset++] = 0x80 | (codePoint & 0x3f);
    } else {
      output[offset++] = 0xf0 | (codePoint >> 18);
      output[offset++] = 0x80 | ((codePoint >> 12) & 0x3f);
      output[offset++] = 0x80 | ((codePoint >> 6) & 0x3f);
      output[offset++] = 0x80 | (codePoint & 0x3f);
    }
  }
  return output;
}

/**
 * Decode one complete UTF-8 byte sequence with TextDecoder's default
 * replacement behavior. A leading UTF-8 BOM is omitted; later BOMs remain.
 * A null result means the input exceeds maximumBytes.
 */
export function decodeUtf8(
  bytes: Uint8Array,
  maximumBytes: number,
): string | null {
  if (!numberIsSafeInteger(maximumBytes) || maximumBytes < 0) return null;
  const byteLength = reflectApply(typedArrayByteLength, bytes, []) as number;
  if (byteLength > maximumBytes) return null;

  const pieces: string[] = [];
  let codeUnits: number[] = [];
  let firstScalar = true;

  const flush = (): void => {
    if (codeUnits.length === 0) return;
    pieces[pieces.length] = reflectApply(
      stringFromCharCode,
      StringIntrinsic,
      codeUnits,
    ) as string;
    codeUnits = [];
  };

  const append = (codePoint: number): void => {
    if (firstScalar) {
      firstScalar = false;
      if (codePoint === 0xfeff) return;
    }
    if (codePoint <= 0xffff) {
      if (codeUnits.length === DECODE_CHUNK_CODE_UNITS) flush();
      codeUnits[codeUnits.length] = codePoint;
      return;
    }
    if (codeUnits.length > DECODE_CHUNK_CODE_UNITS - 2) flush();
    const scalar = codePoint - 0x10000;
    codeUnits[codeUnits.length] = 0xd800 + (scalar >> 10);
    codeUnits[codeUnits.length] = 0xdc00 + (scalar & 0x3ff);
  };

  let index = 0;
  while (index < byteLength) {
    const first = bytes[index]!;
    if (first <= 0x7f) {
      index++;
      append(first);
      continue;
    }

    let continuationCount = 0;
    let codePoint = 0;
    let secondMinimum = 0x80;
    let secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      continuationCount = 1;
      codePoint = first & 0x1f;
    } else if (first >= 0xe0 && first <= 0xef) {
      continuationCount = 2;
      codePoint = first & 0x0f;
      if (first === 0xe0) secondMinimum = 0xa0;
      if (first === 0xed) secondMaximum = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      continuationCount = 3;
      codePoint = first & 0x07;
      if (first === 0xf0) secondMinimum = 0x90;
      if (first === 0xf4) secondMaximum = 0x8f;
    } else {
      index++;
      append(REPLACEMENT_CODE_POINT);
      continue;
    }

    let cursor = index + 1;
    let complete = true;
    for (let offset = 0; offset < continuationCount; offset++) {
      if (cursor === byteLength) {
        index = cursor;
        append(REPLACEMENT_CODE_POINT);
        complete = false;
        break;
      }
      const continuation = bytes[cursor]!;
      const minimum = offset === 0 ? secondMinimum : 0x80;
      const maximum = offset === 0 ? secondMaximum : 0xbf;
      if (continuation < minimum || continuation > maximum) {
        // Reconsume the offending byte, matching the replacement-mode UTF-8
        // decoder's maximal-subpart behavior.
        index = cursor;
        append(REPLACEMENT_CODE_POINT);
        complete = false;
        break;
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
      cursor++;
    }
    if (complete) {
      index = cursor;
      append(codePoint);
    }
  }

  flush();
  return reflectApply(arrayJoin, pieces, [""]) as string;
}
