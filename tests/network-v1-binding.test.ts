import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
  NETWORK_V1_LIMIT_PROTOCOL_ANY,
  NETWORK_V1_LIMIT_ROLE_ANY,
  NETWORK_V1_UINT32_MAX,
  NetworkV1CommandOpcode,
  NetworkV1CompletionPollStatus,
  NetworkV1DispatchStatus,
  NetworkV1ErrorCategory,
  NetworkV1ErrorCode,
  NetworkV1EventCode,
  NetworkV1FeatureId,
  NetworkV1LimitProtocol,
  NetworkV1LimitRole,
  NetworkV1ServiceTurnKind,
  NetworkV1ServiceTurnStatus,
  type NetworkV1AsyncCommand,
  type NetworkV1BindingTable,
  type NetworkV1BufferLeaseReadIntoCommand,
  type NetworkV1BufferLeaseReleaseCommand,
  type NetworkV1BufferLeaseTakeCommand,
  type NetworkV1Completion,
  type NetworkV1CompletionIdentity,
  type NetworkV1Handle,
  type NetworkV1LimitsQuery,
  type NetworkV1LimitEntry,
  type NetworkV1ServiceDispatcher,
} from "../contracts/spec/network/network-v1.ts";
import {
  createNetworkV1HttpBindingAdapterForTesting,
  type NetworkV1CompiledExpectation,
} from "../framework/src/net/network-v1-binding.ts";
import {
  installHttpClientBindingForTesting,
  NetworkV1CommandOpcode as HighCommandOpcode,
  type HttpRequestStartCommand,
} from "../framework/src/net/http-binding.ts";
import { AbortController } from "../framework/src/net/abort.ts";
import { fetch as httpFetch } from "../framework/src/net/http.ts";
import type { BodyStream, HttpBodyProducer } from "../framework/src/net/http-body.ts";

const RUNTIME_GENERATION = 7;
const PLAN_HASH = Object.freeze(new Array<number>(32).fill(0x5a));
const FEATURE_IDS = Object.freeze([NetworkV1FeatureId.HttpClient]);
const EXPECTED: NetworkV1CompiledExpectation = Object.freeze({
  planHashBytes: PLAN_HASH,
  featureIds: FEATURE_IDS,
});
const ABSENT = Object.freeze({ id: 0, generation: 0 });
const DEFAULT_HTTP_CLIENT_LIMITS = Object.freeze([
  Object.freeze({
    name: "http.bufferedBodyBytes",
    default: 4096,
    hard: 8192,
    minimum: 1024,
  }),
  Object.freeze({
    name: "http.headerBytes",
    default: 8192,
    hard: 16384,
    minimum: 4096,
  }),
  Object.freeze({
    name: "http.maxBodyChunkBytes",
    default: 2048,
    hard: 4096,
    minimum: 512,
  }),
  Object.freeze({
    name: "http.maxOperations",
    default: 8,
    hard: 8,
    minimum: 1,
  }),
  Object.freeze({
    name: "runtime.nativeBufferBytes",
    default: 512 * 1024,
    hard: 1024 * 1024,
    minimum: 256 * 1024,
  }),
]);

function admittedBinding(
  adapter: ReturnType<typeof createNetworkV1HttpBindingAdapterForTesting>,
) {
  if (adapter.binding === undefined) throw new Error("test expected an admitted HTTP binding");
  return adapter.binding;
}

function failure(
  code: NetworkV1ErrorCode = NetworkV1ErrorCode.SystemError,
) {
  return Object.freeze({
    category: code === NetworkV1ErrorCode.HttpProtocolError
      ? NetworkV1ErrorCategory.Protocol
      : NetworkV1ErrorCategory.Runtime,
    code,
    operation: "http.fetch",
    temporary: false,
  });
}

function highStart(operationId: number, hasBody = false): HttpRequestStartCommand {
  return Object.freeze({
    opcode: HighCommandOpcode.HttpRequestStart,
    operationId,
    url: "http://example.test/",
    method: "POST",
    headers: Object.freeze([]),
    hasBody,
    redirect: "follow",
    maxRedirects: 5,
    ref: true,
  });
}

function completionIdentity(
  start: Extract<NetworkV1AsyncCommand, {
    opcode: typeof NetworkV1CommandOpcode.HttpRequestStart;
  }>,
  body: NetworkV1Handle,
  sequence: number,
): NetworkV1CompletionIdentity {
  return Object.freeze({
    runtimeGeneration: RUNTIME_GENERATION,
    resource: start.identity.resource,
    operation: start.identity.operation,
    body,
    sequence,
  });
}

class FakeHost {
  readonly commands: NetworkV1AsyncCommand[] = [];
  readonly completions: NetworkV1Completion[] = [];
  readonly leases = new Map<string, { bytes: Uint8Array; state: "queued" | "taken" | "released" }>();
  readonly table: NetworkV1BindingTable;
  dispatcher?: NetworkV1ServiceDispatcher;
  registerCount = 0;
  releaseCount = 0;
  pollCount = 0;
  readonly limitsQueries: NetworkV1LimitsQuery[] = [];
  readonly #featureIds: readonly NetworkV1FeatureId[];
  readonly #limitValues: readonly Readonly<NetworkV1LimitEntry>[];
  #turnId = 0;
  #leaseId = 0;

  constructor(
    featureIds: readonly NetworkV1FeatureId[] = FEATURE_IDS,
    planHash: readonly number[] = PLAN_HASH,
    limitValues: readonly Readonly<NetworkV1LimitEntry>[] = DEFAULT_HTTP_CLIENT_LIMITS,
  ) {
    this.#featureIds = Object.freeze(Array.from(featureIds));
    this.#limitValues = limitValues;
    const handshake = Object.freeze({
      abiMajor: NETWORK_V1_ABI_MAJOR,
      abiMinor: NETWORK_V1_ABI_MINOR,
      runtimeGeneration: RUNTIME_GENERATION,
      planHash: Uint8Array.from(planHash),
      featureIds: Object.freeze(Array.from(featureIds)),
    });
    this.table = Object.freeze({
      handshake,
      getLimits: (query: NetworkV1LimitsQuery) => this.getLimits(query),
      dispatch: (command: NetworkV1AsyncCommand) => {
        this.commands.push(command);
        return Object.freeze({ status: NetworkV1DispatchStatus.Accepted });
      },
      nextCompletion: ({ maxPayloadBytes }: { maxPayloadBytes: number }) => {
        this.pollCount++;
        const completion = this.completions[0];
        if (!completion) {
          return Object.freeze({
            status: NetworkV1CompletionPollStatus.Drained,
            payloadBytesDelivered: 0 as const,
          });
        }
        const payload = completion.eventCode === NetworkV1EventCode.BodyChunk
          ? completion.payload.byteLength
          : 0;
        if (maxPayloadBytes === 0 || payload > maxPayloadBytes) {
          return Object.freeze({
            status: NetworkV1CompletionPollStatus.BudgetExhausted,
            payloadBytesDelivered: 0 as const,
          });
        }
        this.completions.shift();
        return Object.freeze({
          status: NetworkV1CompletionPollStatus.Item,
          completion,
          payloadBytesDelivered: payload,
        });
      },
      leaseTake: (command: NetworkV1BufferLeaseTakeCommand) => {
        const lease = this.leases.get(this.leaseKey(command.lease));
        if (!lease || lease.state !== "queued" ||
          lease.bytes.byteLength !== command.byteLength) {
          return Object.freeze({
            status: NetworkV1DispatchStatus.Refused,
            error: failure(NetworkV1ErrorCode.InvalidState),
          });
        }
        lease.state = "taken";
        return Object.freeze({
          status: NetworkV1DispatchStatus.Completed,
          byteLength: lease.bytes.byteLength,
        });
      },
      leaseReadInto: (
        command: NetworkV1BufferLeaseReadIntoCommand,
        destination: Uint8Array,
      ) => {
        const lease = this.leases.get(this.leaseKey(command.lease));
        if (!lease || lease.state !== "taken") {
          return Object.freeze({
            status: NetworkV1DispatchStatus.Refused,
            error: failure(NetworkV1ErrorCode.InvalidState),
          });
        }
        const count = Math.min(destination.byteLength, lease.bytes.byteLength - command.offset);
        destination.set(lease.bytes.subarray(command.offset, command.offset + count));
        return Object.freeze({
          status: NetworkV1DispatchStatus.Completed,
          bytesCopied: count,
        });
      },
      leaseRelease: (command: NetworkV1BufferLeaseReleaseCommand) => {
        const lease = this.leases.get(this.leaseKey(command.lease));
        if (!lease || lease.state !== "taken") {
          return Object.freeze({
            status: NetworkV1DispatchStatus.Refused,
            error: failure(NetworkV1ErrorCode.InvalidState),
          });
        }
        lease.state = "released";
        this.releaseCount++;
        return Object.freeze({ status: NetworkV1DispatchStatus.Completed });
      },
      registerServiceDispatcher: (dispatcher: NetworkV1ServiceDispatcher) => {
        this.registerCount++;
        this.dispatcher = dispatcher;
      },
    });
  }

  get startCommand() {
    for (let index = this.commands.length - 1; index >= 0; index--) {
      const command = this.commands[index]!;
      if (command.opcode === NetworkV1CommandOpcode.HttpRequestStart) return command;
    }
    throw new Error("test expected an HTTP request start command");
  }

  getLimits(query: NetworkV1LimitsQuery) {
    this.limitsQueries.push(query);
    const http = query.protocol === NETWORK_V1_LIMIT_PROTOCOL_ANY ||
      query.protocol === NetworkV1LimitProtocol.Http;
    const client = query.role === NETWORK_V1_LIMIT_ROLE_ANY ||
      query.role === NetworkV1LimitRole.Client;
    const featureIds = http && client ? this.#featureIds : Object.freeze([]);
    const values = featureIds.length === 0
      ? Object.freeze([])
      : this.#limitValues;
    return Object.freeze({
      runtimeGeneration: RUNTIME_GENERATION,
      protocol: query.protocol,
      role: query.role,
      values,
      featureIds,
    });
  }

  headers(
    body: NetworkV1Handle = ABSENT,
    sequence = 1,
    status = 200,
  ): NetworkV1Completion {
    return Object.freeze({
      eventCode: NetworkV1EventCode.HttpResponseHeaders,
      identity: completionIdentity(this.startCommand, body, sequence),
      metadata: Object.freeze({
        status,
        statusText: "OK",
        headers: Object.freeze([Object.freeze({ name: "content-type", value: "text/plain" })]),
        url: "http://example.test/",
        redirected: false,
        bufferedBodyBytes: 4096,
      }),
    });
  }

  chunk(body: NetworkV1Handle, bytes: readonly number[], sequence: number): NetworkV1Completion {
    const lease = Object.freeze({ id: ++this.#leaseId, generation: 1 });
    this.leases.set(this.leaseKey(lease), { bytes: Uint8Array.from(bytes), state: "queued" });
    return Object.freeze({
      eventCode: NetworkV1EventCode.BodyChunk,
      identity: completionIdentity(this.startCommand, body, sequence),
      payload: Object.freeze({
        runtimeGeneration: RUNTIME_GENERATION,
        lease,
        byteLength: bytes.length,
      }),
    });
  }

  end(body: NetworkV1Handle, sequence: number): NetworkV1Completion {
    return Object.freeze({
      eventCode: NetworkV1EventCode.BodyEnd,
      identity: completionIdentity(this.startCommand, body, sequence),
    });
  }

  run(maxEvents = 8, maxPayloadBytes = 65_536) {
    return this.dispatcher!(Object.freeze({
      runtimeGeneration: RUNTIME_GENERATION,
      turnId: ++this.#turnId,
      kind: NetworkV1ServiceTurnKind.Network,
      maxEvents,
      maxPayloadBytes,
    }));
  }

  private leaseKey(handle: NetworkV1Handle): string {
    return `${handle.id}:${handle.generation}`;
  }
}

function overrideHostTable(
  host: FakeHost,
  overrides: Partial<NetworkV1BindingTable>,
): NetworkV1BindingTable {
  return Object.freeze({ ...host.table, ...overrides });
}

describe("formal network v1 mount", () => {
  test("adopts only the non-zero Host runtime generation and registers once", () => {
    const host = new FakeHost();
    const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED);
    const binding = admittedBinding(adapter);
    expect(host.registerCount).toBe(1);
    binding.start(
      highStart(1),
      null,
      new AbortController().signal,
    );
    expect(host.startCommand.identity.runtimeGeneration).toBe(RUNTIME_GENERATION);
    expect(host.startCommand.identity.commandSequence).toBe(1);
    expect(binding.featureSet).toEqual(["network.http.client"]);
  });

  test("rejects plan/feature mismatch before dispatcher registration", () => {
    const wrongPlan = new FakeHost(FEATURE_IDS, Object.freeze(new Array(32).fill(0)));
    expect(() => createNetworkV1HttpBindingAdapterForTesting(
      wrongPlan.table,
      EXPECTED,
    )).toThrow("Build Plan hash");
    expect(wrongPlan.registerCount).toBe(0);

    const wrongFeatures = new FakeHost(Object.freeze([
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
    ]));
    expect(() => createNetworkV1HttpBindingAdapterForTesting(
      wrongFeatures.table,
      EXPECTED,
    )).toThrow("feature set");
    expect(wrongFeatures.registerCount).toBe(0);
  });

  test("never invokes hostile table accessors", () => {
    const base = new FakeHost();
    let reads = 0;
    const hostile = Object.freeze(Object.defineProperties({}, {
      handshake: { value: base.table.handshake, enumerable: true },
      getLimits: { value: base.table.getLimits, enumerable: true },
      dispatch: {
        enumerable: true,
        get() {
          reads++;
          return base.table.dispatch;
        },
      },
      nextCompletion: { value: base.table.nextCompletion, enumerable: true },
      leaseTake: { value: base.table.leaseTake, enumerable: true },
      leaseReadInto: { value: base.table.leaseReadInto, enumerable: true },
      leaseRelease: { value: base.table.leaseRelease, enumerable: true },
      registerServiceDispatcher: {
        value: base.table.registerServiceDispatcher,
        enumerable: true,
      },
    }));
    expect(() => createNetworkV1HttpBindingAdapterForTesting(
      hostile as NetworkV1BindingTable,
      EXPECTED,
    )).toThrow("data property");
    expect(reads).toBe(0);
  });

  test("does not expose or register HTTP when the client feature is absent", () => {
    const host = new FakeHost(Object.freeze([]));
    const expected = Object.freeze({
      planHashBytes: PLAN_HASH,
      featureIds: Object.freeze([]),
    });
    const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, expected);
    expect(adapter.binding).toBeUndefined();
    expect(adapter.httpClientLimits).toEqual({ values: [], features: [] });
    expect(host.registerCount).toBe(0);
    expect(host.commands).toHaveLength(0);
    expect(host.limitsQueries).toHaveLength(1);
  });

  test("mounts only the limits provider for a build without HTTP client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-v1-no-http-"));
    const resultPath = join(directory, "result.json");
    const adapterUrl = new URL(
      "../framework/src/net/network-v1-binding.ts",
      import.meta.url,
    ).href;
    const bindingUrl = new URL("../framework/src/net/http-binding.ts", import.meta.url).href;
    const limitsUrl = new URL("../framework/src/net/network-limits.ts", import.meta.url).href;
    const specUrl = new URL("../contracts/spec/network/network-v1.ts", import.meta.url).href;
    const source = `
      const adapter = await import(${JSON.stringify(adapterUrl)});
      const binding = await import(${JSON.stringify(bindingUrl)});
      const limits = await import(${JSON.stringify(limitsUrl)});
      const spec = await import(${JSON.stringify(specUrl)});
      let dispatchCount = 0;
      let registerCount = 0;
      let limitsCount = 0;
      const handshake = Object.freeze({
        abiMajor: spec.NETWORK_V1_ABI_MAJOR,
        abiMinor: spec.NETWORK_V1_ABI_MINOR,
        runtimeGeneration: ${RUNTIME_GENERATION},
        planHash: new Uint8Array(32).fill(0x5a),
        featureIds: Object.freeze([]),
      });
      const table = Object.freeze({
        handshake,
        getLimits(query) {
          limitsCount++;
          return Object.freeze({
            runtimeGeneration: query.runtimeGeneration,
            protocol: query.protocol,
            role: query.role,
            values: Object.freeze([]),
            featureIds: Object.freeze([]),
          });
        },
        dispatch() {
          dispatchCount++;
          return Object.freeze({ status: spec.NetworkV1DispatchStatus.Accepted });
        },
        nextCompletion() { throw new Error("completion polling must be unreachable"); },
        leaseTake() { throw new Error("lease take must be unreachable"); },
        leaseReadInto() { throw new Error("lease read must be unreachable"); },
        leaseRelease() { throw new Error("lease release must be unreachable"); },
        registerServiceDispatcher() { registerCount++; },
      });
      adapter.mountNetworkV1HttpBinding(table, Object.freeze({
        planHashBytes: Object.freeze(new Array(32).fill(0x5a)),
        featureIds: Object.freeze([]),
      }));
      const snapshot = limits.queryInstalledNetworkLimits("http", "client");
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        hasBinding: binding.getHttpClientBinding() !== undefined,
        snapshot,
        dispatchCount,
        registerCount,
        limitsCount,
      }));
    `;
    try {
      const script = join(directory, "mount.ts");
      await Bun.write(script, source);
      const child = Bun.spawn([process.execPath, script], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(await Bun.file(resultPath).json()).toEqual({
        hasBinding: false,
        snapshot: { values: [], features: [] },
        dispatchCount: 0,
        registerCount: 0,
        limitsCount: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("formal HTTP command/completion adapter", () => {
  test("rejects TRACK before dispatching formal request metadata", () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    expect(() => binding.start(
      Object.freeze({ ...highStart(1), method: "TRACK" }),
      null,
      new AbortController().signal,
    )).toThrow("request method is invalid");
    expect(host.commands).toHaveLength(0);
    binding.start(highStart(2), null, new AbortController().signal);
    expect(host.startCommand.identity.operation.generation).toBe(1);
  });

  test("snapshots every Host response metadata field exactly once", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const reads = new Map<string, number>();
    const field = <Value>(name: string, value: Value) => ({
      enumerable: true,
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      },
    });
    const metadata = Object.defineProperties({}, {
      status: field("status", 200),
      statusText: field("statusText", "OK"),
      headers: field("headers", Object.freeze([])),
      url: field("url", "http://example.test/"),
      redirected: field("redirected", false),
      bufferedBodyBytes: field("bufferedBodyBytes", 4096),
    });
    host.completions.push({
      eventCode: NetworkV1EventCode.HttpResponseHeaders,
      identity: completionIdentity(host.startCommand, ABSENT, 1),
      metadata,
    } as NetworkV1Completion);
    host.run();
    await expect(operation.response).resolves.toMatchObject({
      status: 200,
      redirected: false,
      url: "http://example.test/",
    });
    expect(Object.fromEntries(reads)).toEqual({
      status: 1,
      statusText: 1,
      headers: 1,
      url: 1,
      redirected: 1,
      bufferedBodyBytes: 1,
    });
  });

  test("uses only canonical URL hostnames in formal TLS metadata", () => {
    const tlsFeatureIds = Object.freeze([
      NetworkV1FeatureId.HttpClient,
      NetworkV1FeatureId.HttpClientTls,
    ]);
    const expected = Object.freeze({
      planHashBytes: PLAN_HASH,
      featureIds: tlsFeatureIds,
    });
    const host = new FakeHost(tlsFeatureIds);
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, expected));
    binding.start(Object.freeze({
      ...highStart(1),
      url: "https://example.test/",
      tls: Object.freeze({ serverName: "EXAMPLE.TEST." }),
    }), null, new AbortController().signal);
    expect(host.startCommand.metadata.tls).toMatchObject({
      serverName: "example.test",
    });

    binding.start(Object.freeze({
      ...highStart(2),
      url: "https://127.0.0.1/",
      tls: Object.freeze({ serverName: "127.0.0.1" }),
    }), null, new AbortController().signal);
    const starts = host.commands.filter((command): command is Extract<NetworkV1AsyncCommand, {
      opcode: typeof NetworkV1CommandOpcode.HttpRequestStart;
    }> => command.opcode === NetworkV1CommandOpcode.HttpRequestStart);
    expect(starts[1]!.metadata.tls).toMatchObject({ serverName: "" });

    expect(() => binding.start(Object.freeze({
      ...highStart(3),
      url: "https://example.test/",
      tls: Object.freeze({ serverName: "other.test" }),
    }), null, new AbortController().signal)).toThrow("canonical request hostname");
    expect(host.commands.filter(
      (command) => command.opcode === NetworkV1CommandOpcode.HttpRequestStart,
    )).toHaveLength(2);
  });

  test("publishes headers first and copies a response lease under BODY credit", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const responseBody = Object.freeze({ id: 101, generation: 3 });
    host.completions.push(host.headers(responseBody));
    expect(host.run()).toMatchObject({
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 1,
      payloadBytesDelivered: 0,
      lastSequence: 1,
    });
    const response = await operation.response;
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    const destination = new Uint8Array(8);
    const read = response.body!.readInto(destination);
    expect(host.commands.at(-1)).toMatchObject({
      opcode: NetworkV1CommandOpcode.BodyPull,
      identity: { body: responseBody },
      maxBytes: 8,
    });
    host.completions.push(host.chunk(responseBody, [1, 2, 3], 2));
    expect(host.run()).toMatchObject({ eventsDelivered: 1, payloadBytesDelivered: 3 });
    expect(await read).toEqual({ bytes: 3, done: false });
    expect([...destination.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect(host.releaseCount).toBe(1);

    const eof = response.body!.readInto(destination);
    host.completions.push(Object.freeze({
      eventCode: NetworkV1EventCode.BodyEnd,
      identity: completionIdentity(host.startCommand, responseBody, 3),
    }));
    host.run();
    expect(await eof).toEqual({ bytes: 0, done: true });
  });

  test("honors event/payload budgets without dequeuing a readiness probe", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 9, generation: 1 });
    host.completions.push(host.headers(body));
    expect(host.run(1, 32)).toMatchObject({ status: NetworkV1ServiceTurnStatus.Drained });
    const response = await operation.response;
    const read = response.body!.readInto(new Uint8Array(4));
    host.completions.push(host.chunk(body, [1, 2, 3, 4], 2));
    expect(host.run(8, 3)).toEqual({
      status: NetworkV1ServiceTurnStatus.MoreReady,
      eventsDelivered: 0,
      payloadBytesDelivered: 0,
      lastSequence: 0,
    });
    expect(host.completions).toHaveLength(1);
    host.run(8, 4);
    expect(await read).toEqual({ bytes: 4, done: false });
  });

  test("detaches every service-turn request field exactly once", () => {
    const host = new FakeHost();
    const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED);
    const reads = new Map<string, number>();
    const field = <Value>(name: string, value: Value) => ({
      enumerable: true,
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      },
    });
    const request = Object.defineProperties({}, {
      runtimeGeneration: field("runtimeGeneration", RUNTIME_GENERATION),
      turnId: field("turnId", 1),
      kind: field("kind", NetworkV1ServiceTurnKind.Network),
      maxEvents: field("maxEvents", 8),
      maxPayloadBytes: field("maxPayloadBytes", 65_536),
    });
    expect(adapter.dispatcher(request as Parameters<typeof adapter.dispatcher>[0])).toEqual({
      status: NetworkV1ServiceTurnStatus.Drained,
      eventsDelivered: 0,
      payloadBytesDelivered: 0,
      lastSequence: 0,
    });
    expect(Object.fromEntries(reads)).toEqual({
      runtimeGeneration: 1,
      turnId: 1,
      kind: 1,
      maxEvents: 1,
      maxPayloadBytes: 1,
    });
  });

  test("poisons oversized service-turn budgets before completion polling", () => {
    for (const oversized of [
      { maxEvents: 129, maxPayloadBytes: 65_536 },
      { maxEvents: 8, maxPayloadBytes: 256 * 1024 + 1 },
    ]) {
      const host = new FakeHost();
      const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED);
      const binding = admittedBinding(adapter);
      expect(() => adapter.dispatcher(Object.freeze({
        runtimeGeneration: RUNTIME_GENERATION,
        turnId: 1,
        kind: NetworkV1ServiceTurnKind.Network,
        ...oversized,
      }))).toThrow("outside");
      expect(host.pollCount).toBe(0);
      expect(() => binding.start(
        highStart(99),
        null,
        new AbortController().signal,
      )).toThrow("outside");
      expect(host.commands).toHaveLength(0);
    }
  });

  test("cleans stale and out-of-order selected leases without delivery", async () => {
    const staleHost = new FakeHost();
    const staleAdapter = createNetworkV1HttpBindingAdapterForTesting(staleHost.table, EXPECTED);
    const staleOperation = admittedBinding(staleAdapter).start(
      highStart(1),
      null,
      new AbortController().signal,
    );
    const staleBody = Object.freeze({ id: 8, generation: 1 });
    staleHost.completions.push(staleHost.headers(staleBody));
    staleHost.run();
    const staleResponse = await staleOperation.response;
    await staleResponse.body!.cancel();
    staleHost.completions.push(staleHost.chunk(staleBody, [9], 2));
    expect(staleHost.run()).toMatchObject({ eventsDelivered: 1 });
    expect(staleHost.releaseCount).toBe(1);

    const orderedHost = new FakeHost();
    const orderedAdapter = createNetworkV1HttpBindingAdapterForTesting(orderedHost.table, EXPECTED);
    const orderedOperation = admittedBinding(orderedAdapter).start(
      highStart(2),
      null,
      new AbortController().signal,
    );
    const orderedBody = Object.freeze({ id: 12, generation: 1 });
    orderedHost.completions.push(orderedHost.headers(orderedBody, 2));
    orderedHost.run();
    const orderedResponse = await orderedOperation.response;
    const pending = orderedResponse.body!.readInto(new Uint8Array(2));
    pending.catch(() => {});
    orderedHost.completions.push(orderedHost.chunk(orderedBody, [4, 5], 1));
    expect(() => orderedHost.run()).toThrow("strictly monotonic");
    expect(orderedHost.releaseCount).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  test("releases a taken lease after length validation fails and permanently poisons", async () => {
    const host = new FakeHost();
    const table = overrideHostTable(host, {
      leaseTake: ((command: NetworkV1BufferLeaseTakeCommand) => {
        const result = host.table.leaseTake(command);
        if (result.status !== NetworkV1DispatchStatus.Completed) return result;
        return Object.freeze({
          status: NetworkV1DispatchStatus.Completed,
          byteLength: result.byteLength + 1,
        });
      }) as NetworkV1BindingTable["leaseTake"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 31, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    const pending = response.body!.readInto(new Uint8Array(4));
    const rejected = pending.catch((error) => error);
    host.completions.push(host.chunk(body, [1, 2, 3], 2));
    expect(() => host.run()).toThrow("lease take length disagrees");
    expect(host.releaseCount).toBe(1);
    expect(await rejected).toBeInstanceOf(TypeError);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("lease take length disagrees");
  });

  test("claims lease status once and releases after a taken length getter throws", async () => {
    const host = new FakeHost();
    const marker = new Error("lease length getter failed");
    let statusReads = 0;
    let lengthReads = 0;
    const table = overrideHostTable(host, {
      leaseTake: ((command: NetworkV1BufferLeaseTakeCommand) => {
        const result = host.table.leaseTake(command);
        expect(result.status).toBe(NetworkV1DispatchStatus.Completed);
        return Object.freeze(Object.defineProperties({}, {
          status: {
            enumerable: true,
            get() {
              statusReads++;
              return NetworkV1DispatchStatus.Completed;
            },
          },
          byteLength: {
            enumerable: true,
            get() {
              lengthReads++;
              throw marker;
            },
          },
        })) as ReturnType<NetworkV1BindingTable["leaseTake"]>;
      }) as NetworkV1BindingTable["leaseTake"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 41, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    const pending = response.body!.readInto(new Uint8Array(4));
    const rejected = pending.catch((error) => error);
    host.completions.push(host.chunk(body, [1], 2));

    expect(() => host.run()).toThrow(marker);
    expect(await rejected).toBe(marker);
    expect(statusReads).toBe(1);
    expect(lengthReads).toBe(1);
    expect(host.releaseCount).toBe(1);
  });

  test("cleans a dequeued lease after payload accounting validation fails", async () => {
    const host = new FakeHost();
    const table = overrideHostTable(host, {
      nextCompletion: ((request: Parameters<NetworkV1BindingTable["nextCompletion"]>[0]) => {
        const result = host.table.nextCompletion(request);
        if (result.status !== NetworkV1CompletionPollStatus.Item ||
          result.completion.eventCode !== NetworkV1EventCode.BodyChunk) return result;
        return Object.freeze({
          ...result,
          payloadBytesDelivered: 0,
        });
      }) as NetworkV1BindingTable["nextCompletion"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 32, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    const pending = response.body!.readInto(new Uint8Array(4));
    const rejected = pending.catch((error) => error);
    host.completions.push(host.chunk(body, [4, 5], 2));
    expect(() => host.run()).toThrow("payload does not match its lease descriptor");
    expect(host.releaseCount).toBe(1);
    expect(await rejected).toBeInstanceOf(Error);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("payload does not match its lease descriptor");
  });

  test("permanently poisons when exact release of a taken lease fails", async () => {
    const host = new FakeHost();
    let releaseAttempts = 0;
    const table = overrideHostTable(host, {
      leaseRelease: ((_command: NetworkV1BufferLeaseReleaseCommand) => {
        releaseAttempts++;
        return Object.freeze({
          status: NetworkV1DispatchStatus.Refused,
          error: failure(NetworkV1ErrorCode.InvalidState),
        });
      }) as NetworkV1BindingTable["leaseRelease"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 33, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    const pending = response.body!.readInto(new Uint8Array(4));
    const rejected = pending.catch((error) => error);
    host.completions.push(host.chunk(body, [7], 2));
    expect(() => host.run()).toThrow("invalid_state");
    expect(releaseAttempts).toBe(1);
    expect(await rejected).toMatchObject({ code: "invalid_state" });
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("invalid_state");
  });

  test("persists a terminal response error when no read is pending", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 34, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    host.completions.push(Object.freeze({
      eventCode: NetworkV1EventCode.BodyError,
      identity: completionIdentity(host.startCommand, body, 2),
      error: failure(NetworkV1ErrorCode.SystemError),
    }));
    host.run();
    await expect(response.body!.readInto(new Uint8Array(4))).rejects.toMatchObject({
      code: "system_error",
    });
    await expect(response.body!.cancel()).rejects.toMatchObject({
      code: "system_error",
    });
    await expect(response.body![Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "system_error",
    });
  });

  test("sanitizes BODY_ERROR metadata and never reads a Host message", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 35, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    const reads = new Map<string, number>();
    const field = <Value>(name: string, value: Value) => ({
      enumerable: true,
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return value;
      },
    });
    const error = Object.defineProperties({}, {
      category: field("category", NetworkV1ErrorCategory.Runtime),
      code: field("code", NetworkV1ErrorCode.SystemError),
      operation: field("operation", "native.secret.operation"),
      temporary: field("temporary", true),
      address: field("address", "127.0.0.1"),
      port: field("port", 443),
      causeCode: field("causeCode", "ESP_ERR_TLS"),
      reasonCode: field("reasonCode", 42),
      message: field("message", "secret Host diagnostic"),
    });
    host.completions.push({
      eventCode: NetworkV1EventCode.BodyError,
      identity: completionIdentity(host.startCommand, body, 2),
      error,
    } as NetworkV1Completion);
    host.run();
    await expect(response.body!.readInto(new Uint8Array(4))).rejects.toMatchObject({
      message: "HTTP request failed with system_error",
      operation: "http.body.readInto",
      temporary: true,
      address: "127.0.0.1",
      port: 443,
      causeCode: "ESP_ERR_TLS",
      reasonCode: 42,
    });
    expect(Object.fromEntries(reads)).toEqual({
      category: 1,
      code: 1,
      operation: 1,
      temporary: 1,
      address: 1,
      port: 1,
      causeCode: 1,
      reasonCode: 1,
    });
    expect(reads.get("message")).toBeUndefined();
  });

  test("poisons non-token causes and non-canonical Host addresses", async () => {
    for (const metadata of [
      Object.freeze({ ...failure(), causeCode: "secret diagnostic text" }),
      Object.freeze({ ...failure(), address: "EXAMPLE.test" }),
    ]) {
      const host = new FakeHost();
      const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
      const operation = binding.start(highStart(1), null, new AbortController().signal);
      const body = Object.freeze({ id: 36, generation: 1 });
      host.completions.push(host.headers(body));
      host.run();
      const response = await operation.response;
      host.completions.push(Object.freeze({
        eventCode: NetworkV1EventCode.BodyError,
        identity: completionIdentity(host.startCommand, body, 2),
        error: metadata,
      }));
      expect(() => host.run()).toThrow();
      await expect(response.body!.readInto(new Uint8Array(4))).rejects.toBeInstanceOf(
        TypeError,
      );
      expect(() => binding.start(
        highStart(2),
        null,
        new AbortController().signal,
      )).toThrow();
    }
  });

  test("maps abort to one exact cancel command and a stable numeric error", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    const operation = binding.start(highStart(22), null, new AbortController().signal);
    const cancel = Object.freeze({
      opcode: HighCommandOpcode.OperationCancel,
      operationId: 22,
    });
    operation.cancel(cancel);
    operation.cancel(cancel);
    expect(host.commands.filter(
      (command) => command.opcode === NetworkV1CommandOpcode.OperationCancel,
    )).toHaveLength(1);
    host.completions.push(Object.freeze({
      eventCode: NetworkV1EventCode.HttpRequestError,
      identity: completionIdentity(host.startCommand, ABSENT, 1),
      error: failure(NetworkV1ErrorCode.Aborted),
    }));
    host.run();
    await expect(operation.response).rejects.toMatchObject({
      category: "runtime",
      code: "aborted",
      operationId: 22,
    });
  });

  test("poisons and clears a response pull when Host dispatch throws", async () => {
    const host = new FakeHost();
    const fault = new Error("response pull dispatch fault");
    const table = overrideHostTable(host, {
      dispatch: ((command: NetworkV1AsyncCommand) => {
        if (command.opcode === NetworkV1CommandOpcode.BodyPull) throw fault;
        return host.table.dispatch(command);
      }) as NetworkV1BindingTable["dispatch"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 41, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    await expect(response.body!.readInto(new Uint8Array(4))).rejects.toBe(fault);
    await expect(response.body!.cancel()).rejects.toBe(fault);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("response pull dispatch fault");
  });

  test("poisons and clears response read/cancel state when cancel dispatch throws", async () => {
    const host = new FakeHost();
    const fault = new Error("response cancel dispatch fault");
    const table = overrideHostTable(host, {
      dispatch: ((command: NetworkV1AsyncCommand) => {
        if (command.opcode === NetworkV1CommandOpcode.BodyCancel) throw fault;
        return host.table.dispatch(command);
      }) as NetworkV1BindingTable["dispatch"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 42, generation: 1 });
    host.completions.push(host.headers(body));
    host.run();
    const response = await operation.response;
    const pending = response.body!.readInto(new Uint8Array(4));
    const pendingFailure = pending.catch((error) => error);
    await expect(response.body!.cancel()).rejects.toBe(fault);
    expect(await pendingFailure).toBe(fault);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("response cancel dispatch fault");
  });

  test("poisons operation cancel dispatch faults without leaving a pending response", async () => {
    const host = new FakeHost();
    const fault = new Error("operation cancel dispatch fault");
    const table = overrideHostTable(host, {
      dispatch: ((command: NetworkV1AsyncCommand) => {
        if (command.opcode === NetworkV1CommandOpcode.OperationCancel) throw fault;
        return host.table.dispatch(command);
      }) as NetworkV1BindingTable["dispatch"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    const operation = binding.start(highStart(1), null, new AbortController().signal);
    const responseFailure = operation.response.catch((error) => error);
    expect(() => operation.cancel(Object.freeze({
      opcode: HighCommandOpcode.OperationCancel,
      operationId: 1,
    }))).toThrow("operation cancel dispatch fault");
    expect(await responseFailure).toBe(fault);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("operation cancel dispatch fault");
  });

  test("absorbs async upload callback failures after poisoning dispatch", async () => {
    const host = new FakeHost();
    const fault = new Error("upload dispatch fault");
    const table = overrideHostTable(host, {
      dispatch: ((command: NetworkV1AsyncCommand) => {
        if (command.opcode === NetworkV1CommandOpcode.BodyChunk) throw fault;
        return host.table.dispatch(command);
      }) as NetworkV1BindingTable["dispatch"],
    });
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(table, EXPECTED));
    let pulls = 0;
    let cancels = 0;
    const producer: HttpBodyProducer = Object.freeze({
      pull() {
        pulls++;
        return Promise.resolve(Uint8Array.from([1, 2, 3]));
      },
      cancel() {
        cancels++;
        return Promise.reject(new Error("producer cancel rejection"));
      },
    });
    const operation = binding.start(
      highStart(1, true),
      producer,
      new AbortController().signal,
    );
    const responseFailure = operation.response.catch((error) => error);
    host.completions.push(Object.freeze({
      eventCode: NetworkV1EventCode.BodyPull,
      identity: completionIdentity(host.startCommand, host.startCommand.identity.body, 1),
      maxBytes: 3,
    }));
    host.run();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await responseFailure).toBe(fault);
    expect(pulls).toBe(1);
    expect(cancels).toBe(1);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("upload dispatch fault");
  });

  test("pulls a Guest request producer once per credit and stops it at headers", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    let pulls = 0;
    let cancels = 0;
    const producer: HttpBodyProducer = Object.freeze({
      async pull(maxBytes: number) {
        pulls++;
        expect(maxBytes).toBe(3);
        return Uint8Array.from([7, 8, 9]);
      },
      async cancel() { cancels++; },
    });
    const operation = binding.start(highStart(5, true), producer, new AbortController().signal);
    const start = host.startCommand;
    expect(start.identity.body.id).not.toBe(0);
    host.completions.push(Object.freeze({
      eventCode: NetworkV1EventCode.BodyPull,
      identity: completionIdentity(start, start.identity.body, 1),
      maxBytes: 3,
    }));
    host.run();
    await Promise.resolve();
    await Promise.resolve();
    const chunk = host.commands.find(
      (command) => command.opcode === NetworkV1CommandOpcode.BodyChunk,
    );
    expect(chunk).toMatchObject({ input: { kind: 2 } });
    if (chunk?.opcode === NetworkV1CommandOpcode.BodyChunk) {
      expect([...chunk.input.bytes]).toEqual([7, 8, 9]);
    }
    expect(pulls).toBe(1);
    host.completions.push(host.headers(ABSENT, 2));
    host.run();
    await operation.response;
    await Promise.resolve();
    expect(cancels).toBe(1);
  });

  test("retires more than eight ignored small responses through bounded prefetch", async () => {
    const host = new FakeHost();
    const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED);
    const cleanup = installHttpClientBindingForTesting(admittedBinding(adapter));
    const retainedResponses: unknown[] = [];
    let sequence = 1;
    try {
      for (let index = 0; index < 9; index++) {
        const pending = httpFetch(`http://example.test/${index}`);
        const body = Object.freeze({ id: 100 + index, generation: 1 });
        host.completions.push(host.headers(body, sequence++));
        host.run();
        retainedResponses[retainedResponses.length] = await pending;

        host.completions.push(
          host.chunk(body, [0x30 + index], sequence++),
          host.end(body, sequence++),
        );
        host.run();
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(retainedResponses).toHaveLength(9);
      expect(host.commands.filter((command) =>
        command.opcode === NetworkV1CommandOpcode.HttpRequestStart
      )).toHaveLength(9);
      expect(host.commands.filter((command) =>
        command.opcode === NetworkV1CommandOpcode.OperationCancel
      )).toHaveLength(0);
      expect(host.releaseCount).toBe(9);
      for (const lease of host.leases.values()) expect(lease.state).toBe("released");
    } finally {
      cleanup();
    }
  });

  test("holds a bodyless operation slot until native BODY_END", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(
      host.table,
      EXPECTED,
      { maxOperations: 1 },
    ));
    const first = binding.start(highStart(1), null, new AbortController().signal);
    const firstGeneration = host.startCommand.identity.operation.generation;
    host.completions.push(host.headers(ABSENT, 1, 204));
    host.run();
    const response = await first.response;
    expect(response.status).toBe(204);
    expect("body" in response).toBe(false);
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("capacity");

    host.completions.push(host.end(ABSENT, 2));
    host.run();
    binding.start(highStart(3), null, new AbortController().signal);
    expect(host.startCommand.identity.operation.generation).toBe(firstGeneration + 1);
  });

  test("holds a cancelled body slot until native terminal cleanup", async () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(
      host.table,
      EXPECTED,
      { maxOperations: 1 },
    ));
    const first = binding.start(highStart(1), null, new AbortController().signal);
    const body = Object.freeze({ id: 91, generation: 1 });
    host.completions.push(host.headers(body, 1));
    host.run();
    const response = await first.response;
    await response.body!.cancel();
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("capacity");

    host.completions.push(host.chunk(body, [0x61], 2), Object.freeze({
      eventCode: NetworkV1EventCode.BodyError,
      identity: completionIdentity(host.startCommand, body, 3),
      error: failure(NetworkV1ErrorCode.Aborted),
    }));
    host.run();
    expect(host.releaseCount).toBe(1);
    expect(await response.body!.readInto(new Uint8Array(1))).toEqual({ bytes: 0, done: true });
    binding.start(highStart(3), null, new AbortController().signal);
  });

  test("bounds operation slots, advances generation, and never wraps", async () => {
    const host = new FakeHost();
    const adapter = createNetworkV1HttpBindingAdapterForTesting(
      host.table,
      EXPECTED,
      { maxOperations: 1 },
    );
    const binding = admittedBinding(adapter);
    const first = binding.start(highStart(1), null, new AbortController().signal);
    const firstGeneration = host.startCommand.identity.operation.generation;
    expect(() => binding.start(
      highStart(2),
      null,
      new AbortController().signal,
    )).toThrow("capacity");
    first.response.catch(() => {});
    host.completions.push(Object.freeze({
      eventCode: NetworkV1EventCode.HttpRequestError,
      identity: completionIdentity(host.startCommand, ABSENT, 1),
      error: failure(),
    }));
    host.run();
    await expect(first.response).rejects.toBeDefined();
    binding.start(highStart(3), null, new AbortController().signal);
    const starts = host.commands.filter((command) =>
      command.opcode === NetworkV1CommandOpcode.HttpRequestStart
    );
    expect(starts[1]!.identity.operation.generation).toBe(firstGeneration + 1);

    const exhaustedHost = new FakeHost();
    const exhausted = createNetworkV1HttpBindingAdapterForTesting(
      exhaustedHost.table,
      EXPECTED,
      { maxOperations: 1, initialSlotGeneration: NETWORK_V1_UINT32_MAX },
    );
    expect(() => admittedBinding(exhausted).start(
      highStart(4),
      null,
      new AbortController().signal,
    )).toThrow("capacity");
  });
});

describe("formal limits projection", () => {
  test("caches one immutable HTTP/client snapshot at mount", () => {
    const host = new FakeHost();
    const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED);
    expect(host.limitsQueries).toHaveLength(1);
    expect(host.limitsQueries[0]).toMatchObject({
      protocol: NetworkV1LimitProtocol.Http,
      role: NetworkV1LimitRole.Client,
    });
    expect(adapter.limits("http", "client")).toBe(adapter.httpClientLimits);
    expect(adapter.limits("http", "client")).toBe(adapter.httpClientLimits);
    expect(host.limitsQueries).toHaveLength(1);
    expect(Object.isFrozen(adapter.httpClientLimits)).toBe(true);
    expect(Object.isFrozen(adapter.httpClientLimits.values)).toBe(true);
    expect(Object.isFrozen(adapter.httpClientLimits.values[0])).toBe(true);
    expect(Object.isFrozen(adapter.httpClientLimits.features)).toBe(true);
  });

  test("accepts only admitted exact operation limits within minimum/default", () => {
    const host = new FakeHost();
    const binding = admittedBinding(createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED));
    binding.start(Object.freeze({
      ...highStart(1),
      limits: Object.freeze({ "http.maxBodyChunkBytes": 512 }),
    }), null, new AbortController().signal);
    expect(host.startCommand.metadata.limits).toEqual([
      { name: "http.maxBodyChunkBytes", value: 512 },
    ]);
    expect(() => binding.start(Object.freeze({
      ...highStart(2),
      limits: Object.freeze({ "http.maxBodyChunkBytes": 511 }),
    }), null, new AbortController().signal)).toThrow("outside [512, 2048]");
    expect(() => binding.start(Object.freeze({
      ...highStart(3),
      limits: Object.freeze({ "http.maxBodyChunkBytes": 2049 }),
    }), null, new AbortController().signal)).toThrow("outside [512, 2048]");
    expect(() => binding.start(Object.freeze({
      ...highStart(4),
      limits: Object.freeze({ "http.unknownLimit": 512 }),
    }), null, new AbortController().signal)).toThrow("not admitted for the HTTP client");
    expect(host.commands.filter(
      (command) => command.opcode === NetworkV1CommandOpcode.HttpRequestStart,
    )).toHaveLength(1);
  });

  test("validates the Host snapshot and keeps unscoped capabilities empty", () => {
    const host = new FakeHost();
    const adapter = createNetworkV1HttpBindingAdapterForTesting(host.table, EXPECTED);
    expect(adapter.limits("http", "client")).toEqual({
      values: DEFAULT_HTTP_CLIENT_LIMITS,
      features: ["network.http.client"],
    });
    expect(adapter.limits("http", "server").features).toEqual([]);
  });

  test("returns a recursively frozen null-prototype public snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketjs-network-limits-"));
    const resultPath = join(directory, "result.json");
    const limitsUrl = new URL(
      "../framework/src/net/network-limits.ts",
      import.meta.url,
    ).href;
    const netUrl = new URL("../framework/src/net/index.ts", import.meta.url).href;
    const source = `
      const limits = await import(${JSON.stringify(limitsUrl)});
      const net = await import(${JSON.stringify(netUrl)});
      limits.installNetworkLimitsProvider((protocol, role) => ({
        values: protocol === "http" && role === "client"
          ? [{ name: "http.maxBodyChunkBytes", default: 2, hard: 4, minimum: 1 }]
          : [],
        features: protocol === "http" && role === "client"
          ? ["network.http.client"]
          : [],
      }));
      const snapshot = net.getNetworkLimits("http", "client");
      let unadmitted = "";
      try { net.getNetworkLimits("http", "server"); } catch (error) {
        unadmitted = error.message;
      }
      let invalid = "";
      try { net.getNetworkLimits("invalid"); } catch (error) {
        invalid = error.constructor.name;
      }
      await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({
        valuesNull: Object.getPrototypeOf(snapshot.values) === null,
        featuresNull: Object.getPrototypeOf(snapshot.features) === null,
        entryNull: Object.getPrototypeOf(snapshot.values["http.maxBodyChunkBytes"]) === null,
        frozen: Object.isFrozen(snapshot) && Object.isFrozen(snapshot.values) &&
          Object.isFrozen(snapshot.features) &&
          Object.isFrozen(snapshot.values["http.maxBodyChunkBytes"]),
        feature: snapshot.features["network.http.client"],
        unadmitted,
        invalid,
      }));
    `;
    try {
      const script = join(directory, "limits.ts");
      await Bun.write(script, source);
      const child = Bun.spawn([process.execPath, script], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(await Bun.file(resultPath).json()).toEqual({
        valuesNull: true,
        featuresNull: true,
        entryNull: true,
        frozen: true,
        feature: true,
        unadmitted: "Network limits are unavailable for an unadmitted scope",
        invalid: "TypeError",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
