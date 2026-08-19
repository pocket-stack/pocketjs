// GENERATED — do not edit; run `bun contracts/spec/gen-web.ts`.
// Plain-ESM mirror of contracts/spec/net.ts for the browser dev host
// (hosts/web/net.js). tests/contract.ts byte-compares this file.
export const NET_SPEC_MAJOR = 2;
export const NET_SPEC_MINOR = 0;
export const NET_MAX_INFLIGHT = 8;
export const NET_MAX_REQUEST_BYTES = 262144;
export const NET_DEFAULT_QUEUE_BYTES = 32768;
export const NET_MAX_QUEUE_BYTES = 262144;
export const NET_DEFAULT_AGGREGATE_BYTES = 1048576;
export const NET_MAX_AGGREGATE_BYTES = 8388608;
export const NET_MAX_EVENTS_PER_TICK = 128;
export const NET_MAX_TICK_BYTES = 262144;
export const NET_MAX_HEADERS = 64;
export const NET_MAX_HEADER_BYTES = 16384;
export const NET_DEFAULT_TIMEOUT_MS = 30000;
export const NET_MAX_TIMEOUT_MS = 120000;
export const NET_MAX_REDIRECTS = 5;
export const NET_TLS_MIN_VERSION = "1.2";
export const NET_METHODS_FORBIDDEN = ["CONNECT","TRACE","TRACK"];
export const HTTP_CORE_OWNED_REQUEST_HEADERS = ["host","connection","content-length","transfer-encoding","trailer","te","upgrade","keep-alive","expect","proxy-connection"];
export const HTTP_NULL_BODY_STATUS = [101,103,204,205,304];
export const HTTP_REDIRECT_STATUS = [301,302,303,307,308];
export const NET_EVENT = {"headers":"headers","readable":"readable","end":"end","error":"error","drain":"drain"};
export const NET_ERROR = {"invalidRequest":"invalid_request","invalidState":"invalid_state","unsupported":"unsupported","permissionDenied":"permission_denied","busy":"busy","resourceLimit":"resource_limit","dns":"dns","connect":"connect","addressInUse":"address_in_use","closed":"closed","timeout":"timeout","tlsCertificateInvalid":"tls_certificate_invalid","tlsHostnameMismatch":"tls_hostname_mismatch","tlsHandshakeFailed":"tls_handshake_failed","tlsClockUntrusted":"tls_clock_untrusted","redirect":"redirect","responseTooLarge":"response_too_large","protocol":"protocol","websocketHandshakeFailed":"websocket_handshake_failed","websocketProtocolError":"websocket_protocol_error","messageTooLarge":"message_too_large","cancelled":"cancelled","other":"other","unavailable":"unavailable"};
