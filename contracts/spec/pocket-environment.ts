import type { JsonSchema } from "./pocket-manifest.ts";

export const POCKET_ENVIRONMENT_VERSION = 1 as const;
export const POCKET_ENVIRONMENT_SCHEMA_ID =
  "https://pocketjs.dev/schema/pocket-environment-1.json";

/**
 * Installation is environment state, deliberately outside RuntimeSupervisor:
 *
 * - required: installed and cannot be removed (normally the shell)
 * - installed: installed now and may be removed by a mutable environment
 * - available: known to the environment but not currently installed
 */
export const ENVIRONMENT_INSTALLATION_STATES = [
  "required",
  "installed",
  "available",
] as const;
export type EnvironmentInstallationState =
  (typeof ENVIRONMENT_INSTALLATION_STATES)[number];

/** Background realm policy applied by the native runtime supervisor. */
export const SUPERVISOR_BACKGROUND_POLICIES = ["visible", "resident"] as const;
export type SupervisorBackgroundPolicy =
  (typeof SUPERVISOR_BACKGROUND_POLICIES)[number];

export interface PocketEnvironmentPackageV1 {
  /** Stable Pocket package id; the referenced manifest must match it. */
  readonly package: string;
  /** Repository/package-relative Pocket manifest used at build/install time. */
  readonly manifest: string;
  readonly installation: EnvironmentInstallationState;
  /** Environment-owned presentation metadata. It does not replace the
   *  package's resolved viewport or identity in the runtime plan. */
  readonly presentation?: {
    readonly title: string;
    readonly viewport: readonly [width: number, height: number];
  };
}

/**
 * Product-level environment specification. A desktop, headless service,
 * mobile SpringBoard-like shell, and handheld launcher can share the same
 * package/supervisor contracts while providing different installation models
 * and UI/UX. The supervisor consumes the installed set after resolution; it
 * never installs or uninstalls packages itself.
 */
export interface PocketEnvironmentV1 {
  readonly $schema: typeof POCKET_ENVIRONMENT_SCHEMA_ID;
  readonly pocketEnvironment: typeof POCKET_ENVIRONMENT_VERSION;
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly runtime: {
    readonly supervisor: {
      /** Package id of the environment shell. */
      readonly shell: string;
      /** Hidden installed realms either suspend or keep ticking. */
      readonly background: SupervisorBackgroundPolicy;
    };
  };
  readonly applications: {
    /** The environment owns install/uninstall state even when the first
     *  product release only ships a preinstalled catalog. */
    readonly model: "managed";
    readonly mutable: boolean;
    readonly packages: readonly PocketEnvironmentPackageV1[];
  };
}

const packageIdSchema = {
  type: "string",
  minLength: 3,
  pattern:
    "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$",
} as const satisfies JsonSchema;

export const pocketEnvironmentV1Schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POCKET_ENVIRONMENT_SCHEMA_ID,
  title: "Pocket environment, format 1",
  type: "object",
  additionalProperties: false,
  required: [
    "$schema",
    "pocketEnvironment",
    "id",
    "name",
    "title",
    "version",
    "runtime",
    "applications",
  ],
  properties: {
    $schema: { const: POCKET_ENVIRONMENT_SCHEMA_ID },
    pocketEnvironment: { const: POCKET_ENVIRONMENT_VERSION },
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
    runtime: {
      type: "object",
      additionalProperties: false,
      required: ["supervisor"],
      properties: {
        supervisor: {
          type: "object",
          additionalProperties: false,
          required: ["shell", "background"],
          properties: {
            shell: packageIdSchema,
            background: { enum: SUPERVISOR_BACKGROUND_POLICIES },
          },
        },
      },
    },
    applications: {
      type: "object",
      additionalProperties: false,
      required: ["model", "mutable", "packages"],
      properties: {
        model: { const: "managed" },
        mutable: { type: "boolean" },
        packages: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["package", "manifest", "installation"],
            properties: {
              package: packageIdSchema,
              manifest: {
                type: "string",
                minLength: 1,
                pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\).+\\.json$",
              },
              installation: { enum: ENVIRONMENT_INSTALLATION_STATES },
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
  },
} as const satisfies JsonSchema;

export function generatePocketEnvironmentV1Schema(): string {
  return JSON.stringify(pocketEnvironmentV1Schema, null, 2) + "\n";
}
