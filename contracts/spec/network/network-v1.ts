/**
 * Semantic contract for `pocketjs:internal/network-v1`.
 *
 * This module is private to the version-matched framework and Host. It does
 * not grant authority and is not a public package export. The native Core
 * still enforces the verified Build Plan and ResolvedNetworkPolicy.
 */

import {
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
  NETWORK_V1_FEATURE_CAPABILITY_BY_ID,
  NETWORK_V1_FEATURE_ID_BY_CAPABILITY,
  NETWORK_V1_FEATURE_IDS,
  NETWORK_V1_LIMIT_ENTRY_MAX,
  NETWORK_V1_LIMIT_NAME_MAX_BYTES,
  NETWORK_V1_LIMIT_PROTOCOL_ANY,
  NETWORK_V1_LIMIT_ROLE_ANY,
  NETWORK_V1_PLAN_HASH_BYTES,
  NETWORK_V1_SEQUENCE_MAX,
  NETWORK_V1_UINT32_MAX,
  NetworkV1BorrowedInputKind,
  NetworkV1ClientCertificateMode,
  NetworkV1CommandOpcode,
  NetworkV1CompletionPollStatus,
  NetworkV1DispatchStatus,
  NetworkV1ErrorCategory,
  NetworkV1ErrorCode,
  NetworkV1EventCode,
  NetworkV1FeatureId,
  NetworkV1HttpRedirectMode,
  NetworkV1LeaseAction,
  NetworkV1LeaseState,
  NetworkV1LimitProtocol,
  NetworkV1LimitRole,
  NetworkV1ServiceTurnKind,
  NetworkV1ServiceTurnStatus,
  NetworkV1TlsRevocation,
  NetworkV1TlsVerification,
  NetworkV1TlsVersion,
} from "./generated/network-v1.ts";

export * from "./generated/network-v1.ts";

export interface NetworkV1Handle {
  readonly id: number;
  readonly generation: number;
}

export const NETWORK_V1_ABSENT_HANDLE: Readonly<NetworkV1Handle> =
  Object.freeze({ id: 0, generation: 0 });

export interface NetworkV1CommandIdentity {
  readonly runtimeGeneration: number;
  readonly resource: NetworkV1Handle;
  readonly operation: NetworkV1Handle;
  readonly body: NetworkV1Handle;
  /** Monotonic within one runtime generation; zero is never emitted. */
  readonly commandSequence: number;
}

export interface NetworkV1CompletionIdentity {
  readonly runtimeGeneration: number;
  readonly resource: NetworkV1Handle;
  readonly operation: NetworkV1Handle;
  readonly body: NetworkV1Handle;
  /** Core-assigned global merge order; zero is never emitted. */
  readonly sequence: number;
}

export interface NetworkV1GenerationSnapshot {
  readonly runtimeGeneration: number;
  readonly resource?: NetworkV1Handle;
  readonly operation?: NetworkV1Handle;
  readonly body?: NetworkV1Handle;
}

export interface NetworkV1Handshake {
  readonly abiMajor: number;
  readonly abiMinor: number;
  readonly runtimeGeneration: number;
  /** Raw 32-byte digest from the verified `sha256:<hex>` Build Plan hash. */
  readonly planHash: Uint8Array;
  /** Strictly increasing exact projection of true `network.*` plan features. */
  readonly featureIds: readonly NetworkV1FeatureId[];
}

export type NetworkV1LimitProtocolQuery =
  | typeof NETWORK_V1_LIMIT_PROTOCOL_ANY
  | NetworkV1LimitProtocol;

export type NetworkV1LimitRoleQuery =
  | typeof NETWORK_V1_LIMIT_ROLE_ANY
  | NetworkV1LimitRole;

export interface NetworkV1LimitsQuery {
  readonly runtimeGeneration: number;
  /** Zero selects every protocol in the admitted build. */
  readonly protocol: NetworkV1LimitProtocolQuery;
  /** Zero selects every role in the admitted build. */
  readonly role: NetworkV1LimitRoleQuery;
}

export interface NetworkV1LimitEntry {
  /** Stable dotted identifier, unique and lexicographically sorted. */
  readonly name: string;
  readonly default: number;
  readonly hard: number;
  readonly minimum: number;
}

export interface NetworkV1LimitsSnapshot {
  readonly runtimeGeneration: number;
  readonly protocol: NetworkV1LimitProtocolQuery;
  readonly role: NetworkV1LimitRoleQuery;
  readonly values: readonly NetworkV1LimitEntry[];
  /** Exact scoped subset of the mount handshake feature ids. */
  readonly featureIds: readonly NetworkV1FeatureId[];
}

export interface NetworkV1Header {
  /** Lowercase HTTP field name after the selected Fetch guard ran. */
  readonly name: string;
  /** ByteString value with OWS normalized and CR/LF rejected. */
  readonly value: string;
}

export interface NetworkV1HttpTimeouts {
  /** Zero means the Build Plan/provider default; non-zero is milliseconds. */
  readonly connectMs: number;
  readonly headersMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}

export interface NetworkV1LimitOverride {
  /** Provider-defined stable limit name, sorted lexicographically by name. */
  readonly name: string;
  /** Already clamped to the admitted minimum/default interval. */
  readonly value: number;
}

export interface NetworkV1TlsMetadata {
  /** Empty only when the authorized endpoint is an IP literal. */
  readonly serverName: string;
  readonly minVersion: NetworkV1TlsVersion;
  readonly maxVersion: NetworkV1TlsVersion;
  readonly alpn: readonly string[];
  /** Empty string means no Host credential id. */
  readonly credential: string;
  readonly clientCertificate: NetworkV1ClientCertificateMode;
  readonly verification: NetworkV1TlsVerification;
  readonly revocation: NetworkV1TlsRevocation;
  /** Must equal the CustomCa borrowed input length, or zero when absent. */
  readonly customCaBytes: number;
}

export interface NetworkV1HttpRequestMetadata {
  /** Absolute, canonical HTTP(S) URL; native policy checks it again. */
  readonly url: string;
  /** Normalized HTTP token; CONNECT and TRACE are forbidden. */
  readonly method: string;
  readonly headers: readonly NetworkV1Header[];
  readonly hasBody: boolean;
  readonly redirect: NetworkV1HttpRedirectMode;
  readonly timeouts: NetworkV1HttpTimeouts;
  readonly maxRedirects: number;
  readonly tls: NetworkV1TlsMetadata | null;
  readonly limits: readonly NetworkV1LimitOverride[];
  readonly ref: boolean;
}

export interface NetworkV1HttpResponseMetadata {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly NetworkV1Header[];
  readonly url: string;
  readonly redirected: boolean;
  /** Native aggregation ceiling after all build/provider limits are applied. */
  readonly bufferedBodyBytes: number;
}

export interface NetworkV1ErrorMetadata {
  readonly category: NetworkV1ErrorCategory;
  readonly code: NetworkV1ErrorCode;
  /** Stable operation label selected by the protocol Core. */
  readonly operation: string;
  readonly temporary: boolean;
  readonly address?: string;
  readonly port?: number;
  readonly causeCode?: string;
  readonly reasonCode?: number;
}

/**
 * Input remains borrowed only for the synchronous native adapter call. The
 * adapter must copy it into an admitted BufferLease before returning Accepted.
 */
export interface NetworkV1BorrowedInput {
  readonly kind: NetworkV1BorrowedInputKind;
  readonly bytes: Uint8Array;
}

interface NetworkV1CommandBase {
  readonly opcode: NetworkV1CommandOpcode;
  readonly identity: NetworkV1CommandIdentity;
}

export interface NetworkV1OperationCancelCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.OperationCancel;
}

export interface NetworkV1BufferLeaseTakeCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BufferLeaseTake;
  readonly lease: NetworkV1Handle;
  readonly byteLength: number;
}

export interface NetworkV1BufferLeaseReadIntoCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BufferLeaseReadInto;
  readonly lease: NetworkV1Handle;
  readonly offset: number;
  /** Destination capacity for the synchronous borrowed-output argument. */
  readonly maxBytes: number;
}

export interface NetworkV1BufferLeaseReleaseCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BufferLeaseRelease;
  readonly lease: NetworkV1Handle;
}

export interface NetworkV1BodyPullCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BodyPull;
  readonly maxBytes: number;
}

export interface NetworkV1BodyChunkCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BodyChunk;
  readonly input: NetworkV1BorrowedInput & Readonly<{
    kind: typeof NetworkV1BorrowedInputKind.BodyChunk;
  }>;
}

export interface NetworkV1BodyEndCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BodyEnd;
}

export interface NetworkV1BodyErrorCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BodyError;
  readonly error: NetworkV1ErrorMetadata;
}

export interface NetworkV1BodyCancelCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.BodyCancel;
}

export interface NetworkV1HttpRequestStartCommand extends NetworkV1CommandBase {
  readonly opcode: typeof NetworkV1CommandOpcode.HttpRequestStart;
  readonly metadata: NetworkV1HttpRequestMetadata;
  /** Present only when metadata.customCaBytes is non-zero. */
  readonly input?: NetworkV1BorrowedInput & Readonly<{
    kind: typeof NetworkV1BorrowedInputKind.CustomCa;
  }>;
}

export type NetworkV1LeaseCommand =
  | NetworkV1BufferLeaseTakeCommand
  | NetworkV1BufferLeaseReadIntoCommand
  | NetworkV1BufferLeaseReleaseCommand;

export type NetworkV1AsyncCommand =
  | NetworkV1OperationCancelCommand
  | NetworkV1BodyPullCommand
  | NetworkV1BodyChunkCommand
  | NetworkV1BodyEndCommand
  | NetworkV1BodyErrorCommand
  | NetworkV1BodyCancelCommand
  | NetworkV1HttpRequestStartCommand;

export type NetworkV1Command = NetworkV1LeaseCommand | NetworkV1AsyncCommand;

interface NetworkV1CompletionBase {
  readonly eventCode: NetworkV1EventCode;
  readonly identity: NetworkV1CompletionIdentity;
}

export interface NetworkV1BodyPullEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.BodyPull;
  readonly maxBytes: number;
}

export interface NetworkV1LeaseDescriptor {
  readonly runtimeGeneration: number;
  readonly lease: NetworkV1Handle;
  readonly byteLength: number;
}

export interface NetworkV1BodyChunkEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.BodyChunk;
  readonly payload: NetworkV1LeaseDescriptor;
}

export interface NetworkV1BodyEndEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.BodyEnd;
}

export interface NetworkV1BodyErrorEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.BodyError;
  readonly error: NetworkV1ErrorMetadata;
}

export interface NetworkV1BodyCancelEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.BodyCancel;
}

export interface NetworkV1HttpResponseHeadersEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.HttpResponseHeaders;
  readonly metadata: NetworkV1HttpResponseMetadata;
}

export interface NetworkV1HttpRequestErrorEvent extends NetworkV1CompletionBase {
  readonly eventCode: typeof NetworkV1EventCode.HttpRequestError;
  readonly error: NetworkV1ErrorMetadata;
}

export type NetworkV1Completion =
  | NetworkV1BodyPullEvent
  | NetworkV1BodyChunkEvent
  | NetworkV1BodyEndEvent
  | NetworkV1BodyErrorEvent
  | NetworkV1BodyCancelEvent
  | NetworkV1HttpResponseHeadersEvent
  | NetworkV1HttpRequestErrorEvent;

export interface NetworkV1CompletionPollRequest {
  readonly runtimeGeneration: number;
  /** Remaining payload-byte budget; zero is a non-consuming readiness probe. */
  readonly maxPayloadBytes: number;
}

export type NetworkV1CompletionPollResult =
  | Readonly<{
      status: typeof NetworkV1CompletionPollStatus.Item;
      completion: NetworkV1Completion;
      /** Entire payload size charged when this descriptor was selected. */
      payloadBytesDelivered: number;
    }>
  | Readonly<{
      status:
        | typeof NetworkV1CompletionPollStatus.Drained
        | typeof NetworkV1CompletionPollStatus.BudgetExhausted;
      payloadBytesDelivered: 0;
    }>;

export type NetworkV1AcceptedResult = Readonly<{
  status: typeof NetworkV1DispatchStatus.Accepted;
}>;

export type NetworkV1RefusedResult = Readonly<{
  status: typeof NetworkV1DispatchStatus.Refused;
  /** No completion follows a synchronously refused command. */
  error: NetworkV1ErrorMetadata;
}>;

export type NetworkV1CompletedResult = Readonly<{
  status: typeof NetworkV1DispatchStatus.Completed;
}>;

export type NetworkV1AsyncDispatchResult =
  | NetworkV1AcceptedResult
  | NetworkV1RefusedResult;

export type NetworkV1SynchronousResult =
  | NetworkV1CompletedResult
  | NetworkV1RefusedResult;

export type NetworkV1DispatchResult =
  | NetworkV1AcceptedResult
  | NetworkV1CompletedResult
  | NetworkV1RefusedResult;

export type NetworkV1LeaseTakeResult =
  | Readonly<{
      status: typeof NetworkV1DispatchStatus.Completed;
      /** Exact length already carried by the delivered lease descriptor. */
      byteLength: number;
    }>
  | NetworkV1RefusedResult;

export type NetworkV1LeaseReadResult =
  | Readonly<{
      status: typeof NetworkV1DispatchStatus.Completed;
      /** Bytes synchronously copied into the borrowed destination. */
      bytesCopied: number;
    }>
  | NetworkV1RefusedResult;

export interface NetworkV1ServiceTurnRequest {
  readonly runtimeGeneration: number;
  readonly turnId: number;
  readonly kind: NetworkV1ServiceTurnKind;
  readonly maxEvents: number;
  readonly maxPayloadBytes: number;
}

export interface NetworkV1ServiceTurnResult {
  readonly status: NetworkV1ServiceTurnStatus;
  readonly eventsDelivered: number;
  /** Sum of advertised lease byte lengths selected for this turn. */
  readonly payloadBytesDelivered: number;
  /** Zero exactly when eventsDelivered is zero. */
  readonly lastSequence: number;
}

export type NetworkV1ServiceDispatcher = (
  request: NetworkV1ServiceTurnRequest,
) => NetworkV1ServiceTurnResult;

/**
 * Frozen table captured lexically by the framework bundle factory. Mount calls
 * `registerServiceDispatcher` exactly once before application initialization.
 * Every method is owner-thread-only and non-reentrant.
 */
export interface NetworkV1BindingTable {
  readonly handshake: NetworkV1Handshake;
  /** ABI 1.1: immutable Build Plan/descriptor snapshot; never negotiates. */
  getLimits(query: NetworkV1LimitsQuery): NetworkV1LimitsSnapshot;
  dispatch(command: NetworkV1AsyncCommand): NetworkV1AsyncDispatchResult;
  nextCompletion(request: NetworkV1CompletionPollRequest): NetworkV1CompletionPollResult;
  leaseTake(command: NetworkV1BufferLeaseTakeCommand): NetworkV1LeaseTakeResult;
  leaseReadInto(
    command: NetworkV1BufferLeaseReadIntoCommand,
    destination: Uint8Array,
  ): NetworkV1LeaseReadResult;
  leaseRelease(command: NetworkV1BufferLeaseReleaseCommand): NetworkV1SynchronousResult;
  registerServiceDispatcher(dispatcher: NetworkV1ServiceDispatcher): void;
}

function fail(label: string, detail: string): never {
  throw new TypeError(`PocketJS network ABI: ${label} ${detail}`);
}

const NETWORK_V1_TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const NETWORK_V1_TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  NETWORK_V1_TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)!.get!;
const NETWORK_V1_UINT8_ARRAY_SET = Uint8Array.prototype.set;

function networkV1Uint8ArrayByteLength(value: unknown, label: string): number {
  if (!(value instanceof Uint8Array)) fail(label, "must be a Uint8Array window");
  try {
    return Reflect.apply(NETWORK_V1_TYPED_ARRAY_BYTE_LENGTH, value, []);
  } catch {
    fail(label, "must expose valid Uint8Array intrinsic slots");
  }
}

function networkV1CopyUint8Array(value: unknown, label: string): Uint8Array {
  const byteLength = networkV1Uint8ArrayByteLength(value, label);
  const copy = new Uint8Array(byteLength);
  try {
    Reflect.apply(NETWORK_V1_UINT8_ARRAY_SET, copy, [value]);
  } catch {
    fail(label, "could not be copied from Uint8Array intrinsic slots");
  }
  return copy;
}

function assertIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum) {
    fail(label, `must be an integer in [${minimum}, ${maximum}]`);
  }
}

export function assertNetworkV1RuntimeGeneration(
  value: unknown,
  label = "runtimeGeneration",
): asserts value is number {
  assertIntegerInRange(value, 1, NETWORK_V1_UINT32_MAX, label);
}

export function assertNetworkV1Sequence(
  value: unknown,
  label = "sequence",
): asserts value is number {
  assertIntegerInRange(value, 1, NETWORK_V1_SEQUENCE_MAX, label);
}

/** Generation reuse is fail-closed; zero and wraparound are never emitted. */
export function networkV1NextGeneration(
  current: number,
  label = "generation",
): number {
  assertIntegerInRange(current, 1, NETWORK_V1_UINT32_MAX - 1, label);
  return current + 1;
}

export function assertNetworkV1Handle(
  value: unknown,
  label = "handle",
  allowAbsent = true,
): asserts value is NetworkV1Handle {
  if (typeof value !== "object" || value === null) fail(label, "must be an object");
  const record = value as Partial<NetworkV1Handle>;
  const id = record.id;
  const generation = record.generation;
  assertIntegerInRange(id, 0, NETWORK_V1_UINT32_MAX, `${label}.id`);
  assertIntegerInRange(
    generation,
    0,
    NETWORK_V1_UINT32_MAX,
    `${label}.generation`,
  );
  if ((id === 0) !== (generation === 0)) {
    fail(label, "must be either zero/zero or non-zero/non-zero");
  }
  if (!allowAbsent && id === 0) fail(label, "must be live");
}

export function networkV1HandleIsAbsent(handle: NetworkV1Handle): boolean {
  return handle.id === 0 && handle.generation === 0;
}

export function networkV1SameHandle(
  left: NetworkV1Handle,
  right: NetworkV1Handle,
): boolean {
  return left.id === right.id && left.generation === right.generation;
}

export function assertNetworkV1CommandIdentity(
  identity: NetworkV1CommandIdentity,
): void {
  assertNetworkV1RuntimeGeneration(identity.runtimeGeneration);
  assertNetworkV1Handle(identity.resource, "resource");
  assertNetworkV1Handle(identity.operation, "operation");
  assertNetworkV1Handle(identity.body, "body");
  assertNetworkV1Sequence(identity.commandSequence, "commandSequence");
}

export function assertNetworkV1CompletionIdentity(
  identity: NetworkV1CompletionIdentity,
): void {
  assertNetworkV1RuntimeGeneration(identity.runtimeGeneration);
  assertNetworkV1Handle(identity.resource, "resource");
  assertNetworkV1Handle(identity.operation, "operation");
  assertNetworkV1Handle(identity.body, "body");
  assertNetworkV1Sequence(identity.sequence);
}

export function assertNetworkV1CompletionPollResult(
  request: NetworkV1CompletionPollRequest,
  result: NetworkV1CompletionPollResult,
): void {
  assertNetworkV1RuntimeGeneration(request.runtimeGeneration);
  assertIntegerInRange(
    request.maxPayloadBytes,
    0,
    NETWORK_V1_UINT32_MAX,
    "completionPoll.maxPayloadBytes",
  );
  if (result.status === NetworkV1CompletionPollStatus.Item) {
    assertIntegerInRange(
      result.payloadBytesDelivered,
      0,
      request.maxPayloadBytes,
      "completionPoll.payloadBytesDelivered",
    );
    assertNetworkV1CompletionIdentity(result.completion.identity);
    if (result.completion.identity.runtimeGeneration !== request.runtimeGeneration) {
      fail("completionPoll", "returned a stale runtime generation");
    }
    if (result.completion.eventCode === NetworkV1EventCode.BodyChunk) {
      assertNetworkV1LeaseDescriptor(result.completion.payload);
      if (result.completion.payload.runtimeGeneration !== request.runtimeGeneration ||
        result.completion.payload.byteLength !== result.payloadBytesDelivered) {
        fail("completionPoll", "BODY_CHUNK payload does not match its lease descriptor");
      }
    } else if (result.payloadBytesDelivered !== 0) {
      fail("completionPoll", "a descriptor without payload consumed byte budget");
    }
    return;
  }
  if (result.status !== NetworkV1CompletionPollStatus.Drained &&
    result.status !== NetworkV1CompletionPollStatus.BudgetExhausted) {
    fail("completionPoll.status", "is unknown");
  }
  if (result.payloadBytesDelivered !== 0) {
    fail("completionPoll", "a non-item result cannot consume byte budget");
  }
}

export function networkV1IdentityMatchesGeneration(
  identity: NetworkV1CompletionIdentity,
  current: NetworkV1GenerationSnapshot,
): boolean {
  if (identity.runtimeGeneration !== current.runtimeGeneration) return false;
  if (current.resource && !networkV1SameHandle(identity.resource, current.resource)) return false;
  if (current.operation && !networkV1SameHandle(identity.operation, current.operation)) return false;
  if (current.body && !networkV1SameHandle(identity.body, current.body)) return false;
  return true;
}

export function assertNetworkV1NextSequence(last: number, next: number): void {
  if (last !== 0) assertNetworkV1Sequence(last, "lastSequence");
  assertNetworkV1Sequence(next, "nextSequence");
  if (next <= last) fail("nextSequence", "must be strictly monotonic");
}

export function networkV1PlanHashBytes(planHash: string): Uint8Array {
  const match = /^sha256:([0-9a-f]{64})$/.exec(planHash);
  if (!match) fail("planHash", "must be a lowercase sha256 digest");
  const hex = match[1]!;
  const bytes = new Uint8Array(NETWORK_V1_PLAN_HASH_BYTES);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const NETWORK_V1_FEATURE_ID_SET: ReadonlySet<number> =
  new Set<number>(NETWORK_V1_FEATURE_IDS);

function assertFeatureIds(
  featureIds: readonly number[],
  label: string,
): asserts featureIds is readonly NetworkV1FeatureId[] {
  let previous = 0;
  for (let index = 0; index < featureIds.length; index += 1) {
    const feature = featureIds[index];
    assertIntegerInRange(feature, 1, 0xffff, `${label}[${index}]`);
    if (!NETWORK_V1_FEATURE_ID_SET.has(feature)) {
      fail(`${label}[${index}]`, "is not defined by ABI v1.0");
    }
    if (feature <= previous) fail(label, "must be unique and strictly increasing");
    previous = feature;
  }
}

export function networkV1FeatureIdsFromBuildPlan(
  features: Readonly<Record<string, boolean>>,
): readonly NetworkV1FeatureId[] {
  const ids: NetworkV1FeatureId[] = [];
  for (const [capability, enabled] of Object.entries(features)) {
    if (!enabled || !capability.startsWith("network.")) continue;
    const id = (NETWORK_V1_FEATURE_ID_BY_CAPABILITY as Readonly<Record<string, number>>)[
      capability
    ];
    if (id === undefined) fail("featureSet", `contains unknown capability ${capability}`);
    ids.push(id as NetworkV1FeatureId);
  }
  ids.sort((left, right) => left - right);
  assertFeatureIds(ids, "featureIds");
  return Object.freeze(ids.slice());
}

function assertPlanHash(value: Uint8Array, label: string): void {
  if (networkV1Uint8ArrayByteLength(value, label) !== NETWORK_V1_PLAN_HASH_BYTES) {
    fail(label, `must contain exactly ${NETWORK_V1_PLAN_HASH_BYTES} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function snapshotHandshake(value: NetworkV1Handshake, label: string): NetworkV1Handshake {
  if (typeof value !== "object" || value === null) fail(label, "must be an object");
  const record = value as Partial<NetworkV1Handshake>;
  // Snapshot every recognized Host-supplied field exactly once before any
  // validation. A frozen object can still expose stateful accessors.
  const abiMajor = record.abiMajor;
  const abiMinor = record.abiMinor;
  const runtimeGeneration = record.runtimeGeneration;
  const rawPlanHash = record.planHash;
  const rawFeatureIds = record.featureIds;

  assertIntegerInRange(abiMajor, 1, 0xffff, `${label}.abiMajor`);
  assertIntegerInRange(abiMinor, 0, 0xffff, `${label}.abiMinor`);
  assertNetworkV1RuntimeGeneration(runtimeGeneration, `${label}.runtimeGeneration`);
  assertPlanHash(rawPlanHash as Uint8Array, `${label}.planHash`);
  if (!Array.isArray(rawFeatureIds)) fail(`${label}.featureIds`, "must be an array");
  if (rawFeatureIds.length > NETWORK_V1_FEATURE_IDS.length) {
    fail(`${label}.featureIds`, "cannot exceed the known feature count");
  }
  const featureIds: number[] = [];
  for (let index = 0; index < rawFeatureIds.length; index += 1) {
    featureIds.push((rawFeatureIds as readonly number[])[index]!);
  }
  assertFeatureIds(featureIds, `${label}.featureIds`);
  return {
    abiMajor,
    abiMinor,
    runtimeGeneration,
    planHash: networkV1CopyUint8Array(rawPlanHash, `${label}.planHash`),
    featureIds,
  };
}

/** Validate before any application initializer, callback, or microtask runs. */
export function assertNetworkV1Handshake(
  expected: NetworkV1Handshake,
  actual: NetworkV1Handshake,
): void {
  const expectedSnapshot = snapshotHandshake(expected, "expectedHandshake");
  const actualSnapshot = snapshotHandshake(actual, "actualHandshake");
  if (expectedSnapshot.abiMajor !== NETWORK_V1_ABI_MAJOR ||
    expectedSnapshot.abiMinor !== NETWORK_V1_ABI_MINOR) {
    fail("expectedHandshake", "does not describe the compiled Guest ABI");
  }
  if (actualSnapshot.abiMajor !== expectedSnapshot.abiMajor ||
    actualSnapshot.abiMinor < expectedSnapshot.abiMinor) {
    fail("actualHandshake", "has an incompatible ABI version");
  }
  if (actualSnapshot.runtimeGeneration !== expectedSnapshot.runtimeGeneration) {
    fail("actualHandshake", "has a different runtime generation");
  }
  if (!equalBytes(actualSnapshot.planHash, expectedSnapshot.planHash)) {
    fail("actualHandshake", "does not match the verified Build Plan hash");
  }
  if (actualSnapshot.featureIds.length !== expectedSnapshot.featureIds.length ||
    actualSnapshot.featureIds.some(
      (feature, index) => feature !== expectedSnapshot.featureIds[index],
    )) {
    fail("actualHandshake", "does not match the exact Build Plan feature set");
  }
}

const NETWORK_V1_LIMIT_PROTOCOL_SET: ReadonlySet<number> = new Set([
  NETWORK_V1_LIMIT_PROTOCOL_ANY,
  ...Object.values(NetworkV1LimitProtocol),
]);

const NETWORK_V1_LIMIT_ROLE_SET: ReadonlySet<number> = new Set([
  NETWORK_V1_LIMIT_ROLE_ANY,
  ...Object.values(NetworkV1LimitRole),
]);

function assertNetworkV1LimitsQuery(
  query: NetworkV1LimitsQuery,
  runtimeGeneration: number,
): void {
  if (typeof query !== "object" || query === null) fail("limitsQuery", "must be an object");
  const queryRuntimeGeneration = query.runtimeGeneration;
  const protocol = query.protocol;
  const role = query.role;
  assertNetworkV1RuntimeGeneration(
    queryRuntimeGeneration,
    "limitsQuery.runtimeGeneration",
  );
  if (queryRuntimeGeneration !== runtimeGeneration) {
    fail("limitsQuery.runtimeGeneration", "does not match the mounted runtime");
  }
  assertIntegerInRange(protocol, 0, 0xffff, "limitsQuery.protocol");
  if (!NETWORK_V1_LIMIT_PROTOCOL_SET.has(protocol)) {
    fail("limitsQuery.protocol", "is unknown");
  }
  assertIntegerInRange(role, 0, 0xffff, "limitsQuery.role");
  if (!NETWORK_V1_LIMIT_ROLE_SET.has(role)) fail("limitsQuery.role", "is unknown");
}

function frozenDataField(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) {
    fail(`${label}.${key}`, "must be an own frozen data property");
  }
  return descriptor.value;
}

function assertFrozenRecord(value: unknown, label: string): asserts value is object {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) {
    fail(label, "must be a frozen object");
  }
}

function capabilityMatchesLimitsQuery(
  capability: string,
  protocol: NetworkV1LimitProtocolQuery,
  role: NetworkV1LimitRoleQuery,
): boolean {
  let protocolMatches = true;
  if (protocol === NetworkV1LimitProtocol.Http) {
    protocolMatches = capability.startsWith("network.http.") ||
      capability.startsWith("network.browser.http.");
  } else if (protocol === NetworkV1LimitProtocol.WebSocket) {
    protocolMatches = capability.startsWith("network.websocket.") ||
      capability.startsWith("network.browser.websocket.");
  } else if (protocol === NetworkV1LimitProtocol.Mqtt) {
    protocolMatches = capability.startsWith("network.mqtt.");
  } else if (protocol === NetworkV1LimitProtocol.Tcp) {
    protocolMatches = capability.startsWith("network.tcp.");
  } else if (protocol === NetworkV1LimitProtocol.Udp) {
    protocolMatches = capability === "network.udp" ||
      capability.startsWith("network.udp.");
  }
  if (!protocolMatches || role === NETWORK_V1_LIMIT_ROLE_ANY) return protocolMatches;
  if (role === NetworkV1LimitRole.Client) {
    return capability.includes(".client") || capability.includes(".browser.");
  }
  return capability.includes(".server");
}

function expectedLimitFeatureIds(
  handshakeSnapshot: NetworkV1Handshake,
  protocol: NetworkV1LimitProtocolQuery,
  role: NetworkV1LimitRoleQuery,
): readonly NetworkV1FeatureId[] {
  return handshakeSnapshot.featureIds.filter((featureId) => {
    const capability = (
      NETWORK_V1_FEATURE_CAPABILITY_BY_ID as Readonly<Record<number, string>>
    )[featureId];
    return capability !== undefined &&
      capabilityMatchesLimitsQuery(capability, protocol, role);
  });
}

/**
 * Validate and detach the ABI 1.1 limits result before exposing it publicly.
 * Every Host-provided container must already be frozen and accessor-free.
 */
export function snapshotNetworkV1Limits(
  query: NetworkV1LimitsQuery,
  value: unknown,
  handshake: NetworkV1Handshake,
): Readonly<NetworkV1LimitsSnapshot> {
  const handshakeSnapshot = snapshotHandshake(handshake, "handshake");
  assertNetworkV1LimitsQuery(query, handshakeSnapshot.runtimeGeneration);
  assertFrozenRecord(value, "limitsSnapshot");

  const runtimeGeneration = frozenDataField(
    value,
    "runtimeGeneration",
    "limitsSnapshot",
  );
  const protocol = frozenDataField(value, "protocol", "limitsSnapshot");
  const role = frozenDataField(value, "role", "limitsSnapshot");
  const rawValues = frozenDataField(value, "values", "limitsSnapshot");
  const rawFeatureIds = frozenDataField(value, "featureIds", "limitsSnapshot");

  assertNetworkV1RuntimeGeneration(runtimeGeneration, "limitsSnapshot.runtimeGeneration");
  if (runtimeGeneration !== query.runtimeGeneration) {
    fail("limitsSnapshot.runtimeGeneration", "does not echo the query");
  }
  if (protocol !== query.protocol) fail("limitsSnapshot.protocol", "does not echo the query");
  if (role !== query.role) fail("limitsSnapshot.role", "does not echo the query");

  if (!Array.isArray(rawValues) || !Object.isFrozen(rawValues)) {
    fail("limitsSnapshot.values", "must be a frozen data array");
  }
  if (rawValues.length > NETWORK_V1_LIMIT_ENTRY_MAX) {
    fail("limitsSnapshot.values", `cannot exceed ${NETWORK_V1_LIMIT_ENTRY_MAX} entries`);
  }
  const values: NetworkV1LimitEntry[] = [];
  let previousName = "";
  for (let index = 0; index < rawValues.length; index += 1) {
    const entry = frozenDataField(rawValues, String(index), "limitsSnapshot.values");
    assertFrozenRecord(entry, `limitsSnapshot.values[${index}]`);
    const name = frozenDataField(entry, "name", `limitsSnapshot.values[${index}]`);
    const defaultValue = frozenDataField(
      entry,
      "default",
      `limitsSnapshot.values[${index}]`,
    );
    const hard = frozenDataField(entry, "hard", `limitsSnapshot.values[${index}]`);
    const minimum = frozenDataField(
      entry,
      "minimum",
      `limitsSnapshot.values[${index}]`,
    );
    if (typeof name !== "string" || name.length === 0 ||
      name.length > NETWORK_V1_LIMIT_NAME_MAX_BYTES ||
      !/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/.test(name) ||
      name.split(".").some((segment) =>
        segment === "constructor" || segment === "prototype"
      )) {
      fail(
        `limitsSnapshot.values[${index}].name`,
        "must be a bounded dotted ASCII identifier",
      );
    }
    if (name <= previousName) {
      fail("limitsSnapshot.values", "must be unique and lexicographically sorted");
    }
    assertIntegerInRange(
      defaultValue,
      1,
      Number.MAX_SAFE_INTEGER,
      `limitsSnapshot.values[${index}].default`,
    );
    assertIntegerInRange(
      hard,
      1,
      Number.MAX_SAFE_INTEGER,
      `limitsSnapshot.values[${index}].hard`,
    );
    assertIntegerInRange(
      minimum,
      0,
      Number.MAX_SAFE_INTEGER,
      `limitsSnapshot.values[${index}].minimum`,
    );
    if (minimum > defaultValue || defaultValue > hard) {
      fail(
        `limitsSnapshot.values[${index}]`,
        "must satisfy minimum <= default <= hard",
      );
    }
    values.push(Object.freeze({ name, default: defaultValue, hard, minimum }));
    previousName = name;
  }

  if (!Array.isArray(rawFeatureIds) || !Object.isFrozen(rawFeatureIds)) {
    fail("limitsSnapshot.featureIds", "must be a frozen data array");
  }
  if (rawFeatureIds.length > NETWORK_V1_FEATURE_IDS.length) {
    fail("limitsSnapshot.featureIds", "cannot exceed the known feature count");
  }
  const featureIds: number[] = [];
  for (let index = 0; index < rawFeatureIds.length; index += 1) {
    featureIds.push(
      frozenDataField(rawFeatureIds, String(index), "limitsSnapshot.featureIds") as number,
    );
  }
  assertFeatureIds(featureIds, "limitsSnapshot.featureIds");
  const expectedFeatureIds = expectedLimitFeatureIds(
    handshakeSnapshot,
    query.protocol,
    query.role,
  );
  if (featureIds.length !== expectedFeatureIds.length ||
    featureIds.some((featureId, index) => featureId !== expectedFeatureIds[index])) {
    fail("limitsSnapshot.featureIds", "does not match the exact scoped feature set");
  }

  return Object.freeze({
    runtimeGeneration,
    protocol: query.protocol,
    role: query.role,
    values: Object.freeze(values),
    featureIds: Object.freeze(featureIds as NetworkV1FeatureId[]),
  });
}

const NETWORK_V1_BINDING_KEYS = [
  "handshake",
  "getLimits",
  "dispatch",
  "nextCompletion",
  "leaseTake",
  "leaseReadInto",
  "leaseRelease",
  "registerServiceDispatcher",
] as const;

/**
 * Validate the lexical table without invoking accessors. Newer ABI minors may
 * append frozen data properties; every v1.1 property remains mandatory.
 */
export function assertNetworkV1BindingTable(
  value: unknown,
  expectedHandshake: NetworkV1Handshake,
): asserts value is NetworkV1BindingTable {
  if (typeof value !== "object" || value === null || !Object.isFrozen(value)) {
    fail("bindingTable", "must be a frozen object");
  }
  const fields = new Map<string, unknown>();
  for (const key of NETWORK_V1_BINDING_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(`bindingTable.${key}`, "must be an own frozen data property");
    }
    fields.set(key, descriptor.value);
  }
  const actualHandshake = fields.get("handshake");
  if (typeof actualHandshake !== "object" || actualHandshake === null ||
    !Object.isFrozen(actualHandshake)) {
    fail("bindingTable.handshake", "must be frozen");
  }
  const featureIds = Object.getOwnPropertyDescriptor(actualHandshake, "featureIds");
  if (!featureIds || !("value" in featureIds) || !Object.isFrozen(featureIds.value)) {
    fail("bindingTable.handshake.featureIds", "must be a frozen data array");
  }
  assertNetworkV1Handshake(
    expectedHandshake,
    actualHandshake as NetworkV1Handshake,
  );
  for (const key of NETWORK_V1_BINDING_KEYS.slice(1)) {
    if (typeof fields.get(key) !== "function") {
      fail(`bindingTable.${key}`, "must be a function");
    }
  }
}

export interface NetworkV1BodyFlowState {
  readonly pendingCredit: number;
  readonly terminal: boolean;
}

export type NetworkV1BodySignal =
  | Readonly<{ kind: "pull"; maxBytes: number }>
  | Readonly<{ kind: "chunk"; byteLength: number }>
  | Readonly<{ kind: "end" | "error" | "cancel" }>;

export const NETWORK_V1_INITIAL_BODY_FLOW: NetworkV1BodyFlowState =
  Object.freeze({ pendingCredit: 0, terminal: false });

/** Shared state machine for command-pull/event-chunk and event-pull/command-chunk. */
export function networkV1ApplyBodySignal(
  state: NetworkV1BodyFlowState,
  signal: NetworkV1BodySignal,
  maxChunkBytes: number,
): NetworkV1BodyFlowState {
  assertIntegerInRange(maxChunkBytes, 1, NETWORK_V1_UINT32_MAX, "maxChunkBytes");
  assertIntegerInRange(
    state.pendingCredit,
    0,
    maxChunkBytes,
    "body.pendingCredit",
  );
  if (state.terminal) fail("body", "cannot receive a signal after terminal state");

  if (signal.kind === "pull") {
    assertIntegerInRange(signal.maxBytes, 1, maxChunkBytes, "BODY_PULL.maxBytes");
    if (state.pendingCredit !== 0) fail("BODY_PULL", "cannot overlap existing credit");
    return Object.freeze({ pendingCredit: signal.maxBytes, terminal: false });
  }
  if (signal.kind === "chunk") {
    if (state.pendingCredit === 0) fail("BODY_CHUNK", "requires prior BODY_PULL credit");
    assertIntegerInRange(
      signal.byteLength,
      1,
      state.pendingCredit,
      "BODY_CHUNK.byteLength",
    );
    return Object.freeze({ pendingCredit: 0, terminal: false });
  }
  return Object.freeze({ pendingCredit: 0, terminal: true });
}

/** Exact BufferLease ownership transitions; every other edge is an ABI fault. */
export function networkV1LeaseTransition(
  state: NetworkV1LeaseState,
  action: NetworkV1LeaseAction,
): NetworkV1LeaseState {
  if (state === NetworkV1LeaseState.Queued && action === NetworkV1LeaseAction.Take) {
    return NetworkV1LeaseState.Taken;
  }
  if (state === NetworkV1LeaseState.Queued && action === NetworkV1LeaseAction.Cleanup) {
    return NetworkV1LeaseState.Released;
  }
  if (state === NetworkV1LeaseState.Taken && action === NetworkV1LeaseAction.Release) {
    return NetworkV1LeaseState.Released;
  }
  fail("BufferLease", "has an invalid take/release/cleanup transition");
}

export function assertNetworkV1LeaseDescriptor(
  descriptor: NetworkV1LeaseDescriptor,
): void {
  assertNetworkV1RuntimeGeneration(descriptor.runtimeGeneration);
  assertNetworkV1Handle(descriptor.lease, "lease", false);
  assertIntegerInRange(
    descriptor.byteLength,
    1,
    NETWORK_V1_UINT32_MAX,
    "lease.byteLength",
  );
}

export function assertNetworkV1BorrowedInput(
  input: NetworkV1BorrowedInput,
  expectedKind: NetworkV1BorrowedInputKind,
  maxBytes: number,
  exactBytes?: number,
): void {
  assertIntegerInRange(maxBytes, 1, NETWORK_V1_UINT32_MAX, "borrowedInput.maxBytes");
  if (input.kind !== expectedKind) fail("borrowedInput.kind", "does not match the command");
  const byteLength = networkV1Uint8ArrayByteLength(
    input.bytes,
    "borrowedInput.bytes",
  );
  assertIntegerInRange(
    byteLength,
    1,
    maxBytes,
    "borrowedInput.byteLength",
  );
  if (exactBytes !== undefined) {
    assertIntegerInRange(exactBytes, 1, maxBytes, "borrowedInput.exactBytes");
    if (byteLength !== exactBytes) {
      fail("borrowedInput.byteLength", "does not match normalized metadata");
    }
  }
}

export function assertNetworkV1LeaseReadInto(
  command: NetworkV1BufferLeaseReadIntoCommand,
  destination: Uint8Array,
  leaseByteLength: number,
): void {
  assertNetworkV1CommandIdentity(command.identity);
  assertNetworkV1Handle(command.lease, "lease", false);
  assertIntegerInRange(leaseByteLength, 1, NETWORK_V1_UINT32_MAX, "leaseByteLength");
  assertIntegerInRange(command.offset, 0, leaseByteLength, "leaseRead.offset");
  assertIntegerInRange(command.maxBytes, 1, NETWORK_V1_UINT32_MAX, "leaseRead.maxBytes");
  if (networkV1Uint8ArrayByteLength(destination, "leaseRead.destination") !==
    command.maxBytes) {
    fail("leaseRead.destination", "must be the exact borrowed Uint8Array window");
  }
  if (command.maxBytes > leaseByteLength - command.offset) {
    fail("leaseRead", "would read beyond the BufferLease");
  }
}

export function assertNetworkV1ServiceTurnRequest(
  request: NetworkV1ServiceTurnRequest,
): void {
  assertNetworkV1RuntimeGeneration(request.runtimeGeneration);
  assertNetworkV1Sequence(request.turnId, "turnId");
  if (request.kind !== NetworkV1ServiceTurnKind.Network &&
    request.kind !== NetworkV1ServiceTurnKind.Shutdown) {
    fail("serviceTurn.kind", "is unknown");
  }
  assertIntegerInRange(request.maxEvents, 1, NETWORK_V1_UINT32_MAX, "maxEvents");
  assertIntegerInRange(
    request.maxPayloadBytes,
    1,
    NETWORK_V1_UINT32_MAX,
    "maxPayloadBytes",
  );
}

export function assertNetworkV1ServiceTurnResult(
  request: NetworkV1ServiceTurnRequest,
  result: NetworkV1ServiceTurnResult,
): void {
  assertNetworkV1ServiceTurnRequest(request);
  if (result.status !== NetworkV1ServiceTurnStatus.Drained &&
    result.status !== NetworkV1ServiceTurnStatus.MoreReady) {
    fail("serviceTurn.status", "is unknown");
  }
  assertIntegerInRange(
    result.eventsDelivered,
    0,
    request.maxEvents,
    "eventsDelivered",
  );
  assertIntegerInRange(
    result.payloadBytesDelivered,
    0,
    request.maxPayloadBytes,
    "payloadBytesDelivered",
  );
  if (result.eventsDelivered === 0) {
    if (result.lastSequence !== 0 || result.payloadBytesDelivered !== 0) {
      fail("serviceTurn.result", "must use zero sequence/bytes when no event was delivered");
    }
  } else {
    assertNetworkV1Sequence(result.lastSequence, "lastSequence");
  }
}
