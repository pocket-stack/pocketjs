import { fetch } from "@pocketjs/framework/net/http";

const REPORT_GLOBAL = "__pocketjsFormalNetworkTlsSmokeReportV1";
const CANCEL_GLOBAL = "__pocketjsFormalNetworkTlsSmokeCancelV1";
const ORIGIN = "https://pocketjs.test:8443";
const ROUNDS_TOTAL = 20;
const HEALTH_BODY =
  '{"peer":"mac","protocol":"pocketjs-independent-peer-v1","status":"ok"}';
const CHUNKED_BODY = "PocketJS-independent-peer";
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

function url(path: string): string {
  return `${ORIGIN}${path}`;
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function expectText(
  path: string,
  status: number,
  body: string,
  redirect: "follow" | "manual" | "error" = "manual",
  redirected = false,
  finalPath = path,
): Promise<void> {
  const response = await fetch(url(path), { redirect, tls: TLS_POLICY });
  const text = await response.text();
  assert(response.status === status, `status mismatch for ${path}`);
  assert(text === body, `body mismatch for ${path}`);
  assert(response.redirected === redirected, `redirect flag mismatch for ${path}`);
  assert(response.url === url(finalPath), `response URL mismatch for ${path}`);
}

async function expectNetworkError(
  path: string,
  expectedCodes: readonly string[],
  redirect: "follow" | "manual" | "error" = "manual",
): Promise<void> {
  try {
    const response = await fetch(url(path), { redirect, tls: TLS_POLICY });
    await response.arrayBuffer();
  } catch (error) {
    const candidate = typeof error === "object" && error !== null
      ? error as Record<string, unknown>
      : {};
    if (candidate.name !== "NetworkError") throw error;
    for (let index = 0; index < expectedCodes.length; index += 1) {
      if (candidate.code === expectedCodes[index]) return;
    }
    throw error;
  }
  throw new Error(`expected network error for ${path}`);
}

async function fixedEcho(round: number): Promise<void> {
  const payload = new Uint8Array([0x00, 0xff, 0x46, 0x49, 0x58, round, 0x7f]);
  const response = await fetch(url("/echo"), {
    method: "POST",
    body: payload,
    redirect: "manual",
    tls: TLS_POLICY,
  });
  const echoed = new Uint8Array(await response.arrayBuffer());
  assert(response.status === 200 && equalBytes(echoed, payload), "fixed echo mismatch");
}

async function* streamedPayload(payload: Uint8Array): AsyncIterable<Uint8Array> {
  yield payload.slice(0, 2);
  yield payload.slice(2, 6);
  yield payload.slice(6);
}

async function streamedEcho(round: number): Promise<void> {
  const payload = new Uint8Array([
    0x00, 0xff, 0x53, 0x54, 0x52, 0x45, 0x41, 0x4d, round, 0x7f,
  ]);
  const response = await fetch(url("/echo"), {
    method: "POST",
    body: streamedPayload(payload),
    redirect: "manual",
    tls: TLS_POLICY,
  });
  const echoed = new Uint8Array(await response.arrayBuffer());
  assert(response.status === 200 && equalBytes(echoed, payload), "streamed echo mismatch");
}

async function manualRedirect(): Promise<void> {
  const path = "/redirect?status=302&to=/health";
  const response = await fetch(url(path), { redirect: "manual", tls: TLS_POLICY });
  assert(response.status === 302, "manual redirect status mismatch");
  assert(response.redirected === false, "manual redirect followed unexpectedly");
  assert(response.url === url(path), "manual redirect URL changed");
  assert(response.headers.get("location") === "/health", "manual Location mismatch");
  assert(await response.text() === "redirect", "manual redirect body mismatch");
}

async function headHealth(): Promise<void> {
  const response = await fetch(url("/health"), {
    method: "HEAD",
    redirect: "manual",
    tls: TLS_POLICY,
  });
  const body = await response.arrayBuffer();
  assert(response.status === 200 && body.byteLength === 0, "HEAD body mismatch");
}

function retryToken(round: number): string {
  return `tls-conformance-${round}`;
}

async function retryOnce(round: number): Promise<void> {
  await expectNetworkError(
    `/retry-once?token=${retryToken(round)}`,
    Object.freeze(["connection_reset", "http_protocol_error"]),
  );
}

async function attemptCount(round: number): Promise<void> {
  const response = await fetch(url(`/attempts?token=${retryToken(round)}`), {
    redirect: "manual",
    tls: TLS_POLICY,
  });
  const body = await response.json() as { attempts?: unknown };
  assert(response.status === 200 && body.attempts === 1, "hidden retry detected");
}

async function operation(phase: "health" | "echo", run: () => Promise<void>): Promise<void> {
  checkpoint(phase);
  await run();
  state.requestsPassed += 1;
}

async function runRound(round: number): Promise<void> {
  const scenario = (round - 1) % 10;
  if (scenario === 0) {
    await operation("health", headHealth);
    await operation("echo", () => expectText(
      "/chunked?fragment_ms=1", 200, CHUNKED_BODY,
    ));
  } else if (scenario === 1) {
    await operation("health", () => expectText("/status/404", 404, "status-404"));
    await operation("echo", () => expectText("/status/503", 503, "status-503"));
  } else if (scenario === 2) {
    await operation("health", () => expectText(
      "/redirect?status=301&to=/health", 200, HEALTH_BODY, "follow", true,
      "/health",
    ));
    await operation("echo", () => expectText(
      "/redirect?status=308&to=/chunked?fragment_ms=1", 200, CHUNKED_BODY,
      "follow", true, "/chunked?fragment_ms=1",
    ));
  } else if (scenario === 3) {
    await operation("health", manualRedirect);
    await operation("echo", () => expectNetworkError(
      "/redirect?status=302&to=/health", Object.freeze(["http_protocol_error"]),
      "error",
    ));
  } else if (scenario === 4) {
    await operation("health", () => expectNetworkError(
      "/malformed/te-cl", Object.freeze(["http_protocol_error"]),
    ));
    await operation("echo", () => expectNetworkError(
      "/malformed/duplicate-content-length",
      Object.freeze(["http_protocol_error"]),
    ));
  } else if (scenario === 5) {
    await operation("health", () => expectNetworkError(
      "/malformed/obs-fold", Object.freeze(["http_protocol_error"]),
    ));
    await operation("echo", () => expectNetworkError(
      "/malformed/te-duplicate", Object.freeze(["http_protocol_error"]),
    ));
  } else if (scenario === 6) {
    await operation("health", () => expectNetworkError(
      "/malformed/te-combined", Object.freeze(["http_protocol_error"]),
    ));
    await operation("echo", () => expectNetworkError(
      "/malformed/te-unknown", Object.freeze(["http_protocol_error"]),
    ));
  } else if (scenario === 7) {
    await operation("health", () => expectNetworkError(
      "/malformed/trailer-forbidden", Object.freeze(["http_protocol_error"]),
    ));
    await operation("echo", () => expectNetworkError(
      "/malformed/chunk-size", Object.freeze(["http_protocol_error"]),
    ));
  } else if (scenario === 8) {
    await operation("health", () => fixedEcho(round));
    await operation("echo", () => streamedEcho(round));
  } else {
    await operation("health", () => retryOnce(round));
    await operation("echo", () => attemptCount(round));
  }
}

async function run(): Promise<void> {
  try {
    for (let round = 1; round <= ROUNDS_TOTAL; round += 1) {
      state.roundsStarted = round;
      await runRound(round);
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
  value: () => false,
  configurable: false,
  enumerable: false,
  writable: false,
});

Object.defineProperty(globalThis, "frame", {
  value: () => {
    state.frameCalls += 1;
  },
  configurable: false,
  enumerable: false,
  writable: false,
});

void run();
