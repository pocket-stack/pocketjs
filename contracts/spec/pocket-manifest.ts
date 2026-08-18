import {
  EXECUTION_CLASSES,
  PRESENTATION_MODES,
  type ExecutionClass,
  type PresentationMode,
  type Viewport,
} from "./platforms.ts";

export const POCKET_MANIFEST_VERSION = 2 as const;
export const POCKET_MANIFEST_SCHEMA_ID = "https://pocketjs.dev/schema/pocket-2.json";
export const POCKET_MANIFEST_V3_VERSION = 3 as const;
export const POCKET_MANIFEST_V3_SCHEMA_ID = "https://pocketjs.dev/schema/pocket-3.json";

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
    readonly framework: "solid" | "vue-vapor" | "octane";
    readonly viewport: ManifestViewport;
  };
}

export const NETWORK_CONNECT_PROTOCOLS = [
  "http",
  "https",
  "ws",
  "wss",
  "mqtt",
  "mqtts",
  "tcp",
  "tcp-tls",
  "udp",
] as const;

export const NETWORK_LISTEN_PROTOCOLS = [
  "http",
  "https",
  "ws",
  "wss",
  "tcp",
  "tcp-tls",
  "udp",
] as const;

export type NetworkConnectProtocol = (typeof NETWORK_CONNECT_PROTOCOLS)[number];
export type NetworkListenProtocol = (typeof NETWORK_LISTEN_PROTOCOLS)[number];

export type NetworkPort = number | Readonly<{ min: number; max: number }>;
export type NetworkListenPort = NetworkPort | "ephemeral";

export interface NetworkConnectPermission {
  readonly protocol: NetworkConnectProtocol;
  readonly host: string;
  readonly port: NetworkPort;
}

export interface NetworkListenPermission {
  readonly protocol: NetworkListenProtocol;
  readonly address: string;
  readonly port: NetworkListenPort;
}

export interface NetworkPermissions {
  /** Empty endpoint lists are explicit deny-all policies for that direction. */
  readonly connect: readonly NetworkConnectPermission[];
  readonly listen: readonly NetworkListenPermission[];
  readonly localNetwork: boolean;
  readonly insecureTransport: boolean;
  readonly broadcast: boolean;
  readonly multicast: boolean;
  readonly allowInvalidTlsForDevelopment: boolean;
  readonly browserAmbientCredentials: boolean;
  readonly browserOpaqueWebSocketRedirects: boolean;
  readonly credentials: readonly string[];
}

export interface NetworkResourceMinimum {
  /** Every field is optional: an empty minimum accepts the Host defaults. */
  readonly runtime?: Readonly<{
    connections?: number;
    pendingOperations?: number;
    completionDescriptors?: number;
    nativeBufferBytes?: number;
  }>;
  readonly stream?: Readonly<{
    receiveQueueBytes?: number;
    sendQueueBytes?: number;
  }>;
  readonly http?: Readonly<{
    connections?: number;
    inflightRequests?: number;
    headerBytes?: number;
    headerCount?: number;
    bufferedBodyBytes?: number;
  }>;
  readonly websocket?: Readonly<{
    connections?: number;
    messageBytes?: number;
    queuedMessages?: number;
  }>;
  readonly mqtt?: Readonly<{
    connections?: number;
    packetBytes?: number;
    qos1Inflight?: number;
    receiveQueueBytes?: number;
  }>;
  readonly udp?: Readonly<{
    sockets?: number;
    datagramBytes?: number;
    receiveDatagrams?: number;
  }>;
}

export interface CapabilityProviderAlternative {
  readonly options: readonly (readonly string[])[];
}

/** Format 3 extends application intent with provider alternatives and the
 * network permission/resource inputs consumed by the build resolver. */
export type PocketManifestV3 = Omit<
  PocketManifestV2,
  "$schema" | "pocket" | "engine"
> & {
  readonly $schema: typeof POCKET_MANIFEST_V3_SCHEMA_ID;
  readonly pocket: typeof POCKET_MANIFEST_V3_VERSION;
  readonly engine: {
    readonly capabilities: {
      readonly requires: readonly string[];
      readonly requiresOneOf?: readonly CapabilityProviderAlternative[];
      readonly enhances?: readonly string[];
    };
  };
  readonly permissions?: Readonly<{ network?: NetworkPermissions }>;
  readonly resources?: Readonly<{
    network?: Readonly<{ minimum: NetworkResourceMinimum }>;
  }>;
};

export type PocketManifest = PocketManifestV2 | PocketManifestV3;

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
        framework: { enum: ["solid", "vue-vapor", "octane"] },
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

const networkPortRangeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["min", "max"],
  properties: {
    min: { type: "integer", minimum: 1, maximum: 65535 },
    max: { type: "integer", minimum: 1, maximum: 65535 },
  },
} as const satisfies JsonSchema;

const networkPortSchema = {
  anyOf: [
    { type: "integer", minimum: 1, maximum: 65535 },
    networkPortRangeSchema,
  ],
} as const satisfies JsonSchema;

const networkListenPortSchema = {
  anyOf: [
    { type: "integer", minimum: 1, maximum: 65535 },
    networkPortRangeSchema,
    { enum: ["ephemeral"] },
  ],
} as const satisfies JsonSchema;

const networkPositiveIntegerSchema = {
  type: "integer",
  minimum: 1,
  maximum: 2147483647,
} as const satisfies JsonSchema;

function networkResourceGroupSchema(
  properties: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
  };
}

const networkResourceMinimumSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    runtime: networkResourceGroupSchema({
      connections: networkPositiveIntegerSchema,
      pendingOperations: networkPositiveIntegerSchema,
      completionDescriptors: networkPositiveIntegerSchema,
      nativeBufferBytes: networkPositiveIntegerSchema,
    }),
    stream: networkResourceGroupSchema({
      receiveQueueBytes: networkPositiveIntegerSchema,
      sendQueueBytes: networkPositiveIntegerSchema,
    }),
    http: networkResourceGroupSchema({
      connections: networkPositiveIntegerSchema,
      inflightRequests: networkPositiveIntegerSchema,
      headerBytes: networkPositiveIntegerSchema,
      headerCount: networkPositiveIntegerSchema,
      bufferedBodyBytes: networkPositiveIntegerSchema,
    }),
    websocket: networkResourceGroupSchema({
      connections: networkPositiveIntegerSchema,
      messageBytes: networkPositiveIntegerSchema,
      queuedMessages: networkPositiveIntegerSchema,
    }),
    mqtt: networkResourceGroupSchema({
      connections: networkPositiveIntegerSchema,
      packetBytes: networkPositiveIntegerSchema,
      qos1Inflight: networkPositiveIntegerSchema,
      receiveQueueBytes: networkPositiveIntegerSchema,
    }),
    udp: networkResourceGroupSchema({
      sockets: networkPositiveIntegerSchema,
      datagramBytes: networkPositiveIntegerSchema,
      receiveDatagrams: networkPositiveIntegerSchema,
    }),
  },
} as const satisfies JsonSchema;

/** Strict format-3 application intent. Network authorization remains absent
 * unless the manifest supplies the complete permissions.network object. */
export const pocketManifestV3Schema = {
  ...pocketManifestV2Schema,
  $id: POCKET_MANIFEST_V3_SCHEMA_ID,
  title: "Pocket application manifest, format 3",
  properties: {
    ...pocketManifestV2Schema.properties,
    $schema: { const: POCKET_MANIFEST_V3_SCHEMA_ID },
    pocket: { const: POCKET_MANIFEST_V3_VERSION },
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
            requiresOneOf: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["options"],
                properties: {
                  options: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "array",
                      minItems: 1,
                      uniqueItems: true,
                      items: capabilityIdSchema,
                    },
                  },
                },
              },
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
    permissions: {
      type: "object",
      additionalProperties: false,
      properties: {
        network: {
          type: "object",
          additionalProperties: false,
          required: [
            "connect",
            "listen",
            "localNetwork",
            "insecureTransport",
            "broadcast",
            "multicast",
            "allowInvalidTlsForDevelopment",
            "browserAmbientCredentials",
            "browserOpaqueWebSocketRedirects",
            "credentials",
          ],
          properties: {
            connect: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["protocol", "host", "port"],
                properties: {
                  protocol: { enum: NETWORK_CONNECT_PROTOCOLS },
                  host: { type: "string", minLength: 1, maxLength: 253 },
                  port: networkPortSchema,
                },
              },
            },
            listen: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["protocol", "address", "port"],
                properties: {
                  protocol: { enum: NETWORK_LISTEN_PROTOCOLS },
                  address: { type: "string", minLength: 1, maxLength: 45 },
                  port: networkListenPortSchema,
                },
              },
            },
            localNetwork: { type: "boolean" },
            insecureTransport: { type: "boolean" },
            broadcast: { type: "boolean" },
            multicast: { type: "boolean" },
            allowInvalidTlsForDevelopment: { type: "boolean" },
            browserAmbientCredentials: { type: "boolean" },
            browserOpaqueWebSocketRedirects: { type: "boolean" },
            credentials: {
              type: "array",
              uniqueItems: true,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
              },
            },
          },
        },
      },
    },
    resources: {
      type: "object",
      additionalProperties: false,
      properties: {
        network: {
          type: "object",
          additionalProperties: false,
          required: ["minimum"],
          properties: {
            minimum: networkResourceMinimumSchema,
          },
        },
      },
    },
  },
} as const satisfies JsonSchema;

export function generatePocketManifestV2Schema(): string {
  return JSON.stringify(pocketManifestV2Schema, null, 2) + "\n";
}

export function generatePocketManifestV3Schema(): string {
  return JSON.stringify(pocketManifestV3Schema, null, 2) + "\n";
}
