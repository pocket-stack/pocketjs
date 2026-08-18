import { AbortController, fetch } from "@pocketjs/framework/net/http";

const REPORT_GLOBAL = "__pocketjsFormalNetworkTlsSmokeReportV1";
const CANCEL_GLOBAL = "__pocketjsFormalNetworkTlsSmokeCancelV1";
const ORIGIN = "https://pocketjs.test:8443";
const ROUNDS_TOTAL = 20;
const HEALTH_BODY =
  '{"peer":"mac","protocol":"pocketjs-independent-peer-v1","status":"ok"}';
const TLS_POLICY = Object.freeze({
  serverName: "pocketjs.test",
  minVersion: "1.2" as const,
  maxVersion: "1.2" as const,
  verification: "full" as const,
  revocation: "host-default" as const,
});

type SmokePhase = "starting" | "health" | "echo" | "passed" | "failed";

interface SmokeState {
  version: 1;
  checkpoint: number;
  phase: SmokePhase;
  roundsTotal: number;
  roundsStarted: number;
  roundsPassed: number;
  requestsPassed: number;
  frameCalls: number;
  done: boolean;
  ok: boolean;
  errorName: string;
  errorCode: string;
  errorOperation: string;
}

const state: SmokeState = {
  version: 1,
  checkpoint: 0,
  phase: "starting",
  roundsTotal: ROUNDS_TOTAL,
  roundsStarted: 0,
  roundsPassed: 0,
  requestsPassed: 0,
  frameCalls: 0,
  done: false,
  ok: false,
  errorName: "",
  errorCode: "",
  errorOperation: "",
};

let activeController: AbortController | null = null;

function cancelActiveRequest(): boolean {
  const controller = activeController;
  if (controller === null) return false;
  controller.abort();
  return true;
}

function checkpoint(phase: SmokePhase): void {
  state.phase = phase;
  state.checkpoint += 1;
}

function report(): Readonly<SmokeState> {
  return Object.freeze({ ...state });
}

function boundedDiagnostic(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 64) : "";
}

function recordFailure(error: unknown): void {
  const candidate = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : {};
  state.errorName = boundedDiagnostic(candidate.name);
  state.errorCode = boundedDiagnostic(candidate.code);
  state.errorOperation = boundedDiagnostic(candidate.operation);
  state.done = true;
  state.ok = false;
  checkpoint("failed");
}

function echoPayload(round: number): Uint8Array {
  return new Uint8Array([
    0x00, 0xff, 0x54, 0x4c, 0x53, 0x2d, 0x50, 0x6f, 0x63, 0x6b, round, 0x7f,
  ]);
}

async function* streamedPayload(payload: Uint8Array): AsyncIterable<Uint8Array> {
  yield payload.slice(0, 3);
  yield payload.slice(3, 8);
  yield payload.slice(8);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function run(): Promise<void> {
  try {
    for (let round = 1; round <= ROUNDS_TOTAL; round += 1) {
      state.roundsStarted = round;
      checkpoint("health");
      const healthController = new AbortController();
      activeController = healthController;
      let health;
      try {
        health = await fetch(`${ORIGIN}/health`, {
          signal: healthController.signal,
          tls: TLS_POLICY,
        });
      } finally {
        activeController = null;
      }
      if (health.status !== 200 || await health.text() !== HEALTH_BODY) {
        throw new Error("formal TLS smoke health response mismatch");
      }
      state.requestsPassed += 1;

      checkpoint("echo");
      const payload = echoPayload(round);
      const echoController = new AbortController();
      activeController = echoController;
      let echo;
      try {
        echo = await fetch(`${ORIGIN}/echo`, {
          method: "POST",
          body: streamedPayload(payload),
          signal: echoController.signal,
          tls: TLS_POLICY,
        });
      } finally {
        activeController = null;
      }
      const echoed = new Uint8Array(await echo.arrayBuffer());
      if (echo.status !== 200 || !equalBytes(echoed, payload)) {
        throw new Error("formal TLS smoke echo response mismatch");
      }
      state.requestsPassed += 1;
      state.roundsPassed = round;
    }
    state.done = true;
    state.ok = true;
    checkpoint("passed");
  } catch (error) {
    recordFailure(error);
  }
}

Object.defineProperty(globalThis, REPORT_GLOBAL, {
  value: report,
  configurable: false,
  enumerable: false,
  writable: false,
});

Object.defineProperty(globalThis, CANCEL_GLOBAL, {
  value: cancelActiveRequest,
  configurable: false,
  enumerable: false,
  writable: false,
});

// The Host polls REPORT_GLOBAL; hardware conformance never calls frame().
Object.defineProperty(globalThis, "frame", {
  value: () => {
    state.frameCalls += 1;
  },
  configurable: false,
  enumerable: false,
  writable: false,
});

void run();
