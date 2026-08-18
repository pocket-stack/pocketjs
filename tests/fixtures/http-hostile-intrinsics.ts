import {
  Headers,
  NetworkError,
  Request,
  fetch,
} from "../../framework/src/net/http.ts";
import {
  installHttpClientBindingForTesting,
  NETWORK_V1_ABI_MAJOR,
  NETWORK_V1_ABI_MINOR,
} from "../../framework/src/net/http-binding.ts";

let starts = 0;
const featureSet = Object.freeze(["network.http.client"]);
const cleanup = installHttpClientBindingForTesting(Object.freeze({
  abiMajor: NETWORK_V1_ABI_MAJOR,
  abiMinor: NETWORK_V1_ABI_MINOR,
  featureSet,
  httpClientLimits: Object.freeze({
    values: Object.freeze([
      Object.freeze({
        name: "http.bufferedBodyBytes",
        default: 8 * 1024 * 1024,
        hard: 8 * 1024 * 1024,
        minimum: 1,
      }),
      Object.freeze({
        name: "http.headerBytes",
        default: 64 * 1024,
        hard: 64 * 1024,
        minimum: 1,
      }),
      Object.freeze({
        name: "http.maxBodyChunkBytes",
        default: 64 * 1024,
        hard: 64 * 1024,
        minimum: 1,
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
        hard: 512 * 1024,
        minimum: 1,
      }),
    ]),
    features: featureSet,
  }),
  start() {
    starts++;
    throw new Error("native start must remain unreachable");
  },
}));

String.prototype.startsWith = () => false;
String.prototype.includes = () => false;
String.prototype.charCodeAt = () => 0;
String.prototype.toUpperCase = () => "GET";
String.prototype.toLowerCase = () => "visible";
Array.prototype.includes = () => true;
Array.prototype.join = () => "poisoned";
Array.prototype.push = () => { throw new Error("poisoned push"); };
Array.prototype.sort = () => { throw new Error("poisoned sort"); };
Array.prototype.splice = () => { throw new Error("poisoned splice"); };
Set.prototype.has = () => false;
RegExp.prototype.test = () => true;
Object.keys = (() => []) as never;
Number.isSafeInteger = () => true;

const request = new Request("http://example.test/", {
  headers: [
    ["proxy-authorization", "secret"],
    ["sec-pocket", "secret"],
    ["x-visible", "yes"],
  ],
});
if (request.headers.has("proxy-authorization") || request.headers.has("sec-pocket")) {
  throw new Error("forbidden request header survived intrinsic poisoning");
}
if (request.headers.get("x-visible") !== "yes") {
  throw new Error("ordinary request header was not retained");
}

let trackRejected = false;
try {
  new Request("http://example.test/", { method: "TRACK" });
} catch (error) {
  trackRejected = error instanceof TypeError;
}
if (!trackRejected) throw new Error("TRACK survived intrinsic poisoning");

try {
  await fetch("https://example.test/");
  throw new Error("HTTPS without TLS admission unexpectedly succeeded");
} catch (error) {
  if (!(error instanceof NetworkError) || error.code !== "unsupported") throw error;
}
if (starts !== 0) throw new Error("TLS feature preflight reached native start");

cleanup();
void Headers;
