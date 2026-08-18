// Deterministic code generation for the private PocketJS network ABI.
//
// Source: contracts/spec/network/definition.ts
// Outputs:
//   generated/network-v1.ts
//   generated/pocketjs_network_v1_abi.h
//
// Run `bun contracts/spec/network/generate.ts`. CI/tests regenerate both
// outputs in memory and compare every byte.

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NETWORK_V1_DEFINITION,
  type NetworkV1FeatureEntry,
  type NetworkV1NamedEntry,
  type NetworkV1NumericEntry,
} from "./definition.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIRECTORY = join(HERE, "generated");
export const NETWORK_V1_TYPESCRIPT_PATH = join(GENERATED_DIRECTORY, "network-v1.ts");
export const NETWORK_V1_HEADER_PATH = join(
  GENERATED_DIRECTORY,
  "pocketjs_network_v1_abi.h",
);

function assertUint16(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff) {
    throw new TypeError(`${label} must be a non-zero uint16`);
  }
}

function validateEntries(
  label: string,
  entries: readonly NetworkV1NumericEntry[],
): void {
  const names = new Set<string>();
  const cNames = new Set<string>();
  const values = new Set<number>();
  let previous = 0;
  for (const entry of entries) {
    assertUint16(entry.value, `${label}.${entry.name}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry.cName)) {
      throw new TypeError(`${label}.${entry.name} has an invalid C identifier`);
    }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(entry.name)) {
      throw new TypeError(`${label}.${entry.name} has an invalid TypeScript identifier`);
    }
    if (entry.description.length === 0) {
      throw new TypeError(`${label}.${entry.name} needs a description`);
    }
    if (names.has(entry.name) || cNames.has(entry.cName) || values.has(entry.value)) {
      throw new TypeError(`${label}.${entry.name} duplicates an ABI identifier`);
    }
    if (entry.value <= previous) {
      throw new TypeError(`${label}.${entry.name} is not append-only numeric order`);
    }
    names.add(entry.name);
    cNames.add(entry.cName);
    values.add(entry.value);
    previous = entry.value;
  }
}

function validateNamedEntries(
  label: string,
  entries: readonly NetworkV1NamedEntry[],
): void {
  validateEntries(label, entries);
  const names = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9_]*(?:-[a-z0-9]+)*$/.test(entry.wireName)) {
      throw new TypeError(`${label}.${entry.name} has an invalid wire name`);
    }
    if (names.has(entry.wireName)) {
      throw new TypeError(`${label}.${entry.name} duplicates a wire name`);
    }
    names.add(entry.wireName);
  }
}

export function validateNetworkV1Definition(): void {
  const definition = NETWORK_V1_DEFINITION;
  assertUint16(definition.abi.major, "abi.major");
  if (!Number.isInteger(definition.abi.minor) || definition.abi.minor < 0 ||
    definition.abi.minor > 0xffff) {
    throw new TypeError("abi.minor must be a uint16");
  }
  if (definition.abi.planHashBytes !== 32) {
    throw new TypeError("ABI v1 plan hash must remain SHA-256 (32 bytes)");
  }
  if (definition.abi.sequenceMax !== Number.MAX_SAFE_INTEGER) {
    throw new TypeError("ABI v1 sequence bound must remain Number.MAX_SAFE_INTEGER");
  }
  assertUint16(definition.abi.limitEntryMax, "abi.limitEntryMax");
  assertUint16(definition.abi.limitNameMaxBytes, "abi.limitNameMaxBytes");

  validateEntries("features", definition.features);
  validateEntries("commands", definition.commands);
  validateEntries("events", definition.events);
  validateNamedEntries("errorCategories", definition.errorCategories);
  validateNamedEntries("errors", definition.errors);
  validateEntries("dispatchStatuses", definition.dispatchStatuses);
  validateEntries("completionPollStatuses", definition.completionPollStatuses);
  validateEntries("borrowedInputKinds", definition.borrowedInputKinds);
  validateEntries("limitProtocols", definition.limitProtocols);
  validateEntries("limitRoles", definition.limitRoles);
  validateEntries("httpRedirectModes", definition.httpRedirectModes);
  validateEntries("tlsVersions", definition.tlsVersions);
  validateEntries("tlsVerifications", definition.tlsVerifications);
  validateEntries("tlsRevocations", definition.tlsRevocations);
  validateEntries("clientCertificateModes", definition.clientCertificateModes);
  validateEntries("serviceTurnKinds", definition.serviceTurnKinds);
  validateEntries("serviceTurnStatuses", definition.serviceTurnStatuses);
  validateEntries("leaseStates", definition.leaseStates);
  validateEntries("leaseActions", definition.leaseActions);

  const capabilities = new Set<string>();
  for (const feature of definition.features) {
    if (!/^network\.[a-z0-9][a-z0-9.-]*$/.test(feature.capability)) {
      throw new TypeError(`features.${feature.name} has an invalid capability`);
    }
    if (capabilities.has(feature.capability)) {
      throw new TypeError(`features.${feature.name} duplicates a capability`);
    }
    capabilities.add(feature.capability);
  }

  const commandByName = new Map(definition.commands.map((entry) => [entry.name, entry.value]));
  const eventByName = new Map(definition.events.map((entry) => [entry.name, entry.value]));
  for (const name of ["BodyPull", "BodyChunk", "BodyEnd", "BodyError", "BodyCancel"]) {
    if (commandByName.get(name) !== eventByName.get(name)) {
      throw new TypeError(`${name} must use the same numeric code in both directions`);
    }
  }
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function generatedObject(
  exportName: string,
  entries: readonly NetworkV1NumericEntry[],
): string[] {
  const lines = [`export const ${exportName} = Object.freeze({`];
  for (const entry of entries) {
    lines.push(`  /** ${entry.description}. */`);
    lines.push(`  ${entry.name}: ${hex(entry.value)},`);
  }
  lines.push("} as const);");
  lines.push(`export type ${exportName} =`);
  lines.push(`  (typeof ${exportName})[keyof typeof ${exportName}];`);
  return lines;
}

function generatedValues(
  exportName: string,
  objectName: string,
  entries: readonly NetworkV1NumericEntry[],
): string[] {
  return [
    `export const ${exportName} = Object.freeze([`,
    ...entries.map((entry) => `  ${objectName}.${entry.name},`),
    `] as const);`,
  ];
}

function generatedNameMaps(
  prefix: string,
  objectName: string,
  entries: readonly NetworkV1NamedEntry[],
): string[] {
  const lines = [
    `export const ${prefix}_NAME_BY_ID = Object.freeze({`,
    ...entries.map((entry) => `  [${objectName}.${entry.name}]: ${JSON.stringify(entry.wireName)},`),
    `} as const);`,
    `export const ${prefix}_ID_BY_NAME = Object.freeze({`,
    ...entries.map((entry) => `  ${JSON.stringify(entry.wireName)}: ${objectName}.${entry.name},`),
    `} as const);`,
  ];
  return lines;
}

export function generateNetworkV1TypeScript(): string {
  validateNetworkV1Definition();
  const definition = NETWORK_V1_DEFINITION;
  const lines: string[] = [
    "// GENERATED — do not edit; run `bun contracts/spec/network/generate.ts`.",
    "// Source of truth: contracts/spec/network/definition.ts.",
    "",
    `export const NETWORK_V1_ABI_MAJOR = ${definition.abi.major} as const;`,
    `export const NETWORK_V1_ABI_MINOR = ${definition.abi.minor} as const;`,
    `export const NETWORK_V1_PLAN_HASH_BYTES = ${definition.abi.planHashBytes} as const;`,
    `export const NETWORK_V1_SEQUENCE_MAX = ${definition.abi.sequenceMax} as const;`,
    `export const NETWORK_V1_LIMIT_ENTRY_MAX = ${definition.abi.limitEntryMax} as const;`,
    `export const NETWORK_V1_LIMIT_NAME_MAX_BYTES = ${definition.abi.limitNameMaxBytes} as const;`,
    "export const NETWORK_V1_UINT32_MAX = 0xffff_ffff as const;",
    "export const NETWORK_V1_ABSENT_ID = 0 as const;",
    "export const NETWORK_V1_LIMIT_PROTOCOL_ANY = 0 as const;",
    "export const NETWORK_V1_LIMIT_ROLE_ANY = 0 as const;",
    "",
  ];

  const collections: ReadonlyArray<readonly [string, readonly NetworkV1NumericEntry[]]> = [
    ["NetworkV1FeatureId", definition.features],
    ["NetworkV1CommandOpcode", definition.commands],
    ["NetworkV1EventCode", definition.events],
    ["NetworkV1ErrorCategory", definition.errorCategories],
    ["NetworkV1ErrorCode", definition.errors],
    ["NetworkV1DispatchStatus", definition.dispatchStatuses],
    ["NetworkV1CompletionPollStatus", definition.completionPollStatuses],
    ["NetworkV1BorrowedInputKind", definition.borrowedInputKinds],
    ["NetworkV1LimitProtocol", definition.limitProtocols],
    ["NetworkV1LimitRole", definition.limitRoles],
    ["NetworkV1HttpRedirectMode", definition.httpRedirectModes],
    ["NetworkV1TlsVersion", definition.tlsVersions],
    ["NetworkV1TlsVerification", definition.tlsVerifications],
    ["NetworkV1TlsRevocation", definition.tlsRevocations],
    ["NetworkV1ClientCertificateMode", definition.clientCertificateModes],
    ["NetworkV1ServiceTurnKind", definition.serviceTurnKinds],
    ["NetworkV1ServiceTurnStatus", definition.serviceTurnStatuses],
    ["NetworkV1LeaseState", definition.leaseStates],
    ["NetworkV1LeaseAction", definition.leaseActions],
  ];
  for (const [name, entries] of collections) {
    lines.push(...generatedObject(name, entries), "");
  }

  lines.push(
    ...generatedValues("NETWORK_V1_FEATURE_IDS", "NetworkV1FeatureId", definition.features),
    "",
    ...generatedValues("NETWORK_V1_COMMAND_OPCODES", "NetworkV1CommandOpcode", definition.commands),
    "",
    ...generatedValues("NETWORK_V1_EVENT_CODES", "NetworkV1EventCode", definition.events),
    "",
    ...generatedValues("NETWORK_V1_ERROR_CODES", "NetworkV1ErrorCode", definition.errors),
    "",
    "export const NETWORK_V1_FEATURE_CAPABILITY_BY_ID = Object.freeze({",
    ...definition.features.map((entry) =>
      `  [NetworkV1FeatureId.${entry.name}]: ${JSON.stringify(entry.capability)},`
    ),
    "} as const);",
    "export const NETWORK_V1_FEATURE_ID_BY_CAPABILITY = Object.freeze({",
    ...definition.features.map((entry) =>
      `  ${JSON.stringify(entry.capability)}: NetworkV1FeatureId.${entry.name},`
    ),
    "} as const);",
    "",
    ...generatedNameMaps(
      "NETWORK_V1_ERROR_CATEGORY",
      "NetworkV1ErrorCategory",
      definition.errorCategories,
    ),
    "",
    ...generatedNameMaps("NETWORK_V1_ERROR", "NetworkV1ErrorCode", definition.errors),
  );

  return `${lines.join("\n")}\n`;
}

function cDefine(
  group: string,
  cType: string,
  entries: readonly NetworkV1NumericEntry[],
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`/** ${entry.description}. */`);
    lines.push(
      `#define POCKETJS_NETWORK_V1_${group}_${entry.cName} ((pocketjs_network_v1_${cType}_t)UINT16_C(${entry.value}))`,
    );
  }
  return lines;
}

export function generateNetworkV1Header(): string {
  validateNetworkV1Definition();
  const definition = NETWORK_V1_DEFINITION;
  const lines: string[] = [
    "/* GENERATED — do not edit; run `bun contracts/spec/network/generate.ts`.",
    " * Source of truth: contracts/spec/network/definition.ts.",
    " */",
    "#ifndef POCKETJS_NETWORK_V1_ABI_H",
    "#define POCKETJS_NETWORK_V1_ABI_H",
    "",
    "#include <stddef.h>",
    "#include <stdint.h>",
    "",
    "#ifdef __cplusplus",
    'extern "C" {',
    "#endif",
    "",
    `#define POCKETJS_NETWORK_V1_ABI_MAJOR UINT16_C(${definition.abi.major})`,
    `#define POCKETJS_NETWORK_V1_ABI_MINOR UINT16_C(${definition.abi.minor})`,
    `#define POCKETJS_NETWORK_V1_PLAN_HASH_BYTES UINT16_C(${definition.abi.planHashBytes})`,
    `#define POCKETJS_NETWORK_V1_SEQUENCE_MAX UINT64_C(${definition.abi.sequenceMax})`,
    `#define POCKETJS_NETWORK_V1_LIMIT_ENTRY_MAX UINT16_C(${definition.abi.limitEntryMax})`,
    `#define POCKETJS_NETWORK_V1_LIMIT_NAME_MAX_BYTES UINT16_C(${definition.abi.limitNameMaxBytes})`,
    "#define POCKETJS_NETWORK_V1_ABSENT_ID UINT32_C(0)",
    "#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_ANY UINT16_C(0)",
    "#define POCKETJS_NETWORK_V1_LIMIT_ROLE_ANY UINT16_C(0)",
    `#define POCKETJS_NETWORK_V1_FEATURE_COUNT UINT16_C(${definition.features.length})`,
    "",
    "typedef uint16_t pocketjs_network_v1_feature_id_t;",
    "typedef uint16_t pocketjs_network_v1_command_opcode_t;",
    "typedef uint16_t pocketjs_network_v1_event_code_t;",
    "typedef uint16_t pocketjs_network_v1_error_category_t;",
    "typedef uint16_t pocketjs_network_v1_error_code_t;",
    "typedef uint16_t pocketjs_network_v1_dispatch_status_t;",
    "typedef uint16_t pocketjs_network_v1_completion_poll_status_t;",
    "typedef uint16_t pocketjs_network_v1_borrowed_input_kind_t;",
    "typedef uint16_t pocketjs_network_v1_limit_protocol_t;",
    "typedef uint16_t pocketjs_network_v1_limit_role_t;",
    "typedef uint16_t pocketjs_network_v1_http_redirect_mode_t;",
    "typedef uint16_t pocketjs_network_v1_tls_version_t;",
    "typedef uint16_t pocketjs_network_v1_tls_verification_t;",
    "typedef uint16_t pocketjs_network_v1_tls_revocation_t;",
    "typedef uint16_t pocketjs_network_v1_client_certificate_mode_t;",
    "typedef uint16_t pocketjs_network_v1_service_turn_kind_t;",
    "typedef uint16_t pocketjs_network_v1_service_turn_status_t;",
    "typedef uint16_t pocketjs_network_v1_lease_state_t;",
    "typedef uint16_t pocketjs_network_v1_lease_action_t;",
    "",
    ...cDefine("FEATURE", "feature_id", definition.features),
    "",
    ...definition.features.map((entry) =>
      `#define POCKETJS_NETWORK_V1_FEATURE_${entry.cName}_CAPABILITY ${JSON.stringify(entry.capability)}`
    ),
    "",
    ...cDefine("COMMAND", "command_opcode", definition.commands),
    "",
    ...cDefine("EVENT", "event_code", definition.events),
    "",
    ...cDefine("ERROR_CATEGORY", "error_category", definition.errorCategories),
    "",
    ...definition.errorCategories.map((entry) =>
      `#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_${entry.cName}_NAME ${JSON.stringify(entry.wireName)}`
    ),
    "",
    ...cDefine("ERROR", "error_code", definition.errors),
    "",
    ...definition.errors.map((entry) =>
      `#define POCKETJS_NETWORK_V1_ERROR_${entry.cName}_NAME ${JSON.stringify(entry.wireName)}`
    ),
    "",
    ...cDefine("DISPATCH", "dispatch_status", definition.dispatchStatuses),
    "",
    ...cDefine(
      "COMPLETION_POLL",
      "completion_poll_status",
      definition.completionPollStatuses,
    ),
    "",
    ...cDefine("BORROWED_INPUT", "borrowed_input_kind", definition.borrowedInputKinds),
    "",
    ...cDefine("LIMIT_PROTOCOL", "limit_protocol", definition.limitProtocols),
    "",
    ...cDefine("LIMIT_ROLE", "limit_role", definition.limitRoles),
    "",
    ...cDefine("HTTP_REDIRECT", "http_redirect_mode", definition.httpRedirectModes),
    "",
    ...cDefine("TLS_VERSION", "tls_version", definition.tlsVersions),
    "",
    ...cDefine("TLS_VERIFICATION", "tls_verification", definition.tlsVerifications),
    "",
    ...cDefine("TLS_REVOCATION", "tls_revocation", definition.tlsRevocations),
    "",
    ...cDefine(
      "CLIENT_CERTIFICATE",
      "client_certificate_mode",
      definition.clientCertificateModes,
    ),
    "",
    ...cDefine("SERVICE_TURN_KIND", "service_turn_kind", definition.serviceTurnKinds),
    "",
    ...cDefine("SERVICE_TURN_STATUS", "service_turn_status", definition.serviceTurnStatuses),
    "",
    ...cDefine("LEASE_STATE", "lease_state", definition.leaseStates),
    "",
    ...cDefine("LEASE_ACTION", "lease_action", definition.leaseActions),
    "",
    "/** A zero/zero handle is absent. A live handle has non-zero id and generation. */",
    "typedef struct pocketjs_network_v1_handle {",
    "  uint32_t id;",
    "  uint32_t generation;",
    "} pocketjs_network_v1_handle_t;",
    "",
    "/** Identity carried by every command accepted by the native adapter. */",
    "typedef struct pocketjs_network_v1_command_identity {",
    "  uint32_t runtime_generation;",
    "  pocketjs_network_v1_handle_t resource;",
    "  pocketjs_network_v1_handle_t operation;",
    "  pocketjs_network_v1_handle_t body;",
    "  uint64_t command_sequence;",
    "} pocketjs_network_v1_command_identity_t;",
    "",
    "/** Identity carried by every Core-to-Guest completion. */",
    "typedef struct pocketjs_network_v1_completion_identity {",
    "  uint32_t runtime_generation;",
    "  pocketjs_network_v1_handle_t resource;",
    "  pocketjs_network_v1_handle_t operation;",
    "  pocketjs_network_v1_handle_t body;",
    "  uint64_t sequence;",
    "} pocketjs_network_v1_completion_identity_t;",
    "",
    "/** A completion advertises this descriptor; payload bytes remain native. */",
    "typedef struct pocketjs_network_v1_lease_descriptor {",
    "  uint32_t runtime_generation;",
    "  pocketjs_network_v1_handle_t lease;",
    "  uint32_t byte_length;",
    "} pocketjs_network_v1_lease_descriptor_t;",
    "",
    "/**",
    " * Borrowed input is valid only during the synchronous adapter call. The",
    " * adapter copies exactly this window to an owned BufferLease before it",
    " * returns POCKETJS_NETWORK_V1_DISPATCH_ACCEPTED.",
    " */",
    "typedef struct pocketjs_network_v1_borrowed_input_view {",
    "  pocketjs_network_v1_borrowed_input_kind_t kind;",
    "  uint16_t reserved_zero;",
    "  const uint8_t *data;",
    "  uint32_t byte_length;",
    "} pocketjs_network_v1_borrowed_input_view_t;",
    "",
    "/** Writable Guest memory borrowed only for BUFFER_LEASE_READ_INTO. */",
    "typedef struct pocketjs_network_v1_borrowed_output_view {",
    "  uint8_t *data;",
    "  uint32_t byte_length;",
    "} pocketjs_network_v1_borrowed_output_view_t;",
    "",
    "/** Refused carries non-zero category/code; Accepted/Completed carry zeros. */",
    "typedef struct pocketjs_network_v1_dispatch_result {",
    "  pocketjs_network_v1_dispatch_status_t status;",
    "  pocketjs_network_v1_error_category_t error_category;",
    "  pocketjs_network_v1_error_code_t error_code;",
    "  uint16_t reserved_zero;",
    "} pocketjs_network_v1_dispatch_result_t;",
    "",
    "/** Remaining byte credit passed to one completion dequeue attempt. */",
    "typedef struct pocketjs_network_v1_completion_poll_request {",
    "  uint32_t runtime_generation;",
    "  uint32_t max_payload_bytes;",
    "} pocketjs_network_v1_completion_poll_request_t;",
    "",
    "/** ITEM reports the selected completion's entire advertised payload size. */",
    "typedef struct pocketjs_network_v1_completion_poll_result {",
    "  pocketjs_network_v1_completion_poll_status_t status;",
    "  uint16_t reserved_zero;",
    "  uint32_t payload_bytes_delivered;",
    "} pocketjs_network_v1_completion_poll_result_t;",
    "",
    "/**",
    " * Mount handshake view. feature_ids are strictly increasing and describe",
    " * exactly the true network feature projection of the verified Build Plan.",
    " * plan_hash is the 32-byte digest portion of the sha256: planHash.",
    " */",
    "typedef struct pocketjs_network_v1_handshake_view {",
    "  uint16_t abi_major;",
    "  uint16_t abi_minor;",
    "  uint32_t runtime_generation;",
    "  const pocketjs_network_v1_feature_id_t *feature_ids;",
    "  uint16_t feature_count;",
    "  uint16_t reserved_zero;",
    "  uint8_t plan_hash[POCKETJS_NETWORK_V1_PLAN_HASH_BYTES];",
    "} pocketjs_network_v1_handshake_view_t;",
    "",
    "/** Zero protocol/role selects the build-wide dimension. */",
    "typedef struct pocketjs_network_v1_limits_query {",
    "  uint32_t runtime_generation;",
    "  pocketjs_network_v1_limit_protocol_t protocol;",
    "  pocketjs_network_v1_limit_role_t role;",
    "} pocketjs_network_v1_limits_query_t;",
    "",
    "/** One immutable effective limit entry returned by the Host. */",
    "typedef struct pocketjs_network_v1_limit_entry_view {",
    "  const char *name;",
    "  uint16_t name_length;",
    "  uint16_t reserved_zero;",
    "  uint64_t default_value;",
    "  uint64_t hard_value;",
    "  uint64_t minimum_value;",
    "} pocketjs_network_v1_limit_entry_view_t;",
    "",
    "/** Borrowed synchronous view for the ABI 1.1 getLimits method. */",
    "typedef struct pocketjs_network_v1_limits_snapshot_view {",
    "  uint32_t runtime_generation;",
    "  pocketjs_network_v1_limit_protocol_t protocol;",
    "  pocketjs_network_v1_limit_role_t role;",
    "  const pocketjs_network_v1_limit_entry_view_t *values;",
    "  uint16_t value_count;",
    "  const pocketjs_network_v1_feature_id_t *feature_ids;",
    "  uint16_t feature_count;",
    "} pocketjs_network_v1_limits_snapshot_view_t;",
    "",
    "/** Host-to-Guest budget for one registered service-dispatcher invocation. */",
    "typedef struct pocketjs_network_v1_service_turn_request {",
    "  uint32_t runtime_generation;",
    "  uint64_t turn_id;",
    "  pocketjs_network_v1_service_turn_kind_t kind;",
    "  uint16_t reserved_zero;",
    "  uint32_t max_events;",
    "  uint32_t max_payload_bytes;",
    "} pocketjs_network_v1_service_turn_request_t;",
    "",
    "/** Guest result; counts cannot exceed the request and sequence is monotonic. */",
    "typedef struct pocketjs_network_v1_service_turn_result {",
    "  pocketjs_network_v1_service_turn_status_t status;",
    "  uint16_t reserved_zero;",
    "  uint32_t events_delivered;",
    "  uint32_t payload_bytes_delivered;",
    "  uint64_t last_sequence;",
    "} pocketjs_network_v1_service_turn_result_t;",
    "",
    "static inline int pocketjs_network_v1_handle_is_absent(",
    "    pocketjs_network_v1_handle_t handle) {",
    "  return handle.id == POCKETJS_NETWORK_V1_ABSENT_ID &&",
    "         handle.generation == POCKETJS_NETWORK_V1_ABSENT_ID;",
    "}",
    "",
    "static inline int pocketjs_network_v1_handle_is_live(",
    "    pocketjs_network_v1_handle_t handle) {",
    "  return handle.id != POCKETJS_NETWORK_V1_ABSENT_ID &&",
    "         handle.generation != POCKETJS_NETWORK_V1_ABSENT_ID;",
    "}",
    "",
    "#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L",
    '_Static_assert(sizeof(pocketjs_network_v1_handle_t) == 8, "network v1 handle layout");',
    '_Static_assert(sizeof(uint64_t) == 8, "network v1 requires uint64_t");',
    "#endif",
    "",
    "#ifdef __cplusplus",
    "} /* extern \"C\" */",
    "#endif",
    "",
    "#endif /* POCKETJS_NETWORK_V1_ABI_H */",
    "",
  ];
  return lines.join("\n");
}

export interface NetworkV1GeneratedFiles {
  readonly typescript: string;
  readonly header: string;
}

export function generateNetworkV1Files(): NetworkV1GeneratedFiles {
  return {
    typescript: generateNetworkV1TypeScript(),
    header: generateNetworkV1Header(),
  };
}

async function writeOrCheck(check: boolean): Promise<void> {
  const generated = generateNetworkV1Files();
  if (check) {
    const [typescript, header] = await Promise.all([
      Bun.file(NETWORK_V1_TYPESCRIPT_PATH).text().catch(() => null),
      Bun.file(NETWORK_V1_HEADER_PATH).text().catch(() => null),
    ]);
    const failures: string[] = [];
    if (typescript !== generated.typescript) failures.push(NETWORK_V1_TYPESCRIPT_PATH);
    if (header !== generated.header) failures.push(NETWORK_V1_HEADER_PATH);
    if (failures.length > 0) {
      throw new Error(`generated network ABI drift: ${failures.join(", ")}`);
    }
    return;
  }

  await mkdir(GENERATED_DIRECTORY, { recursive: true });
  await Promise.all([
    Bun.write(NETWORK_V1_TYPESCRIPT_PATH, generated.typescript),
    Bun.write(NETWORK_V1_HEADER_PATH, generated.header),
  ]);
}

if (import.meta.main) {
  const check = process.argv.slice(2).includes("--check");
  await writeOrCheck(check);
  console.log(check ? "network ABI generated files are current" : "generated network ABI v1");
}
