import { fetch } from "@pocketjs/framework/net/http";

const REPORT_GLOBAL = "__pocketjsFormalNetworkSmokeReportV1";
const ORIGIN = "http://172.16.10.126:8088";
const ROUNDS_TOTAL = 20;
const HEALTH_BODY =
  '{"peer":"mac","protocol":"pocketjs-independent-peer-v1","status":"ok"}';

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
    0x00,
    0xff,
    0x50,
    0x6f,
    0x63,
    0x6b,
    0x65,
    0x74,
    0x4a,
    0x53,
    round,
    0x7f,
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
      const health = await fetch(`${ORIGIN}/health`);
      if (health.status !== 200 || await health.text() !== HEALTH_BODY) {
        throw new Error("formal smoke health response mismatch");
      }
      state.requestsPassed += 1;

      checkpoint("echo");
      const payload = echoPayload(round);
      const echo = await fetch(`${ORIGIN}/echo`, {
        method: "POST",
        body: streamedPayload(payload),
      });
      const echoed = new Uint8Array(await echo.arrayBuffer());
      if (echo.status !== 200 || !equalBytes(echoed, payload)) {
        throw new Error("formal smoke echo response mismatch");
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

// pocketjs_esp_guest_mount_factory() requires this legacy lifecycle slot.
// The formal smoke Host polls REPORT_GLOBAL and must not call frame().
Object.defineProperty(globalThis, "frame", {
  value: () => {
    state.frameCalls += 1;
  },
  configurable: false,
  enumerable: false,
  writable: false,
});

void run();
