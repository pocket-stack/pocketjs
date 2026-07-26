import {
  EXECUTION_CLASSES,
  PRESENTATION_MODES,
  type ExecutionClass,
  type PresentationMode,
  type Viewport,
} from "./platforms.ts";

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
  /**
   * Execution classes this package ships as; omitted means ["guest"].
   * Declaring "aot" states that the entry compiles under an AOT family
   * (Pocket Vapor/Static) whose admission is compile-time derived demands
   * against a board profile, not this manifest's capability ids. A package
   * whose classes exclude "guest" is refused by the guest build resolver.
   * Per-class blocks (e.g. an `aot` section) hang off this object later.
   */
  readonly execution?: {
    readonly classes: readonly ExecutionClass[];
  };
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
    readonly viewport: ManifestViewport;
  };
}

/** A fixed-screen viewport declaration (takeover/kiosk/embedded targets). */
export interface FixedViewportSpec {
  readonly logical: Viewport;
  readonly presentation: PresentationMode;
}

/** A dynamic-window viewport declaration (window/widget targets). */
export interface DynamicViewportSpec {
  readonly default: Viewport;
  readonly min?: Viewport;
  readonly max?: Viewport;
}

/**
 * Apps declare viewport intent per POLICY, not per target: `fixed` admits
 * on fixed-screen forms, `dynamic` on window forms; declaring both makes a
 * dual-nature app. The bare `{logical, presentation}` spelling remains
 * valid as shorthand for `{fixed: …}` (format-2 compatibility).
 */
export type ManifestViewport =
  | FixedViewportSpec
  | {
      readonly fixed?: FixedViewportSpec;
      readonly dynamic?: DynamicViewportSpec;
    };

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
    execution: {
      type: "object",
      additionalProperties: false,
      required: ["classes"],
      properties: {
        classes: {
          type: "array",
          items: { enum: EXECUTION_CLASSES },
          minItems: 1,
          uniqueItems: true,
        },
      },
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
          anyOf: [
            // Shorthand: a bare fixed viewport (format-2 compatibility).
            {
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
            // Policy variants: fixed and/or dynamic. An empty object is
            // schema-valid but semantically caught by the resolver
            // (viewport.fixedRequired / viewport.dynamicRequired).
            {
              type: "object",
              additionalProperties: false,
              properties: {
                fixed: {
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
                dynamic: {
                  type: "object",
                  additionalProperties: false,
                  required: ["default"],
                  properties: {
                    default: {
                      type: "array",
                      items: { type: "integer", minimum: 1 },
                      minItems: 2,
                      maxItems: 2,
                    },
                    min: {
                      type: "array",
                      items: { type: "integer", minimum: 1 },
                      minItems: 2,
                      maxItems: 2,
                    },
                    max: {
                      type: "array",
                      items: { type: "integer", minimum: 1 },
                      minItems: 2,
                      maxItems: 2,
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
} as const satisfies JsonSchema;

export function generatePocketManifestV2Schema(): string {
  return JSON.stringify(pocketManifestV2Schema, null, 2) + "\n";
}
