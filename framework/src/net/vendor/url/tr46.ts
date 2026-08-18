/**
 * Bounded UTS #46 processing for PocketJS HTTP hostnames.
 *
 * Algorithm and Unicode data are pinned to tr46 6.0.0 / Unicode 17.0.0.
 * The packed table is decoded in-place: no 9,262-row JS object graph is ever
 * constructed. See README.md and tools/generate-url-idna-table.ts.
 */

import { decode as punycodeDecode, encode as punycodeEncode } from "./punycode.ts";
import {
  TR46_MAPPING_BLOB,
  TR46_TABLE_ENTRY_COUNT,
  TR46_TABLE_RECORDS,
} from "./idna-data.generated.ts";
import {
  bidiDomain,
  bidiS1LTR,
  bidiS1RTL,
  bidiS2,
  bidiS3,
  bidiS4AN,
  bidiS4EN,
  bidiS5,
  bidiS6,
  combiningClassVirama,
  combiningMarks,
  validZWNJ,
} from "./idna-regexes.generated.ts";

const STATUS_MAPPED = 1;
const STATUS_VALID = 2;
const STATUS_DISALLOWED = 3;
const STATUS_DEVIATION = 6;
const STATUS_IGNORED = 7;
const RECORD_CHARACTERS = 8;
const LOOKUP_ITERATION_LIMIT = 16;
export const IDNA_INPUT_CODE_UNITS_LIMIT = 1024;
export const IDNA_LABEL_LIMIT = 128;
export const IDNA_ASCII_HOST_BYTES_LIMIT = 253;
export const IDNA_ASCII_LABEL_BYTES_LIMIT = 63;

const functionCall = Function.prototype.call;
const bindCall = <Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
): ((receiver: unknown, ...args: Args) => Result) =>
  functionCall.bind(operation) as (receiver: unknown, ...args: Args) => Result;
const stringCharCodeAt = bindCall(String.prototype.charCodeAt);
const stringCodePointAt = bindCall(String.prototype.codePointAt);
const stringEndsWith = bindCall(String.prototype.endsWith);
const stringNormalize = bindCall(String.prototype.normalize);
const stringSlice = bindCall(String.prototype.slice);
const stringSplit = bindCall(String.prototype.split) as unknown as (
  receiver: string,
  separator: string,
) => string[];
const stringStartsWith = bindCall(String.prototype.startsWith);
const regexpTest = bindCall(RegExp.prototype.test);
const arrayPush = bindCall(Array.prototype.push);
const stringFromCodePoint = String.fromCodePoint;
const mathFloor = Math.floor;

function callCharCodeAt(value: string, index: number): number {
  return stringCharCodeAt(value, index);
}

function base64ValueAt(index: number): number {
  const code = callCharCodeAt(TR46_TABLE_RECORDS, index);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return 0;
}

function recordByte(index: number, byte: number): number {
  const offset = index * RECORD_CHARACTERS;
  const group = byte < 3 ? offset : offset + 4;
  const within = byte % 3;
  if (within === 0) {
    return (base64ValueAt(group) << 2) | (base64ValueAt(group + 1) >>> 4);
  }
  if (within === 1) {
    return ((base64ValueAt(group + 1) & 15) << 4) |
      (base64ValueAt(group + 2) >>> 2);
  }
  return ((base64ValueAt(group + 2) & 3) << 6) | base64ValueAt(group + 3);
}

function recordEnd(index: number): number {
  return recordByte(index, 0) | (recordByte(index, 1) << 8) |
    (recordByte(index, 2) << 16);
}

function findRow(codePoint: number): number {
  let start = 0;
  let end = TR46_TABLE_ENTRY_COUNT - 1;
  for (let iteration = 0; iteration < LOOKUP_ITERATION_LIMIT && start < end; iteration++) {
    const middle = mathFloor((start + end) / 2);
    if (recordEnd(middle) < codePoint) start = middle + 1;
    else end = middle;
  }
  return start < TR46_TABLE_ENTRY_COUNT && recordEnd(start) >= codePoint ? start : -1;
}

function recordStatus(index: number): number {
  return recordByte(index, 5) & 7;
}

function recordMapping(index: number): string {
  const offset = recordByte(index, 3) | (recordByte(index, 4) << 8);
  const length = recordByte(index, 5) >>> 3;
  return stringSlice(TR46_MAPPING_BLOB, offset, offset + length);
}

function regexMatches(expression: RegExp, value: string): boolean {
  return regexpTest(expression, value);
}

function containsNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (callCharCodeAt(value, index) > 0x7f) return true;
  }
  return false;
}

function mapCharacters(domain: string): string | null {
  let output = "";
  for (let index = 0; index < domain.length;) {
    const codePoint = stringCodePointAt(domain, index)!;
    const character = stringFromCodePoint(codePoint);
    index += codePoint > 0xffff ? 2 : 1;
    const row = findRow(codePoint);
    if (row < 0) return null;
    switch (recordStatus(row)) {
      case STATUS_MAPPED:
        output += recordMapping(row);
        break;
      case STATUS_IGNORED:
        break;
      case STATUS_VALID:
      case STATUS_DEVIATION:
      case STATUS_DISALLOWED:
        output += character;
        break;
      default:
        return null;
    }
    if (output.length > IDNA_INPUT_CODE_UNITS_LIMIT * 4) return null;
  }
  return stringNormalize(output, "NFC");
}

function isBidiDomain(labels: readonly string[]): boolean {
  let decoded = "";
  for (let index = 0; index < labels.length; index++) {
    let label = labels[index]!;
    if (stringStartsWith(label, "xn--")) {
      try {
        label = punycodeDecode(stringSlice(label, 4));
      } catch {
        label = "";
      }
    }
    if (index > 0) decoded += ".";
    decoded += label;
  }
  return regexMatches(bidiDomain, decoded);
}

function validateLabel(label: string, bidi: boolean): boolean {
  if (label.length === 0 || stringNormalize(label, "NFC") !== label) return false;
  const codePoints: string[] = [];
  for (let index = 0; index < label.length;) {
    const codePoint = stringCodePointAt(label, index)!;
    arrayPush(codePoints, stringFromCodePoint(codePoint));
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (codePoints.length === 0 || codePoints.length > IDNA_INPUT_CODE_UNITS_LIMIT) return false;
  if ((codePoints[2] === "-" && codePoints[3] === "-") ||
      stringStartsWith(label, "-") || stringEndsWith(label, "-")) return false;
  if (regexMatches(combiningMarks, codePoints[0]!)) return false;

  for (let index = 0; index < codePoints.length; index++) {
    const character = codePoints[index]!;
    const codePoint = stringCodePointAt(character, 0)!;
    const row = findRow(codePoint);
    if (row < 0) return false;
    const status = recordStatus(row);
    if (status !== STATUS_VALID && status !== STATUS_DEVIATION) return false;
    if (codePoint <= 0x7f &&
        !((codePoint >= 0x61 && codePoint <= 0x7a) ||
          (codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x2d)) return false;
  }

  let lastJoiner = 0;
  for (let index = 0; index < codePoints.length; index++) {
    const character = codePoints[index]!;
    if (character !== "\u200c" && character !== "\u200d") continue;
    if (index > 0 && regexMatches(combiningClassVirama, codePoints[index - 1]!)) continue;
    if (character === "\u200c") {
      let next = -1;
      for (let cursor = index + 1; cursor < codePoints.length; cursor++) {
        if (codePoints[cursor] === "\u200c") {
          next = cursor;
          break;
        }
      }
      let context = "";
      const limit = next < 0 ? codePoints.length : next;
      for (let cursor = lastJoiner; cursor < limit; cursor++) context += codePoints[cursor];
      if (regexMatches(validZWNJ, context)) {
        lastJoiner = index + 1;
        continue;
      }
    }
    return false;
  }

  if (!bidi) return true;
  const first = codePoints[0]!;
  if (regexMatches(bidiS1LTR, first)) {
    return regexMatches(bidiS5, label) && regexMatches(bidiS6, label);
  }
  if (!regexMatches(bidiS1RTL, first)) return false;
  return regexMatches(bidiS2, label) &&
    regexMatches(bidiS3, label) &&
    !(regexMatches(bidiS4EN, label) && regexMatches(bidiS4AN, label));
}

/** Strict, non-transitional UTS #46 ToASCII for an endpoint DNS name. */
export function domainToAscii(domain: string): string | null {
  if (domain.length === 0 || domain.length > IDNA_INPUT_CODE_UNITS_LIMIT) return null;
  const mapped = mapCharacters(domain);
  if (mapped === null || mapped.length === 0) return null;
  const labels = stringSplit(mapped, ".");
  if (labels.length === 0 || labels.length > IDNA_LABEL_LIMIT) return null;
  const bidi = isBidiDomain(labels);
  let output = "";

  for (let index = 0; index < labels.length; index++) {
    let label = labels[index]!;
    if (stringStartsWith(label, "xn--")) {
      if (containsNonAscii(label)) return null;
      try {
        label = punycodeDecode(stringSlice(label, 4));
      } catch {
        return null;
      }
      if (label.length === 0 || !containsNonAscii(label)) return null;
    }
    if (!validateLabel(label, bidi)) return null;
    let ascii = label;
    if (containsNonAscii(label)) {
      try {
        ascii = `xn--${punycodeEncode(label)}`;
      } catch {
        return null;
      }
    }
    if (ascii.length === 0 || ascii.length > IDNA_ASCII_LABEL_BYTES_LIMIT) return null;
    if (index > 0) output += ".";
    output += ascii;
    if (output.length > IDNA_ASCII_HOST_BYTES_LIMIT) return null;
  }
  return output;
}
