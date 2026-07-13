import { PRESENTATION_MODES, type PresentationMode, type Viewport } from "./platforms.ts";

export const POCKET_MANIFEST_VERSION = 2 as const;
export const POCKET_MANIFEST_SCHEMA_ID = "https://pocketjs.dev/schema/pocket-2.json";

export type JsonPrimitive = boolean | number | string;
export type JsonValue = JsonPrimitive | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchemaObject {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: "array" | "boolean" | "integer" | "number" | "object" | "string";
  readonly const?: JsonValue;
  readonly enum?: readonly JsonValue[];
  readonly anyOf?: readonly JsonSchema[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type JsonSchema = boolean | JsonSchemaObject;

export interface PocketManifestV2 {
  readonly $schema: typeof POCKET_MANIFEST_SCHEMA_ID;
  readonly pocket: typeof POCKET_MANIFEST_VERSION;
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly engine: {
    readonly capabilities: {
      readonly requires: readonly string[];
      readonly enhances?: readonly string[];
    };
  };
  readonly app: {
    readonly entry: string;
    readonly output?: string;
    readonly framework: "solid" | "vue-vapor";
    readonly viewport: {
      readonly logical: Viewport;
      readonly presentation: PresentationMode;
    };
  };
}

const capabilityIdSchema = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$",
} as const satisfies JsonSchema;

/** Strict format-2 application intent. Platform facts stay in target profiles. */
export const pocketManifestV2Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POCKET_MANIFEST_SCHEMA_ID,
  title: "Pocket application manifest, format 2",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "pocket", "id", "name", "title", "version", "engine", "app"],
  properties: {
    $schema: { const: POCKET_MANIFEST_SCHEMA_ID },
    pocket: { const: POCKET_MANIFEST_VERSION },
    id: {
      type: "string",
      minLength: 3,
      pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    },
    title: { type: "string", minLength: 1, maxLength: 128 },
    version: {
      type: "string",
      pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    },
    engine: {
      type: "object",
      additionalProperties: false,
      required: ["capabilities"],
      properties: {
        capabilities: {
          type: "object",
          additionalProperties: false,
          required: ["requires"],
          properties: {
            requires: {
              type: "array",
              items: capabilityIdSchema,
              minItems: 1,
              uniqueItems: true,
            },
            enhances: {
              type: "array",
              items: capabilityIdSchema,
              uniqueItems: true,
            },
          },
        },
      },
    },
    app: {
      type: "object",
      additionalProperties: false,
      required: ["entry", "framework", "viewport"],
      properties: {
        entry: {
          type: "string",
          minLength: 1,
          pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.tsx?$",
        },
        output: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
        },
        framework: { enum: ["solid", "vue-vapor"] },
        viewport: {
          type: "object",
          additionalProperties: false,
          required: ["logical", "presentation"],
          properties: {
            logical: {
              type: "array",
              items: { type: "integer", minimum: 1 },
              minItems: 2,
              maxItems: 2,
            },
            presentation: { enum: PRESENTATION_MODES },
          },
        },
      },
    },
  },
} as const satisfies JsonSchema;

export function generatePocketManifestV2Schema(): string {
  return JSON.stringify(pocketManifestV2Schema, null, 2) + "\n";
}
