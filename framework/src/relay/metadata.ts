/** Strict evaluator for the relay metadata JSON Schemas in
 * contracts/spec/relay.ts.
 *
 * The frame parser (frame.ts) validates the wire envelope; an L2 peer must
 * validate the op-specific metadata before acting on it. This evaluator
 * covers the schema subset the relay schemas use: object/array/string/
 * integer/boolean, required, additionalProperties:false, const, enum,
 * pattern, minLength/maxBytes (UTF-8 bytes), minimum/maximum, bounded arrays
 * with one item schema, and nested objects. It returns the first violation
 * or null; it never throws. */

import { RELAY_METADATA_SCHEMAS } from "../../../contracts/spec/relay.ts";

type Schema = Record<string, unknown>;

const utf8Bytes = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};

const isInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v);

function validate(schema: Schema, value: unknown, path: string): string | null {
  if (schema.type === "integer") {
    if (!isInt(value)) return `${path}: integer required`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: above maximum`;
    return null;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path}: string required`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path}: too short`;
    if (typeof schema.maxBytes === "number" && utf8Bytes(value) > schema.maxBytes) return `${path}: exceeds byte bound`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path}: pattern mismatch`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path}: not in enum`;
    if (typeof schema.const === "string" && value !== schema.const) return `${path}: const mismatch`;
    return null;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") return `${path}: boolean required`;
    if ("const" in schema && value !== schema.const) return `${path}: const mismatch`;
    return null;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path}: array required`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: too few items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: too many items`;
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const bad = validate(schema.items as Schema, value[i], `${path}[${i}]`);
        if (bad) return bad;
      }
    }
    return null;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return `${path}: object required`;
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) return `${path}.${key}: required`;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(props, key)) {
        return `${path}.${key}: unknown property`;
      }
    }
    if ("const" in schema && obj !== schema.const) return `${path}: const mismatch`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path}: not in enum`;
    for (const [key, sub] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const bad = validate(sub, obj[key], `${path}.${key}`);
        if (bad) return bad;
      }
    }
    return null;
  }
  return null;
}

/** Validate metadata against one named schema (e.g. "resource.get.request"). */
export function validateRelayMetadata(schemaName: string, metadata: unknown): string | null {
  const schema = RELAY_METADATA_SCHEMAS[schemaName] as Schema | undefined;
  if (!schema) return `unknown schema ${schemaName}`;
  return validate(schema, metadata, "$");
}

/** True when a named resource schema exists. */
export function hasRelayMetadataSchema(schemaName: string): boolean {
  return Object.prototype.hasOwnProperty.call(RELAY_METADATA_SCHEMAS, schemaName);
}
