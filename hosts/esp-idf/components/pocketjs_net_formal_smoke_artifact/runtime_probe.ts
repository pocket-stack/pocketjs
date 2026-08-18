import { join } from "node:path";
import {
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
  NETWORK_V1_LIMIT_PROTOCOL_ANY,
  NETWORK_V1_LIMIT_ROLE_ANY,
  NetworkV1CompletionPollStatus,
  NetworkV1DispatchStatus,
  NetworkV1ErrorCategory,
  NetworkV1ErrorCode,
  NetworkV1LimitProtocol,
  NetworkV1LimitRole,
  type NetworkV1BindingTable,
  type NetworkV1FeatureId,
} from "../../../../contracts/spec/network/network-v1.ts";

const generated = process.env.POCKETJS_TEST_ARTIFACT_DIR;
if (generated === undefined || generated.length === 0) {
  throw new Error("POCKETJS_TEST_ARTIFACT_DIR is required");
}
const metadata = await Bun.file(join(generated, "metadata.json")).json() as {
  planHashBytes: number[];
  featureIds: number[];
  reportGlobal: string;
};
const binary = new Uint8Array(await Bun.file(
  join(generated, "factory.js.bin"),
).arrayBuffer());
if (binary.length < 2 || binary[binary.length - 1] !== 0) {
  throw new Error("factory storage is not NUL-terminated");
}

const featureIds = Object.freeze(
  metadata.featureIds.slice() as NetworkV1FeatureId[],
);
const handshake = Object.freeze({
  abiMajor: NETWORK_V1_ABI_MAJOR,
  abiMinor: NETWORK_V1_ABI_MINOR,
  runtimeGeneration: 1,
  planHash: Uint8Array.from(metadata.planHashBytes),
  featureIds,
});
const completed = () => Object.freeze({ status: NetworkV1DispatchStatus.Completed });
const binding = Object.freeze({
  handshake,
  getLimits(query: { runtimeGeneration: number; protocol: number; role: number }) {
    const admitted = (
      query.protocol === NETWORK_V1_LIMIT_PROTOCOL_ANY ||
      query.protocol === NetworkV1LimitProtocol.Http
    ) && (
      query.role === NETWORK_V1_LIMIT_ROLE_ANY ||
      query.role === NetworkV1LimitRole.Client
    );
    return Object.freeze({
      runtimeGeneration: 1,
      protocol: query.protocol,
      role: query.role,
      values: Object.freeze(admitted ? [
        Object.freeze({
          name: "http.bufferedBodyBytes",
          default: 4096,
          hard: 16384,
          minimum: 4096,
        }),
        Object.freeze({
          name: "http.headerBytes",
          default: 4096,
          hard: 8192,
          minimum: 4096,
        }),
        Object.freeze({
          name: "http.maxBodyChunkBytes",
          default: 2048,
          hard: 2048,
          minimum: 512,
        }),
        Object.freeze({
          name: "http.maxOperations",
          default: 1,
          hard: 1,
          minimum: 1,
        }),
        Object.freeze({
          name: "runtime.nativeBufferBytes",
          default: 65536,
          hard: 524288,
          minimum: 65536,
        }),
      ] : []),
      featureIds: Object.freeze(admitted ? featureIds.slice() : []),
    });
  },
  dispatch() {
    return Object.freeze({
      status: NetworkV1DispatchStatus.Refused,
      error: Object.freeze({
        category: NetworkV1ErrorCategory.Runtime,
        code: NetworkV1ErrorCode.PermissionDenied,
        operation: "http.request.start",
        temporary: false,
      }),
    });
  },
  nextCompletion() {
    return Object.freeze({
      status: NetworkV1CompletionPollStatus.Drained,
      payloadBytesDelivered: 0,
    });
  },
  leaseTake(command: { byteLength: number }) {
    return Object.freeze({
      status: NetworkV1DispatchStatus.Completed,
      byteLength: command.byteLength,
    });
  },
  leaseReadInto(command: { maxBytes: number }) {
    return Object.freeze({
      status: NetworkV1DispatchStatus.Completed,
      bytesCopied: command.maxBytes,
    });
  },
  leaseRelease: completed,
  registerServiceDispatcher(dispatcher: unknown) {
    if (typeof dispatcher !== "function") {
      throw new TypeError("service dispatcher was not installed");
    }
  },
}) as unknown as NetworkV1BindingTable;

const source = new TextDecoder().decode(binary.subarray(0, binary.length - 1));
const factory = (0, eval)(source) as (binding: NetworkV1BindingTable) => unknown;
if (typeof factory !== "function" || factory.length !== 0) {
  throw new Error("generated artifact did not evaluate to the factory ABI");
}
if (Object.hasOwn(globalThis, metadata.reportGlobal) || Object.hasOwn(globalThis, "frame")) {
  throw new Error("application initialized before the factory call");
}
factory(binding);
for (let checkpoint = 0; checkpoint < 20; checkpoint += 1) {
  await Promise.resolve();
}

const reportFunction = (globalThis as Record<string, unknown>)[metadata.reportGlobal];
if (typeof reportFunction !== "function" || typeof globalThis.frame !== "function") {
  throw new Error("factory did not install its report and legacy frame slots");
}
const report = (reportFunction as () => Record<string, unknown>)();
if (
  !Object.isFrozen(report) ||
  report.version !== 1 ||
  report.phase !== "failed" ||
  report.done !== true ||
  report.ok !== false ||
  report.roundsTotal !== 20 ||
  report.roundsStarted !== 1 ||
  report.roundsPassed !== 0 ||
  report.requestsPassed !== 0 ||
  report.frameCalls !== 0 ||
  report.errorCode !== "permission_denied"
) {
  throw new Error(`unexpected refusal report: ${JSON.stringify(report)}`);
}

console.log(JSON.stringify(report));
