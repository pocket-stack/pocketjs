import type { JsonSchema } from "./pocket-manifest.ts";
import {
  PRESENTATION_MODES,
  type PocketCapabilityId,
  type PresentationMode,
  type TargetForm,
  type Viewport,
} from "./platforms.ts";

export const POCKET_IDF_UI_CAPABILITIES = [
  "input.analog.left",
  "input.buttons",
  "input.cursor",
  "input.touch",
  "text.glyphs.baked",
] as const satisfies readonly PocketCapabilityId[];

export const POCKET_IDF_HOST_VERSION = 1 as const;
export const POCKET_IDF_HOST_SCHEMA_ID = "https://pocketjs.dev/schema/pocket-idf-host-1.json";
export const POCKET_IDF_HOST_ABI = 1 as const;

export interface PocketIdfHostProfile {
  readonly $schema: typeof POCKET_IDF_HOST_SCHEMA_ID;
  readonly version: typeof POCKET_IDF_HOST_VERSION;
  /** Package target label. The .pocket variant table reserves 15 UTF-8 bytes. */
  readonly id: string;
  readonly platform: "esp-idf";
  readonly form: Extract<TargetForm, "takeover" | "kiosk" | "embedded">;
  readonly tickHz: number;
  readonly display: {
    readonly physicalViewport: Viewport;
    readonly logicalViewports: readonly Viewport[];
    readonly presentations: readonly PresentationMode[];
    readonly rasterDensity: number;
  };
  readonly capabilities: readonly PocketCapabilityId[];
}

const viewportSchema = {
  type: "array",
  items: { type: "integer", minimum: 1, maximum: 65535 },
  minItems: 2,
  maxItems: 2,
} as const satisfies JsonSchema;

export const pocketIdfHostSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POCKET_IDF_HOST_SCHEMA_ID,
  title: "PocketJS ESP-IDF host profile, format 1",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "version", "id", "platform", "form", "tickHz", "display", "capabilities"],
  properties: {
    $schema: { const: POCKET_IDF_HOST_SCHEMA_ID },
    version: { const: POCKET_IDF_HOST_VERSION },
    id: {
      type: "string",
      minLength: 1,
      maxLength: 15,
      pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    },
    platform: { const: "esp-idf" },
    form: { enum: ["takeover", "kiosk", "embedded"] },
    tickHz: { type: "integer", minimum: 1, maximum: 240 },
    display: {
      type: "object",
      additionalProperties: false,
      required: ["physicalViewport", "logicalViewports", "presentations", "rasterDensity"],
      properties: {
        physicalViewport: viewportSchema,
        logicalViewports: {
          type: "array",
          description: "Touch-capable profiles are additionally limited to 512x512 logical coordinates.",
          items: viewportSchema,
          minItems: 1,
          uniqueItems: true,
        },
        presentations: {
          type: "array",
          items: { enum: PRESENTATION_MODES },
          minItems: 1,
          uniqueItems: true,
        },
        rasterDensity: { type: "integer", minimum: 1, maximum: 255 },
      },
    },
    capabilities: {
      type: "array",
      items: { enum: POCKET_IDF_UI_CAPABILITIES },
      minItems: 1,
      uniqueItems: true,
    },
  },
} as const satisfies JsonSchema;

export function generatePocketIdfHostSchema(): string {
  return JSON.stringify(pocketIdfHostSchema, null, 2) + "\n";
}
