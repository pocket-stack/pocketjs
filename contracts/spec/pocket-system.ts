import type { JsonSchema } from "./pocket-manifest.ts";

export const POCKET_SYSTEM_VERSION = 1 as const;
export const POCKET_SYSTEM_SCHEMA_ID =
  "https://pocketjs.dev/schema/pocket-system-1.json";

/** Whether hidden application instances execute or suspend. */
export const BACKGROUND_EXECUTION_POLICIES = ["suspend", "continue"] as const;
export type BackgroundExecutionPolicy =
  (typeof BACKGROUND_EXECUTION_POLICIES)[number];

export interface PocketSystemPackageV1 {
  /** Stable Pocket package id; the referenced manifest must match it. */
  readonly package: string;
  /** Repository/package-relative Pocket manifest used at build/install time. */
  readonly manifest: string;
  /** Install policy. Required packages must appear in every installation snapshot. */
  readonly required: boolean;
  /** System-owned presentation metadata. It does not replace the package's
   *  resolved viewport or identity in the execution plan. */
  readonly presentation?: {
    readonly title: string;
    readonly viewport: readonly [width: number, height: number];
  };
}

/** Actual package state, separate from the System manifest's catalog/policy. */
export interface PocketSystemInstallationStateV1 {
  readonly installedPackages: readonly string[];
}

/** Product policy that remains stable across host implementations. */
export interface PocketSystemManifestV1 {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly roles: {
    /** Package id whose shell is presented to users as the System UI. */
    readonly systemUI: string;
  };
  readonly applications: {
    readonly installPolicy: {
      readonly model: "managed";
      readonly mutable: boolean;
    };
    /** Execution policy only. Memory residency is a separate future policy. */
    readonly backgroundExecution: BackgroundExecutionPolicy;
    readonly catalog: readonly PocketSystemPackageV1[];
  };
}

/**
 * Product-level System input. The manifest owns application catalog, install
 * policy, package roles and lifecycle policy; installation is the current
 * state supplied to resolution. Native hosts may implement execution with
 * actors, threads or processes without exposing that implementation here.
 */
export interface PocketSystemV1 extends PocketSystemManifestV1 {
  readonly $schema: typeof POCKET_SYSTEM_SCHEMA_ID;
  readonly pocketSystem: typeof POCKET_SYSTEM_VERSION;
  /** Current installation state. Catalog entries absent here are available. */
  readonly installation: PocketSystemInstallationStateV1;
}

const packageIdSchema = {
  type: "string",
  minLength: 3,
  pattern:
    "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$",
} as const satisfies JsonSchema;

export const pocketSystemV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POCKET_SYSTEM_SCHEMA_ID,
  title: "Pocket system, format 1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "pocketSystem",
    "id",
    "name",
    "title",
    "version",
    "roles",
    "applications",
    "installation",
  ],
  properties: {
    $schema: { const: POCKET_SYSTEM_SCHEMA_ID },
    pocketSystem: { const: POCKET_SYSTEM_VERSION },
    id: packageIdSchema,
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    },
    title: { type: "string", minLength: 1, maxLength: 128 },
    version: {
      type: "string",
      pattern:
        "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    },
    roles: {
      type: "object",
      additionalProperties: false,
      required: ["systemUI"],
      properties: {
        systemUI: packageIdSchema,
      },
    },
    applications: {
      type: "object",
      additionalProperties: false,
      required: ["installPolicy", "backgroundExecution", "catalog"],
      properties: {
        installPolicy: {
          type: "object",
          additionalProperties: false,
          required: ["model", "mutable"],
          properties: {
            model: { const: "managed" },
            mutable: { type: "boolean" },
          },
        },
        backgroundExecution: { enum: BACKGROUND_EXECUTION_POLICIES },
        catalog: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["package", "manifest", "required"],
            properties: {
              package: packageIdSchema,
              manifest: {
                type: "string",
                minLength: 1,
                pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.json$",
              },
              required: { type: "boolean" },
              presentation: {
                type: "object",
                additionalProperties: false,
                required: ["title", "viewport"],
                properties: {
                  title: { type: "string", minLength: 1, maxLength: 128 },
                  viewport: {
                    type: "array",
                    items: { type: "integer", minimum: 1 },
                    minItems: 2,
                    maxItems: 2,
                  },
                },
              },
            },
          },
        },
      },
    },
    installation: {
      type: "object",
      additionalProperties: false,
      required: ["installedPackages"],
      properties: {
        installedPackages: {
          type: "array",
          uniqueItems: true,
          items: packageIdSchema,
        },
      },
    },
  },
} as const satisfies JsonSchema;

export function generatePocketSystemV1Schema(): string {
  return JSON.stringify(pocketSystemV1Schema, null, 2) + "\n";
}
