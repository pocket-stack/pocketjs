/**
 * Allocation-bounded absolute HTTP(S) URL parser.
 *
 * The state transitions are a focused adaptation of the WHATWG special-URL
 * algorithms as implemented by pinned `whatwg-url@17.1.0`. UTS #46 data is
 * pinned separately to tr46 6.0.0 / Unicode 17.0.0. PocketJS deliberately
 * rejects credentials and applies strict DNS wire-length/STD3 checks because
 * the resulting hostname is also the manifest permission and TLS identity.
 * Sources and licenses are recorded in `vendor/url/README.md`.
 */

import {
  domainToAscii,
  IDNA_INPUT_CODE_UNITS_LIMIT,
} from "./vendor/url/tr46.ts";

export const HTTP_URL_INPUT_CODE_UNITS_LIMIT = 8192;
export const HTTP_URL_SERIALIZED_BYTES_LIMIT = 8192;
export const HTTP_URL_HOST_CODE_UNITS_LIMIT = IDNA_INPUT_CODE_UNITS_LIMIT;
export const HTTP_URL_PATH_SEGMENT_LIMIT = 1024;

export interface CanonicalHttpUrl {
  /** Serialized URL without a fragment, used for the HTTP wire target. */
  readonly href: string;
  readonly scheme: "http" | "https";
  /** Canonical DNS A-label or IP literal without IPv6 brackets. */
  readonly hostname: string;
  readonly hasFragment: boolean;
  /** Empty, or a serialized fragment beginning with `#`. */
  readonly fragment: string;
}

const functionCall = Function.prototype.call;
const bindCall = <Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
): ((receiver: unknown, ...args: Args) => Result) =>
  functionCall.bind(operation) as (receiver: unknown, ...args: Args) => Result;
const objectFreeze = Object.freeze;
const uint8ArrayConstructor = Uint8Array;
const arrayPop = bindCall(Array.prototype.pop);
const arrayPush = bindCall(Array.prototype.push);
const arraySlice = bindCall(Array.prototype.slice);
const numberToString = bindCall(Number.prototype.toString);
const stringCharCodeAt = bindCall(String.prototype.charCodeAt);
const stringCodePointAt = bindCall(String.prototype.codePointAt);
const stringIncludes = bindCall(String.prototype.includes);
const stringIndexOf = bindCall(String.prototype.indexOf);
const stringSlice = bindCall(String.prototype.slice);
const stringSplit = bindCall(String.prototype.split) as unknown as (
  receiver: string,
  separator: string,
) => string[];
const stringStartsWith = bindCall(String.prototype.startsWith);
const stringToLowerCase = bindCall(String.prototype.toLowerCase);
const stringFromCharCode = String.fromCharCode;
const stringFromCodePoint = String.fromCodePoint;
const mathFloor = Math.floor;

function charCodeAt(value: string, index: number): number {
  return stringCharCodeAt(value, index);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiAlphaNumeric(code: number): boolean {
  return isAsciiAlpha(code) || isAsciiDigit(code);
}

function isAsciiHex(code: number): boolean {
  return isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function hexValue(code: number): number {
  if (code <= 57) return code - 48;
  if (code <= 70) return code - 55;
  return code - 87;
}

function asciiLower(code: number): string {
  return stringFromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
}

function stripUrlWhitespace(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && charCodeAt(input, start) <= 0x20) start++;
  while (end > start && charCodeAt(input, end - 1) <= 0x20) end--;
  const value = stringSlice(input, start, end);
  let found = false;
  for (let index = 0; index < value.length; index++) {
    const code = charCodeAt(value, index);
    if (code === 9 || code === 10 || code === 13) {
      found = true;
      break;
    }
  }
  if (!found) return value;
  let cleaned = "";
  for (let index = 0; index < value.length; index++) {
    const code = charCodeAt(value, index);
    if (code !== 9 && code !== 10 && code !== 13) cleaned += value[index]!;
  }
  return cleaned;
}

function appendUtf8(bytes: Uint8Array, offset: number, codePoint: number): number {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
  if (codePoint <= 0x7f) {
    bytes[offset++] = codePoint;
  } else if (codePoint <= 0x7ff) {
    bytes[offset++] = 0xc0 | (codePoint >>> 6);
    bytes[offset++] = 0x80 | (codePoint & 0x3f);
  } else if (codePoint <= 0xffff) {
    bytes[offset++] = 0xe0 | (codePoint >>> 12);
    bytes[offset++] = 0x80 | ((codePoint >>> 6) & 0x3f);
    bytes[offset++] = 0x80 | (codePoint & 0x3f);
  } else {
    bytes[offset++] = 0xf0 | (codePoint >>> 18);
    bytes[offset++] = 0x80 | ((codePoint >>> 12) & 0x3f);
    bytes[offset++] = 0x80 | ((codePoint >>> 6) & 0x3f);
    bytes[offset++] = 0x80 | (codePoint & 0x3f);
  }
  return offset;
}

function utf8PercentDecode(input: string): string | null {
  if (input.length > HTTP_URL_HOST_CODE_UNITS_LIMIT) return null;
  const bytes = new uint8ArrayConstructor(input.length * 3);
  let byteLength = 0;
  for (let index = 0; index < input.length;) {
    const codePoint = stringCodePointAt(input, index)!;
    byteLength = appendUtf8(bytes, byteLength, codePoint);
    index += codePoint > 0xffff ? 2 : 1;
  }
  let decodedLength = 0;
  for (let read = 0; read < byteLength; read++) {
    const byte = bytes[read]!;
    if (byte === 0x25 && read + 2 < byteLength &&
        isAsciiHex(bytes[read + 1]!) && isAsciiHex(bytes[read + 2]!)) {
      bytes[decodedLength++] = (hexValue(bytes[read + 1]!) << 4) |
        hexValue(bytes[read + 2]!);
      read += 2;
    } else {
      bytes[decodedLength++] = byte;
    }
  }

  let output = "";
  for (let index = 0; index < decodedLength;) {
    const first = bytes[index++]!;
    let codePoint: number;
    let needed: number;
    let minimum: number;
    if (first <= 0x7f) {
      codePoint = first;
      needed = 0;
      minimum = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      needed = 1;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      needed = 2;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 7;
      needed = 3;
      minimum = 0x10000;
    } else {
      return null;
    }
    if (index + needed > decodedLength) return null;
    for (let count = 0; count < needed; count++) {
      const continuation = bytes[index++]!;
      if ((continuation & 0xc0) !== 0x80) return null;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
    output += stringFromCodePoint(codePoint);
  }
  return output;
}

function parseIpv4Number(input: string): number | null {
  if (input.length === 0) return null;
  let radix = 10;
  let offset = 0;
  if (input.length >= 2 && input[0] === "0" &&
      (input[1] === "x" || input[1] === "X")) {
    radix = 16;
    offset = 2;
  } else if (input.length >= 2 && input[0] === "0") {
    radix = 8;
    offset = 1;
  }
  if (offset === input.length) return 0;
  let value = 0;
  for (; offset < input.length; offset++) {
    const code = charCodeAt(input, offset);
    let digit: number;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 65 && code <= 70) digit = code - 55;
    else if (code >= 97 && code <= 102) digit = code - 87;
    else return null;
    if (digit >= radix || value > mathFloor((0xffffffff - digit) / radix)) return null;
    value = value * radix + digit;
  }
  return value;
}

function endsInNumber(input: string): boolean {
  let end = input.length;
  if (end > 0 && input[end - 1] === ".") end--;
  let start = end;
  while (start > 0 && input[start - 1] !== ".") start--;
  const last = stringSlice(input, start, end);
  if (last.length === 0) return false;
  let decimal = true;
  for (let index = 0; index < last.length; index++) {
    if (!isAsciiDigit(charCodeAt(last, index))) {
      decimal = false;
      break;
    }
  }
  return decimal || parseIpv4Number(last) !== null;
}

function canonicalIpv4(input: string): string | null {
  const parts = stringSplit(input, ".");
  if (parts[parts.length - 1] === "" && parts.length > 1) arrayPop(parts);
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (let index = 0; index < parts.length; index++) {
    const number = parseIpv4Number(parts[index]!);
    if (number === null) return null;
    arrayPush(numbers, number);
  }
  for (let index = 0; index < numbers.length - 1; index++) {
    if (numbers[index]! > 255) return null;
  }
  const lastLimit = 256 ** (5 - numbers.length);
  if (numbers[numbers.length - 1]! >= lastLimit) return null;
  let address = numbers[numbers.length - 1]!;
  for (let index = 0; index < numbers.length - 1; index++) {
    address += numbers[index]! * 256 ** (3 - index);
  }
  let output = "";
  for (let index = 0; index < 4; index++) {
    const divisor = 256 ** (3 - index);
    if (index > 0) output += ".";
    output += numberToString(mathFloor(address / divisor) % 256);
  }
  return output;
}

function parseEmbeddedIpv4(input: string): readonly [number, number] | null {
  const parts = stringSplit(input, ".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (let index = 0; index < 4; index++) {
    const part = parts[index]!;
    if (part.length === 0 || (part.length > 1 && part[0] === "0")) return null;
    let value = 0;
    for (let cursor = 0; cursor < part.length; cursor++) {
      const code = charCodeAt(part, cursor);
      if (!isAsciiDigit(code)) return null;
      value = value * 10 + code - 48;
      if (value > 255) return null;
    }
    arrayPush(octets, value);
  }
  return [
    (octets[0]! << 8) | octets[1]!,
    (octets[2]! << 8) | octets[3]!,
  ];
}

function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];
  const pieces = stringSplit(side, ":");
  const output: number[] = [];
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!;
    if (stringIncludes(piece, ".")) {
      if (index !== pieces.length - 1) return null;
      const embedded = parseEmbeddedIpv4(piece);
      if (embedded === null) return null;
      arrayPush(output, embedded[0], embedded[1]);
      continue;
    }
    if (piece.length === 0 || piece.length > 4) return null;
    let value = 0;
    for (let cursor = 0; cursor < piece.length; cursor++) {
      const code = charCodeAt(piece, cursor);
      if (!isAsciiHex(code)) return null;
      value = value * 16 + hexValue(code);
    }
    arrayPush(output, value);
  }
  return output;
}

function ipv6Groups(input: string): number[] | null {
  if (stringIncludes(input, "%") || stringIncludes(input, "[") || stringIncludes(input, "]")) {
    return null;
  }
  const separator = stringIndexOf(input, "::");
  if (separator >= 0 && stringIndexOf(input, "::", separator + 2) >= 0) return null;
  if (separator < 0) {
    const groups = parseIpv6Side(input);
    return groups?.length === 8 ? groups : null;
  }
  const left = parseIpv6Side(stringSlice(input, 0, separator));
  const right = parseIpv6Side(stringSlice(input, separator + 2));
  if (left === null || right === null) return null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  const groups = arraySlice(left) as number[];
  for (let index = 0; index < omitted; index++) arrayPush(groups, 0);
  for (let index = 0; index < right.length; index++) arrayPush(groups, right[index]!);
  return groups;
}

function canonicalIpv6(input: string): string | null {
  const groups = ipv6Groups(input);
  if (groups === null || groups.length !== 8) return null;
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < groups.length;) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < groups.length && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  if (bestStart < 0) {
    let output = "";
    for (let index = 0; index < groups.length; index++) {
      if (index > 0) output += ":";
      output += numberToString(groups[index]!, 16);
    }
    return output;
  }
  let before = "";
  for (let index = 0; index < bestStart; index++) {
    if (index > 0) before += ":";
    before += numberToString(groups[index]!, 16);
  }
  let after = "";
  for (let index = bestStart + bestLength; index < groups.length; index++) {
    if (after !== "") after += ":";
    after += numberToString(groups[index]!, 16);
  }
  return `${before}::${after}`;
}

function canonicalDomain(rawHost: string): string | null {
  const decoded = utf8PercentDecode(rawHost);
  if (decoded === null || decoded.length === 0) return null;
  let withoutRoot = decoded;
  const last = decoded[decoded.length - 1];
  if (last === "." || last === "\u3002" || last === "\uff0e" || last === "\uff61") {
    withoutRoot = stringSlice(decoded, 0, -1);
  }
  if (withoutRoot.length === 0) return null;
  const beforeLast = withoutRoot[withoutRoot.length - 1];
  if (beforeLast === "." || beforeLast === "\u3002" ||
      beforeLast === "\uff0e" || beforeLast === "\uff61") return null;
  return domainToAscii(withoutRoot);
}

function percentEncodedByte(byte: number): string {
  const hex = "0123456789ABCDEF";
  return `%${hex[(byte >>> 4) & 15]}${hex[byte & 15]}`;
}

type EncodeSet = "path" | "query" | "fragment";

function shouldPercentEncode(byte: number, set: EncodeSet): boolean {
  if (byte <= 0x1f || byte > 0x7e || byte === 0x20 || byte === 0x22 ||
      byte === 0x3c || byte === 0x3e) return true;
  if (set === "fragment") return byte === 0x60;
  if (byte === 0x23) return true;
  if (set === "query") return byte === 0x27;
  return byte === 0x3f || byte === 0x60 || byte === 0x7b ||
    byte === 0x7d || byte === 0x5e;
}

function encodeComponent(input: string, set: EncodeSet): string {
  let output = "";
  const bytes = new uint8ArrayConstructor(4);
  for (let cursor = 0; cursor < input.length;) {
    const codePoint = stringCodePointAt(input, cursor)!;
    const length = appendUtf8(bytes, 0, codePoint);
    cursor += codePoint > 0xffff ? 2 : 1;
    for (let index = 0; index < length; index++) {
      const byte = bytes[index]!;
      output += shouldPercentEncode(byte, set)
        ? percentEncodedByte(byte)
        : stringFromCharCode(byte);
      if (output.length > HTTP_URL_SERIALIZED_BYTES_LIMIT) {
        throw new TypeError("HTTP URL serialization exceeds the 8192-byte safety ceiling");
      }
    }
  }
  return output;
}

function appendSerialized(current: string, addition: string): string {
  if (current.length + addition.length > HTTP_URL_SERIALIZED_BYTES_LIMIT) {
    throw new TypeError("HTTP URL serialization exceeds the 8192-byte safety ceiling");
  }
  return current + addition;
}

function isSingleDot(segment: string): boolean {
  return segment === "." || stringToLowerCase(segment) === "%2e";
}

function isDoubleDot(segment: string): boolean {
  const lower = stringToLowerCase(segment);
  return lower === ".." || lower === ".%2e" || lower === "%2e." || lower === "%2e%2e";
}

interface ParsedTail {
  readonly pathAndQuery: string;
  readonly hasFragment: boolean;
  readonly fragment: string;
}

function parseTail(input: string, start: number): ParsedTail {
  let fragmentStart = -1;
  let queryStart = -1;
  for (let index = start; index < input.length; index++) {
    const character = input[index]!;
    if (character === "#") {
      fragmentStart = index;
      break;
    }
    if (character === "?" && queryStart < 0) queryStart = index;
  }
  const pathEnd = queryStart >= 0 ? queryStart : fragmentStart >= 0 ? fragmentStart : input.length;
  let rawPath = "";
  for (let index = start; index < pathEnd; index++) {
    rawPath += input[index] === "\\" ? "/" : input[index]!;
  }
  const segments: string[] = [];
  let cursor = stringStartsWith(rawPath, "/") ? 1 : 0;
  let segmentStart = cursor;
  for (; cursor <= rawPath.length; cursor++) {
    if (cursor < rawPath.length && rawPath[cursor] !== "/") continue;
    const segment = encodeComponent(stringSlice(rawPath, segmentStart, cursor), "path");
    const slash = cursor < rawPath.length;
    if (isDoubleDot(segment)) {
      if (segments.length > 0) arrayPop(segments);
      if (!slash) arrayPush(segments, "");
    } else if (isSingleDot(segment)) {
      if (!slash) arrayPush(segments, "");
    } else {
      arrayPush(segments, segment);
    }
    if (segments.length > HTTP_URL_PATH_SEGMENT_LIMIT) {
      throw new TypeError("HTTP URL exceeds the 1024 path-segment safety ceiling");
    }
    segmentStart = cursor + 1;
  }
  if (segments.length === 0) arrayPush(segments, "");
  let pathAndQuery = "";
  for (let index = 0; index < segments.length; index++) {
    pathAndQuery = appendSerialized(pathAndQuery, `/${segments[index]}`);
  }
  if (queryStart >= 0) {
    const queryEnd = fragmentStart >= 0 ? fragmentStart : input.length;
    pathAndQuery = appendSerialized(
      pathAndQuery,
      `?${encodeComponent(stringSlice(input, queryStart + 1, queryEnd), "query")}`,
    );
  }
  const fragment = fragmentStart < 0
    ? ""
    : `#${encodeComponent(stringSlice(input, fragmentStart + 1), "fragment")}`;
  return { pathAndQuery, hasFragment: fragmentStart >= 0, fragment };
}

function parsePort(input: string, scheme: "http" | "https"): string | null {
  if (input === "") return "";
  let value = 0;
  for (let index = 0; index < input.length; index++) {
    const code = charCodeAt(input, index);
    if (!isAsciiDigit(code)) return null;
    value = value * 10 + code - 48;
    if (value > 65535) return null;
  }
  if ((scheme === "http" && value === 80) || (scheme === "https" && value === 443)) {
    return "";
  }
  return `:${value}`;
}

/** Parse and serialize an absolute WHATWG special `http:` or `https:` URL. */
export function canonicalizeHttpUrl(input: string): CanonicalHttpUrl {
  if (input.length > HTTP_URL_INPUT_CODE_UNITS_LIMIT) {
    throw new TypeError("HTTP URL exceeds the 8192-code-unit input safety ceiling");
  }
  const source = stripUrlWhitespace(input);
  if (source.length === 0 || !isAsciiAlpha(charCodeAt(source, 0))) {
    throw new TypeError("HTTP URL must be an absolute http(s) URL");
  }
  let cursor = 0;
  let rawScheme = "";
  while (cursor < source.length) {
    const code = charCodeAt(source, cursor);
    if (code === 0x3a) break;
    if (cursor > 0 && !(isAsciiAlphaNumeric(code) || code === 0x2b || code === 0x2d || code === 0x2e)) {
      throw new TypeError("HTTP URL has an invalid scheme");
    }
    rawScheme += asciiLower(code);
    cursor++;
  }
  if (cursor >= source.length || source[cursor] !== ":" ||
      (rawScheme !== "http" && rawScheme !== "https")) {
    throw new TypeError("HTTP URL must use http: or https:");
  }
  const scheme = rawScheme;
  cursor++;
  while (cursor < source.length && (source[cursor] === "/" || source[cursor] === "\\")) cursor++;
  const authorityStart = cursor;
  let insideBrackets = false;
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === "[") insideBrackets = true;
    else if (character === "]") insideBrackets = false;
    if (!insideBrackets && (character === "/" || character === "\\" ||
        character === "?" || character === "#")) break;
    cursor++;
  }
  const authority = stringSlice(source, authorityStart, cursor);
  if (authority.length === 0) throw new TypeError("HTTP URL must have a hostname");
  if (stringIncludes(authority, "@")) {
    throw new TypeError("PocketJS HTTP URLs must not contain credentials");
  }

  let hostname: string;
  let serializedHost: string;
  let rawPort: string | undefined;
  if (authority[0] === "[") {
    const close = stringIndexOf(authority, "]");
    if (close <= 1) throw new TypeError("HTTP URL has an invalid IPv6 address");
    const ipv6 = canonicalIpv6(stringSlice(authority, 1, close));
    if (ipv6 === null) throw new TypeError("HTTP URL has an invalid IPv6 address");
    const suffix = stringSlice(authority, close + 1);
    if (suffix !== "" && suffix[0] !== ":") {
      throw new TypeError("HTTP URL has an invalid IPv6 authority");
    }
    hostname = ipv6;
    serializedHost = `[${ipv6}]`;
    if (suffix !== "") rawPort = stringSlice(suffix, 1);
  } else {
    const colon = stringIndexOf(authority, ":");
    const rawHost = colon < 0 ? authority : stringSlice(authority, 0, colon);
    if (colon >= 0) rawPort = stringSlice(authority, colon + 1);
    if (rawHost.length === 0 || rawHost.length > HTTP_URL_HOST_CODE_UNITS_LIMIT) {
      throw new TypeError("HTTP URL hostname exceeds its safety ceiling");
    }
    const domain = canonicalDomain(rawHost);
    if (domain === null) throw new TypeError("HTTP URL has an invalid IDNA hostname");
    if (endsInNumber(domain)) {
      const ipv4 = canonicalIpv4(domain);
      if (ipv4 === null) throw new TypeError("HTTP URL has an invalid IPv4 address");
      hostname = ipv4;
    } else {
      hostname = domain;
    }
    serializedHost = hostname;
  }
  const port = rawPort === undefined ? "" : parsePort(rawPort, scheme);
  if (port === null) throw new TypeError("HTTP URL has an invalid port");
  const tail = parseTail(source, cursor);
  const href = `${scheme}://${serializedHost}${port}${tail.pathAndQuery}`;
  if (href.length + tail.fragment.length > HTTP_URL_SERIALIZED_BYTES_LIMIT) {
    throw new TypeError("HTTP URL serialization exceeds the 8192-byte safety ceiling");
  }
  return objectFreeze({
    href,
    scheme,
    hostname,
    hasFragment: tail.hasFragment,
    fragment: tail.fragment,
  }) as CanonicalHttpUrl;
}
