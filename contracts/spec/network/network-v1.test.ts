import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateNetworkV1Header,
  generateNetworkV1TypeScript,
  NETWORK_V1_HEADER_PATH,
  NETWORK_V1_TYPESCRIPT_PATH,
  validateNetworkV1Definition,
} from "./generate.ts";
import {
  assertNetworkV1BorrowedInput,
  assertNetworkV1BindingTable,
  assertNetworkV1CommandIdentity,
  assertNetworkV1CompletionIdentity,
  assertNetworkV1CompletionPollResult,
  assertNetworkV1Handle,
  assertNetworkV1Handshake,
  assertNetworkV1LeaseDescriptor,
  assertNetworkV1LeaseReadInto,
  assertNetworkV1NextSequence,
  assertNetworkV1RuntimeGeneration,
  assertNetworkV1Sequence,
  assertNetworkV1ServiceTurnRequest,
  assertNetworkV1ServiceTurnResult,
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
  NETWORK_V1_ABSENT_HANDLE,
  NETWORK_V1_COMMAND_OPCODES,
  NETWORK_V1_ERROR_CODES,
  NETWORK_V1_EVENT_CODES,
  NETWORK_V1_FEATURE_IDS,
  NETWORK_V1_INITIAL_BODY_FLOW,
  NETWORK_V1_LIMIT_ENTRY_MAX,
  NETWORK_V1_LIMIT_PROTOCOL_ANY,
  NETWORK_V1_LIMIT_ROLE_ANY,
  NETWORK_V1_SEQUENCE_MAX,
  NETWORK_V1_UINT32_MAX,
  networkV1ApplyBodySignal,
  networkV1FeatureIdsFromBuildPlan,
  networkV1HandleIsAbsent,
  networkV1IdentityMatchesGeneration,
  networkV1LeaseTransition,
  networkV1NextGeneration,
  networkV1PlanHashBytes,
  snapshotNetworkV1Limits,
  NetworkV1BorrowedInputKind,
  NetworkV1CommandOpcode,
  NetworkV1CompletionPollStatus,
  NetworkV1EventCode,
  NetworkV1FeatureId,
  NetworkV1LeaseAction,
  NetworkV1LeaseState,
  NetworkV1LimitProtocol,
  NetworkV1LimitRole,
  NetworkV1ServiceTurnKind,
  NetworkV1ServiceTurnStatus,
  type NetworkV1CommandIdentity,
  type NetworkV1CompletionIdentity,
  type NetworkV1Handshake,
  type NetworkV1LimitEntry,
  type NetworkV1LimitsQuery,
} from "./network-v1.ts";

const ZERO_HASH = `sha256:${"00".repeat(32)}`;
const ONE_HASH = `sha256:${"01".repeat(32)}`;

function live(id = 1, generation = 1) {
  return { id, generation } as const;
}

function commandIdentity(
  overrides: Partial<NetworkV1CommandIdentity> = {},
): NetworkV1CommandIdentity {
  return {
    runtimeGeneration: 1,
    resource: live(1, 2),
    operation: live(2, 3),
    body: live(3, 4),
    commandSequence: 1,
    ...overrides,
  };
}

function completionIdentity(
  overrides: Partial<NetworkV1CompletionIdentity> = {},
): NetworkV1CompletionIdentity {
  return {
    runtimeGeneration: 1,
    resource: live(1, 2),
    operation: live(2, 3),
    body: live(3, 4),
    sequence: 1,
    ...overrides,
  };
}

function handshake(overrides: Partial<NetworkV1Handshake> = {}): NetworkV1Handshake {
  return {
    abiMajor: NETWORK_V1_ABI_MAJOR,
    abiMinor: NETWORK_V1_ABI_MINOR,
    runtimeGeneration: 1,
    planHash: networkV1PlanHashBytes(ZERO_HASH),
    featureIds: [NetworkV1FeatureId.HttpClient, NetworkV1FeatureId.HttpClientTls],
    ...overrides,
  };
}

function expectStrictlyIncreasing(values: readonly number[]): void {
  expect(values.length).toBeGreaterThan(0);
  expect(new Set(values).size).toBe(values.length);
  expect(values[0]).toBeGreaterThan(0);
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index]!).toBeGreaterThan(values[index - 1]!);
  }
}

function frozenLimits(
  query: NetworkV1LimitsQuery,
  values: readonly NetworkV1LimitEntry[],
  featureIds: readonly NetworkV1FeatureId[],
) {
  return Object.freeze({
    runtimeGeneration: query.runtimeGeneration,
    protocol: query.protocol,
    role: query.role,
    values: Object.freeze(values.map((entry) => Object.freeze({ ...entry }))),
    featureIds: Object.freeze([...featureIds]),
  });
}

describe("network private ABI code generation", () => {
  test("regenerates the committed TypeScript and C header byte-for-byte", async () => {
    validateNetworkV1Definition();
    const [typescript, header] = await Promise.all([
      Bun.file(NETWORK_V1_TYPESCRIPT_PATH).text(),
      Bun.file(NETWORK_V1_HEADER_PATH).text(),
    ]);
    expect(typescript).toBe(generateNetworkV1TypeScript());
    expect(header).toBe(generateNetworkV1Header());
  });

  test("keeps every numeric namespace unique, non-zero, and append-only ordered", () => {
    expectStrictlyIncreasing(NETWORK_V1_FEATURE_IDS);
    expectStrictlyIncreasing(NETWORK_V1_COMMAND_OPCODES);
    expectStrictlyIncreasing(NETWORK_V1_EVENT_CODES);
    expectStrictlyIncreasing(NETWORK_V1_ERROR_CODES);

    expect(NetworkV1CommandOpcode.OperationCancel).toBe(0x0001);
    expect(NetworkV1CommandOpcode.BufferLeaseTake).toBe(0x0002);
    expect(NetworkV1CommandOpcode.BufferLeaseReadInto).toBe(0x0003);
    expect(NetworkV1CommandOpcode.BufferLeaseRelease).toBe(0x0004);
    expect(NetworkV1CommandOpcode.HttpRequestStart).toBe(0x0100);
    expect(NetworkV1EventCode.HttpResponseHeaders).toBe(0x0100);
    expect(NetworkV1EventCode.HttpRequestError).toBe(0x0101);

    for (const name of ["BodyPull", "BodyChunk", "BodyEnd", "BodyError", "BodyCancel"] as const) {
      expect(NetworkV1CommandOpcode[name]).toBe(NetworkV1EventCode[name]);
    }
  });

  test("compiles the generated native header as strict C11", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-abi-"));
    try {
      const source = join(directory, "abi_smoke.c");
      const output = join(directory, "abi_smoke");
      await Bun.write(source, `
#include "pocketjs_network_v1_abi.h"

int main(void) {
  pocketjs_network_v1_handle_t absent = {0};
  pocketjs_network_v1_handle_t live = {1, 1};
  pocketjs_network_v1_service_turn_request_t turn = {0};
  turn.runtime_generation = 1;
  turn.turn_id = 1;
  turn.kind = POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_NETWORK;
  turn.max_events = 1;
  turn.max_payload_bytes = 1;
  if (!pocketjs_network_v1_handle_is_absent(absent)) return 1;
  if (!pocketjs_network_v1_handle_is_live(live)) return 2;
  pocketjs_network_v1_limits_query_t query = {0};
  pocketjs_network_v1_limit_entry_view_t entry = {0};
  pocketjs_network_v1_limits_snapshot_view_t limits = {0};
  query.runtime_generation = 1;
  query.protocol = POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_HTTP;
  query.role = POCKETJS_NETWORK_V1_LIMIT_ROLE_CLIENT;
  entry.name = "http.headerBytes";
  entry.name_length = 16;
  limits.runtime_generation = query.runtime_generation;
  limits.protocol = query.protocol;
  limits.role = query.role;
  limits.values = &entry;
  limits.value_count = 1;
  if (POCKETJS_NETWORK_V1_ABI_MAJOR != 1 || POCKETJS_NETWORK_V1_ABI_MINOR != 1) return 3;
  if (POCKETJS_NETWORK_V1_COMMAND_BODY_PULL != POCKETJS_NETWORK_V1_EVENT_BODY_PULL) return 4;
  return turn.kind == 0 || limits.value_count != 1;
}
`);
      const includeDirectory = dirname(NETWORK_V1_HEADER_PATH);
      const compiled = Bun.spawnSync([
        process.env.CC ?? "cc",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-I",
        includeDirectory,
        source,
        "-o",
        output,
      ]);
      expect(compiled.exitCode).toBe(0);
      expect(compiled.stderr.toString()).toBe("");
      expect(Bun.spawnSync([output]).exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("network v1 mount handshake", () => {
  test("accepts only the exact plan hash and sorted feature projection", () => {
    const expected = handshake();
    expect(() => assertNetworkV1Handshake(expected, handshake())).not.toThrow();
    expect(() => assertNetworkV1Handshake(expected, handshake({ abiMinor: 1 }))).not.toThrow();

    expect(() => assertNetworkV1Handshake(expected, handshake({ abiMajor: 2 }))).toThrow(
      "incompatible ABI version",
    );
    expect(() => assertNetworkV1Handshake(expected, handshake({ runtimeGeneration: 2 }))).toThrow(
      "different runtime generation",
    );
    expect(() => assertNetworkV1Handshake(
      expected,
      handshake({ planHash: networkV1PlanHashBytes(ONE_HASH) }),
    )).toThrow("Build Plan hash");
    expect(() => assertNetworkV1Handshake(
      expected,
      handshake({ featureIds: [NetworkV1FeatureId.HttpClient] }),
    )).toThrow("feature set");
    expect(() => assertNetworkV1Handshake(
      expected,
      handshake({
        featureIds: [NetworkV1FeatureId.HttpClientTls, NetworkV1FeatureId.HttpClient],
      }),
    )).toThrow("strictly increasing");
    expect(() => assertNetworkV1Handshake(
      expected,
      handshake({
        featureIds: [NetworkV1FeatureId.HttpClient, NetworkV1FeatureId.HttpClient],
      }),
    )).toThrow("strictly increasing");
    expect(() => assertNetworkV1Handshake(
      expected,
      handshake({ featureIds: [0xffff as NetworkV1FeatureId] }),
    )).toThrow("not defined");
  });

  test("snapshots each Host handshake field once before validation", () => {
    const reads = new Map<string, number>();
    const values = handshake();
    const hostile = Object.defineProperties({}, {
      abiMajor: { get: () => { reads.set("abiMajor", (reads.get("abiMajor") ?? 0) + 1); return values.abiMajor; } },
      abiMinor: { get: () => { reads.set("abiMinor", (reads.get("abiMinor") ?? 0) + 1); return values.abiMinor; } },
      runtimeGeneration: { get: () => { reads.set("runtimeGeneration", (reads.get("runtimeGeneration") ?? 0) + 1); return values.runtimeGeneration; } },
      planHash: { get: () => { reads.set("planHash", (reads.get("planHash") ?? 0) + 1); return values.planHash; } },
      featureIds: { get: () => { reads.set("featureIds", (reads.get("featureIds") ?? 0) + 1); return values.featureIds; } },
    }) as NetworkV1Handshake;
    expect(() => assertNetworkV1Handshake(handshake(), hostile)).not.toThrow();
    expect(Object.fromEntries(reads)).toEqual({
      abiMajor: 1,
      abiMinor: 1,
      runtimeGeneration: 1,
      planHash: 1,
      featureIds: 1,
    });
  });

  test("uses typed-array intrinsic slots without invoking a hostile iterator", () => {
    let byteLengthReads = 0;
    let iteratorCalls = 0;
    const planHash = new Uint8Array(32);
    Object.defineProperties(planHash, {
      byteLength: { get: () => { byteLengthReads += 1; return 1; } },
      [Symbol.iterator]: {
        value: () => { iteratorCalls += 1; throw new Error("iterator must not run"); },
      },
    });
    const actual = handshake({ planHash });
    expect(() => assertNetworkV1Handshake(handshake(), actual)).not.toThrow();
    expect(byteLengthReads).toBe(0);
    expect(iteratorCalls).toBe(0);
  });

  test("bounds handshake feature arrays before copying them", () => {
    const tooMany = Array.from(
      { length: NETWORK_V1_FEATURE_IDS.length + 1 },
      () => NetworkV1FeatureId.HttpClient,
    );
    expect(() => assertNetworkV1Handshake(
      handshake(),
      handshake({ featureIds: tooMany }),
    )).toThrow("known feature count");
  });

  test("requires a frozen accessor-free binding table before mount", () => {
    const expected = handshake();
    const actualHandshake = Object.freeze({
      ...handshake(),
      featureIds: Object.freeze([...handshake().featureIds]),
    });
    const method = () => undefined;
    const table = Object.freeze({
      handshake: actualHandshake,
      getLimits: method,
      dispatch: method,
      nextCompletion: method,
      leaseTake: method,
      leaseReadInto: method,
      leaseRelease: method,
      registerServiceDispatcher: method,
    });
    expect(() => assertNetworkV1BindingTable(table, expected)).not.toThrow();
    expect(() => assertNetworkV1BindingTable({ ...table }, expected)).toThrow("frozen");

    const accessorTable = Object.freeze(Object.defineProperties({}, {
      ...Object.fromEntries(Object.entries(table).map(([key, field]) => [key, {
        value: field,
        enumerable: true,
      }])),
      dispatch: { get: () => method, enumerable: true },
    }));
    expect(() => assertNetworkV1BindingTable(accessorTable, expected)).toThrow(
      "own frozen data property",
    );
  });

  test("projects only known enabled network Build Plan features in numeric order", () => {
    expect(networkV1FeatureIdsFromBuildPlan({
      "network.http.client.tls": true,
      "ui.core": true,
      "network.http.client": true,
      "network.udp": false,
    })).toEqual([
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
    ]);
    expect(() => networkV1FeatureIdsFromBuildPlan({
      "network.future.not-admitted": true,
    })).toThrow("unknown capability");
  });

  test("decodes only canonical SHA-256 Build Plan hashes", () => {
    expect(networkV1PlanHashBytes(ZERO_HASH)).toEqual(new Uint8Array(32));
    expect(networkV1PlanHashBytes(ONE_HASH)).toEqual(new Uint8Array(32).fill(1));
    expect(() => networkV1PlanHashBytes("sha256:00")).toThrow("lowercase sha256");
    expect(() => networkV1PlanHashBytes(`sha256:${"AA".repeat(32)}`)).toThrow(
      "lowercase sha256",
    );
  });
});

describe("network v1.1 admitted limits snapshot", () => {
  const query = Object.freeze({
    runtimeGeneration: 1,
    protocol: NetworkV1LimitProtocol.Http,
    role: NetworkV1LimitRole.Client,
  });
  const admittedHandshake = handshake({
    featureIds: [
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
      NetworkV1FeatureId.WebSocketServer,
      NetworkV1FeatureId.Udp,
    ],
  });
  const values = [
    { name: "http.headerBytes", default: 8192, hard: 16384, minimum: 4096 },
    { name: "runtime.connections", default: 4, hard: 8, minimum: 2 },
  ] as const;

  test("returns a detached frozen snapshot with the exact scoped features", () => {
    const source = frozenLimits(query, values, [
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
    ]);
    const snapshot = snapshotNetworkV1Limits(query, source, admittedHandshake);
    expect(snapshot).toEqual(source);
    expect(snapshot).not.toBe(source);
    expect(snapshot.values[0]).not.toBe(source.values[0]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.values)).toBe(true);
    expect(Object.isFrozen(snapshot.values[0])).toBe(true);
    expect(Object.isFrozen(snapshot.featureIds)).toBe(true);
  });

  test("requires a build-wide query to return the complete handshake feature set", () => {
    const globalQuery = Object.freeze({
      runtimeGeneration: 1,
      protocol: NETWORK_V1_LIMIT_PROTOCOL_ANY,
      role: NETWORK_V1_LIMIT_ROLE_ANY,
    });
    const source = frozenLimits(globalQuery, values, admittedHandshake.featureIds);
    expect(snapshotNetworkV1Limits(globalQuery, source, admittedHandshake).featureIds)
      .toEqual(admittedHandshake.featureIds);
    expect(() => snapshotNetworkV1Limits(
      globalQuery,
      frozenLimits(globalQuery, values, [NetworkV1FeatureId.HttpClient]),
      admittedHandshake,
    )).toThrow("exact scoped feature set");
  });

  test("rejects wrong scope, stale runtime, and feature escalation", () => {
    const valid = frozenLimits(query, values, [
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
    ]);
    expect(() => snapshotNetworkV1Limits(
      { ...query, runtimeGeneration: 2 },
      valid,
      admittedHandshake,
    )).toThrow("mounted runtime");
    expect(() => snapshotNetworkV1Limits(
      { ...query, protocol: 0xffff as NetworkV1LimitProtocol },
      valid,
      admittedHandshake,
    )).toThrow("protocol is unknown");
    expect(() => snapshotNetworkV1Limits(
      query,
      Object.freeze({ ...valid, role: NetworkV1LimitRole.Server }),
      admittedHandshake,
    )).toThrow("does not echo");
    expect(() => snapshotNetworkV1Limits(
      query,
      frozenLimits(query, values, [
        NetworkV1FeatureId.HttpClient,
        NetworkV1FeatureId.HttpClientTls,
        NetworkV1FeatureId.WebSocketServer,
      ]),
      admittedHandshake,
    )).toThrow("exact scoped feature set");
  });

  test("requires bounded sorted limits with minimum <= default <= hard", () => {
    const features = [
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
    ] as const;
    expect(() => snapshotNetworkV1Limits(
      query,
      frozenLimits(query, [...values].reverse(), features),
      admittedHandshake,
    )).toThrow("lexicographically sorted");
    expect(() => snapshotNetworkV1Limits(
      query,
      frozenLimits(query, [{
        name: "http.headerBytes",
        default: 2,
        hard: 1,
        minimum: 1,
      }], features),
      admittedHandshake,
    )).toThrow("minimum <= default <= hard");
    expect(() => snapshotNetworkV1Limits(
      query,
      frozenLimits(query, Array.from({ length: NETWORK_V1_LIMIT_ENTRY_MAX + 1 }, (_, index) => ({
        name: `runtime.limit${String(index).padStart(2, "0")}`,
        default: 1,
        hard: 1,
        minimum: 1,
      })), features),
      admittedHandshake,
    )).toThrow(`cannot exceed ${NETWORK_V1_LIMIT_ENTRY_MAX}`);
  });

  test("does not invoke Host accessors while validating limits", () => {
    let calls = 0;
    const hostile = Object.freeze(Object.defineProperties({}, {
      runtimeGeneration: { value: 1, enumerable: true },
      protocol: { value: query.protocol, enumerable: true },
      role: { value: query.role, enumerable: true },
      values: { get: () => { calls += 1; return []; }, enumerable: true },
      featureIds: {
        value: Object.freeze([
          NetworkV1FeatureId.HttpClient,
          NetworkV1FeatureId.HttpClientTls,
        ]),
        enumerable: true,
      },
    }));
    expect(() => snapshotNetworkV1Limits(query, hostile, admittedHandshake)).toThrow(
      "own frozen data property",
    );
    expect(calls).toBe(0);
  });
});

describe("network v1 generation identities", () => {
  test("distinguishes absent handles from every live generation", () => {
    expect(networkV1HandleIsAbsent(NETWORK_V1_ABSENT_HANDLE)).toBe(true);
    expect(() => assertNetworkV1Handle(NETWORK_V1_ABSENT_HANDLE)).not.toThrow();
    expect(() => assertNetworkV1Handle(NETWORK_V1_ABSENT_HANDLE, "handle", false)).toThrow(
      "must be live",
    );
    expect(() => assertNetworkV1Handle(live(NETWORK_V1_UINT32_MAX, NETWORK_V1_UINT32_MAX), "handle", false)).not.toThrow();
    expect(() => assertNetworkV1Handle({ id: 1, generation: 0 })).toThrow("zero/zero");
    expect(() => assertNetworkV1Handle({ id: 0, generation: 1 })).toThrow("zero/zero");
    expect(() => assertNetworkV1Handle({ id: NETWORK_V1_UINT32_MAX + 1, generation: 1 })).toThrow(
      "integer",
    );
  });

  test("pins runtime, resource, operation, and body generations on every envelope", () => {
    expect(() => assertNetworkV1CommandIdentity(commandIdentity())).not.toThrow();
    expect(() => assertNetworkV1CompletionIdentity(completionIdentity())).not.toThrow();
    expect(networkV1IdentityMatchesGeneration(completionIdentity(), {
      runtimeGeneration: 1,
      resource: live(1, 2),
      operation: live(2, 3),
      body: live(3, 4),
    })).toBe(true);
    expect(networkV1IdentityMatchesGeneration(completionIdentity(), {
      runtimeGeneration: 2,
    })).toBe(false);
    expect(networkV1IdentityMatchesGeneration(completionIdentity(), {
      runtimeGeneration: 1,
      resource: live(1, 3),
    })).toBe(false);
    expect(networkV1IdentityMatchesGeneration(completionIdentity(), {
      runtimeGeneration: 1,
      operation: live(2, 4),
    })).toBe(false);
    expect(networkV1IdentityMatchesGeneration(completionIdentity(), {
      runtimeGeneration: 1,
      body: live(3, 5),
    })).toBe(false);
  });

  test("fails closed at generation and safe-sequence boundaries", () => {
    expect(() => assertNetworkV1RuntimeGeneration(1)).not.toThrow();
    expect(() => assertNetworkV1RuntimeGeneration(NETWORK_V1_UINT32_MAX)).not.toThrow();
    expect(() => assertNetworkV1RuntimeGeneration(0)).toThrow();
    expect(() => assertNetworkV1RuntimeGeneration(NETWORK_V1_UINT32_MAX + 1)).toThrow();
    expect(networkV1NextGeneration(1)).toBe(2);
    expect(networkV1NextGeneration(NETWORK_V1_UINT32_MAX - 1)).toBe(
      NETWORK_V1_UINT32_MAX,
    );
    expect(() => networkV1NextGeneration(NETWORK_V1_UINT32_MAX)).toThrow();
    expect(() => assertNetworkV1Sequence(NETWORK_V1_SEQUENCE_MAX)).not.toThrow();
    expect(() => assertNetworkV1Sequence(NETWORK_V1_SEQUENCE_MAX + 1)).toThrow();
    expect(() => assertNetworkV1NextSequence(
      NETWORK_V1_SEQUENCE_MAX - 1,
      NETWORK_V1_SEQUENCE_MAX,
    )).not.toThrow();
    expect(() => assertNetworkV1NextSequence(7, 7)).toThrow("strictly monotonic");
  });
});

describe("network v1 BufferLease and body flow", () => {
  test("allows only queued-take-release or queued-cleanup ownership paths", () => {
    const taken = networkV1LeaseTransition(
      NetworkV1LeaseState.Queued,
      NetworkV1LeaseAction.Take,
    );
    expect(taken).toBe(NetworkV1LeaseState.Taken);
    expect(networkV1LeaseTransition(taken, NetworkV1LeaseAction.Release)).toBe(
      NetworkV1LeaseState.Released,
    );
    expect(networkV1LeaseTransition(
      NetworkV1LeaseState.Queued,
      NetworkV1LeaseAction.Cleanup,
    )).toBe(NetworkV1LeaseState.Released);
    expect(() => networkV1LeaseTransition(taken, NetworkV1LeaseAction.Take)).toThrow();
    expect(() => networkV1LeaseTransition(
      NetworkV1LeaseState.Released,
      NetworkV1LeaseAction.Release,
    )).toThrow();
  });

  test("bounds lease descriptors and owner-thread readInto windows", () => {
    expect(() => assertNetworkV1LeaseDescriptor({
      runtimeGeneration: 1,
      lease: live(NETWORK_V1_UINT32_MAX, NETWORK_V1_UINT32_MAX),
      byteLength: NETWORK_V1_UINT32_MAX,
    })).not.toThrow();
    expect(() => assertNetworkV1LeaseDescriptor({
      runtimeGeneration: 1,
      lease: live(),
      byteLength: 0,
    })).toThrow();

    const readCommand = {
      opcode: NetworkV1CommandOpcode.BufferLeaseReadInto,
      identity: commandIdentity(),
      lease: live(9, 2),
      offset: 3,
      maxBytes: 4,
    } as const;
    expect(() => assertNetworkV1LeaseReadInto(
      readCommand,
      new Uint8Array(4),
      7,
    )).not.toThrow();
    expect(() => assertNetworkV1LeaseReadInto(
      readCommand,
      new Uint8Array(3),
      7,
    )).toThrow("exact borrowed Uint8Array window");
    expect(() => assertNetworkV1LeaseReadInto(
      { ...readCommand, maxBytes: 5 },
      new Uint8Array(5),
      7,
    )).toThrow("beyond the BufferLease");
  });

  test("requires synchronous borrowed inputs to be non-empty exact windows", () => {
    const backing = new Uint8Array([0, 1, 2, 3]);
    expect(() => assertNetworkV1BorrowedInput(
      { kind: NetworkV1BorrowedInputKind.BodyChunk, bytes: backing.subarray(1, 3) },
      NetworkV1BorrowedInputKind.BodyChunk,
      2,
      2,
    )).not.toThrow();
    expect(() => assertNetworkV1BorrowedInput(
      { kind: NetworkV1BorrowedInputKind.CustomCa, bytes: new Uint8Array() },
      NetworkV1BorrowedInputKind.CustomCa,
      8,
    )).toThrow("integer");
    expect(() => assertNetworkV1BorrowedInput(
      { kind: NetworkV1BorrowedInputKind.CustomCa, bytes: new Uint8Array(2) },
      NetworkV1BorrowedInputKind.BodyChunk,
      8,
    )).toThrow("does not match");
    expect(() => assertNetworkV1BorrowedInput(
      { kind: NetworkV1BorrowedInputKind.CustomCa, bytes: new Uint8Array(2) },
      NetworkV1BorrowedInputKind.CustomCa,
      8,
      3,
    )).toThrow("does not match normalized metadata");
    const shadowed = new Uint8Array(4);
    Object.defineProperty(shadowed, "byteLength", { get: () => 1 });
    expect(() => assertNetworkV1BorrowedInput(
      { kind: NetworkV1BorrowedInputKind.BodyChunk, bytes: shadowed },
      NetworkV1BorrowedInputKind.BodyChunk,
      4,
      1,
    )).toThrow("does not match normalized metadata");
  });

  test("enforces one BODY_PULL credit before each bounded BODY_CHUNK", () => {
    const credited = networkV1ApplyBodySignal(
      NETWORK_V1_INITIAL_BODY_FLOW,
      { kind: "pull", maxBytes: 64 },
      64,
    );
    expect(credited).toEqual({ pendingCredit: 64, terminal: false });
    expect(() => networkV1ApplyBodySignal(
      credited,
      { kind: "pull", maxBytes: 1 },
      64,
    )).toThrow("overlap");
    expect(() => networkV1ApplyBodySignal(
      credited,
      { kind: "chunk", byteLength: 65 },
      64,
    )).toThrow();
    const consumed = networkV1ApplyBodySignal(
      credited,
      { kind: "chunk", byteLength: 64 },
      64,
    );
    expect(consumed).toEqual(NETWORK_V1_INITIAL_BODY_FLOW);
    expect(() => networkV1ApplyBodySignal(
      consumed,
      { kind: "chunk", byteLength: 1 },
      64,
    )).toThrow("requires prior BODY_PULL");
    const terminal = networkV1ApplyBodySignal(
      credited,
      { kind: "cancel" },
      64,
    );
    expect(terminal).toEqual({ pendingCredit: 0, terminal: true });
    expect(() => networkV1ApplyBodySignal(
      terminal,
      { kind: "end" },
      64,
    )).toThrow("after terminal");
  });
});

describe("network v1 service turns", () => {
  test("dequeues a whole payload only when it fits the remaining byte budget", () => {
    const request = { runtimeGeneration: 1, maxPayloadBytes: 4 } as const;
    const item = {
      status: NetworkV1CompletionPollStatus.Item,
      completion: {
        eventCode: NetworkV1EventCode.BodyChunk,
        identity: completionIdentity(),
        payload: {
          runtimeGeneration: 1,
          lease: live(7, 2),
          byteLength: 4,
        },
      },
      payloadBytesDelivered: 4,
    } as const;
    expect(() => assertNetworkV1CompletionPollResult(request, item)).not.toThrow();
    expect(() => assertNetworkV1CompletionPollResult(
      { ...request, maxPayloadBytes: 3 },
      item,
    )).toThrow("payloadBytesDelivered");
    expect(() => assertNetworkV1CompletionPollResult(request, {
      ...item,
      completion: {
        ...item.completion,
        identity: completionIdentity({ runtimeGeneration: 2 }),
      },
    })).toThrow("stale runtime generation");
    expect(() => assertNetworkV1CompletionPollResult(
      { runtimeGeneration: 1, maxPayloadBytes: 0 },
      {
        status: NetworkV1CompletionPollStatus.BudgetExhausted,
        payloadBytesDelivered: 0,
      },
    )).not.toThrow();
  });

  test("accepts exact event/byte budgets and reports stable sequence", () => {
    const request = {
      runtimeGeneration: NETWORK_V1_UINT32_MAX,
      turnId: NETWORK_V1_SEQUENCE_MAX,
      kind: NetworkV1ServiceTurnKind.Network,
      maxEvents: 8,
      maxPayloadBytes: 1024,
    } as const;
    expect(() => assertNetworkV1ServiceTurnRequest(request)).not.toThrow();
    expect(() => assertNetworkV1ServiceTurnResult(request, {
      status: NetworkV1ServiceTurnStatus.MoreReady,
      eventsDelivered: 8,
      payloadBytesDelivered: 1024,
      lastSequence: NETWORK_V1_SEQUENCE_MAX,
    })).not.toThrow();
    expect(() => assertNetworkV1ServiceTurnResult(request, {
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 0,
      payloadBytesDelivered: 0,
      lastSequence: 0,
    })).not.toThrow();
  });

  test("rejects over-budget and internally inconsistent service results", () => {
    const request = {
      runtimeGeneration: 1,
      turnId: 1,
      kind: NetworkV1ServiceTurnKind.Shutdown,
      maxEvents: 2,
      maxPayloadBytes: 4,
    } as const;
    expect(() => assertNetworkV1ServiceTurnResult(request, {
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 3,
      payloadBytesDelivered: 0,
      lastSequence: 3,
    })).toThrow("eventsDelivered");
    expect(() => assertNetworkV1ServiceTurnResult(request, {
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 1,
      payloadBytesDelivered: 5,
      lastSequence: 1,
    })).toThrow("payloadBytesDelivered");
    expect(() => assertNetworkV1ServiceTurnResult(request, {
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 0,
      payloadBytesDelivered: 0,
      lastSequence: 1,
    })).toThrow("zero sequence");
    expect(() => assertNetworkV1ServiceTurnResult(request, {
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 1,
      payloadBytesDelivered: 0,
      lastSequence: 0,
    })).toThrow("lastSequence");
  });
});
