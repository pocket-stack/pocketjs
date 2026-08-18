// GENERATED — do not edit; run `bun contracts/spec/network/generate.ts`.
// Source of truth: contracts/spec/network/definition.ts.

export const NETWORK_V1_ABI_MAJOR = 1 as const;
export const NETWORK_V1_ABI_MINOR = 1 as const;
export const NETWORK_V1_PLAN_HASH_BYTES = 32 as const;
export const NETWORK_V1_SEQUENCE_MAX = 9007199254740991 as const;
export const NETWORK_V1_LIMIT_ENTRY_MAX = 64 as const;
export const NETWORK_V1_LIMIT_NAME_MAX_BYTES = 64 as const;
export const NETWORK_V1_UINT32_MAX = 0xffff_ffff as const;
export const NETWORK_V1_ABSENT_ID = 0 as const;
export const NETWORK_V1_LIMIT_PROTOCOL_ANY = 0 as const;
export const NETWORK_V1_LIMIT_ROLE_ANY = 0 as const;

export const NetworkV1FeatureId = Object.freeze({
  /** HTTP client role. */
  HttpClient: 0x0100,
  /** TLS for the HTTP client role. */
  HttpClientTls: 0x0101,
  /** HTTP/2 client extension. */
  HttpClientH2: 0x0110,
  /** HTTP/3 client extension. */
  HttpClientH3: 0x0111,
  /** HTTP client content decoding. */
  HttpClientCompression: 0x0112,
  /** HTTP client custom CA extension. */
  HttpClientTlsCustomCa: 0x0118,
  /** HTTP client certificate authentication. */
  HttpClientTlsClientAuth: 0x0119,
  /** HTTP client custom ALPN. */
  HttpClientTlsAlpn: 0x011a,
  /** Required HTTP client TLS 1.3. */
  HttpClientTlsV13: 0x011b,
  /** Required HTTP client certificate revocation. */
  HttpClientTlsRevocation: 0x011c,
  /** HTTP server role. */
  HttpServer: 0x0120,
  /** TLS for the HTTP server role. */
  HttpServerTls: 0x0121,
  /** HTTP/2 server extension. */
  HttpServerH2: 0x0130,
  /** HTTP/3 server extension. */
  HttpServerH3: 0x0131,
  /** HTTP server content encoding. */
  HttpServerCompression: 0x0132,
  /** HTTP server custom CA extension. */
  HttpServerTlsCustomCa: 0x0138,
  /** HTTP server client-certificate authentication. */
  HttpServerTlsClientAuth: 0x0139,
  /** HTTP server custom ALPN. */
  HttpServerTlsAlpn: 0x013a,
  /** Required HTTP server TLS 1.3. */
  HttpServerTlsV13: 0x013b,
  /** Required HTTP server certificate revocation. */
  HttpServerTlsRevocation: 0x013c,
  /** WebSocket client role. */
  WebSocketClient: 0x0200,
  /** TLS for the WebSocket client role. */
  WebSocketClientTls: 0x0201,
  /** WebSocket client compression. */
  WebSocketClientCompression: 0x0210,
  /** WebSocket client custom CA extension. */
  WebSocketClientTlsCustomCa: 0x0218,
  /** WebSocket client certificate authentication. */
  WebSocketClientTlsClientAuth: 0x0219,
  /** WebSocket client custom ALPN. */
  WebSocketClientTlsAlpn: 0x021a,
  /** Required WebSocket client TLS 1.3. */
  WebSocketClientTlsV13: 0x021b,
  /** Required WebSocket client certificate revocation. */
  WebSocketClientTlsRevocation: 0x021c,
  /** WebSocket server role. */
  WebSocketServer: 0x0220,
  /** TLS for the WebSocket server role. */
  WebSocketServerTls: 0x0221,
  /** HTTP-to-WebSocket server handoff. */
  WebSocketServerUpgrade: 0x0222,
  /** WebSocket server compression. */
  WebSocketServerCompression: 0x0230,
  /** WebSocket server custom CA extension. */
  WebSocketServerTlsCustomCa: 0x0238,
  /** WebSocket server client-certificate authentication. */
  WebSocketServerTlsClientAuth: 0x0239,
  /** WebSocket server custom ALPN. */
  WebSocketServerTlsAlpn: 0x023a,
  /** Required WebSocket server TLS 1.3. */
  WebSocketServerTlsV13: 0x023b,
  /** Required WebSocket server certificate revocation. */
  WebSocketServerTlsRevocation: 0x023c,
  /** MQTT client role. */
  MqttClient: 0x0300,
  /** TLS for the MQTT client role. */
  MqttClientTls: 0x0301,
  /** MQTT 5 extension. */
  MqttClientV5: 0x0310,
  /** MQTT QoS 2 extension. */
  MqttClientQos2: 0x0311,
  /** MQTT client custom CA extension. */
  MqttClientTlsCustomCa: 0x0318,
  /** MQTT client certificate authentication. */
  MqttClientTlsClientAuth: 0x0319,
  /** MQTT client custom ALPN. */
  MqttClientTlsAlpn: 0x031a,
  /** Required MQTT client TLS 1.3. */
  MqttClientTlsV13: 0x031b,
  /** Required MQTT client certificate revocation. */
  MqttClientTlsRevocation: 0x031c,
  /** TCP client role. */
  TcpClient: 0x0400,
  /** TLS for the TCP client role. */
  TcpClientTls: 0x0401,
  /** TCP client IPv6 extension. */
  TcpClientIpv6: 0x0410,
  /** TCP client socket options. */
  TcpClientSocketOptions: 0x0411,
  /** TCP client custom CA extension. */
  TcpClientTlsCustomCa: 0x0418,
  /** TCP client certificate authentication. */
  TcpClientTlsClientAuth: 0x0419,
  /** TCP client custom ALPN. */
  TcpClientTlsAlpn: 0x041a,
  /** Required TCP client TLS 1.3. */
  TcpClientTlsV13: 0x041b,
  /** Required TCP client certificate revocation. */
  TcpClientTlsRevocation: 0x041c,
  /** TCP server role. */
  TcpServer: 0x0420,
  /** TLS for the TCP server role. */
  TcpServerTls: 0x0421,
  /** TCP server IPv6 extension. */
  TcpServerIpv6: 0x0430,
  /** TCP server socket options. */
  TcpServerSocketOptions: 0x0431,
  /** TCP server custom CA extension. */
  TcpServerTlsCustomCa: 0x0438,
  /** TCP server client-certificate authentication. */
  TcpServerTlsClientAuth: 0x0439,
  /** TCP server custom ALPN. */
  TcpServerTlsAlpn: 0x043a,
  /** Required TCP server TLS 1.3. */
  TcpServerTlsV13: 0x043b,
  /** Required TCP server certificate revocation. */
  TcpServerTlsRevocation: 0x043c,
  /** UDP socket role. */
  Udp: 0x0500,
  /** UDP IPv6 extension. */
  UdpIpv6: 0x0510,
  /** UDP broadcast extension. */
  UdpBroadcast: 0x0511,
  /** UDP multicast extension. */
  UdpMulticast: 0x0512,
  /** Browser HTTP adapter role. */
  BrowserHttpClient: 0x7000,
  /** Browser WebSocket adapter role. */
  BrowserWebSocketClient: 0x7010,
} as const);
export type NetworkV1FeatureId =
  (typeof NetworkV1FeatureId)[keyof typeof NetworkV1FeatureId];

export const NetworkV1CommandOpcode = Object.freeze({
  /** Compete for an operation's single terminal claim. */
  OperationCancel: 0x0001,
  /** Synchronously claim a delivered BufferLease. */
  BufferLeaseTake: 0x0002,
  /** Synchronously copy from a taken lease into borrowed output. */
  BufferLeaseReadInto: 0x0003,
  /** Release a taken BufferLease exactly once. */
  BufferLeaseRelease: 0x0004,
  /** Grant one bounded body-chunk credit. */
  BodyPull: 0x0010,
  /** Satisfy body credit with one non-empty chunk. */
  BodyChunk: 0x0011,
  /** End a body normally. */
  BodyEnd: 0x0012,
  /** End a body with a normalized error. */
  BodyError: 0x0013,
  /** Cancel the opposite body producer or consumer. */
  BodyCancel: 0x0014,
  /** Start an admitted HTTP client exchange. */
  HttpRequestStart: 0x0100,
} as const);
export type NetworkV1CommandOpcode =
  (typeof NetworkV1CommandOpcode)[keyof typeof NetworkV1CommandOpcode];

export const NetworkV1EventCode = Object.freeze({
  /** Request one bounded chunk from a Guest body producer. */
  BodyPull: 0x0010,
  /** Publish one native BufferLease-backed body chunk. */
  BodyChunk: 0x0011,
  /** Report normal body end. */
  BodyEnd: 0x0012,
  /** Report normalized body failure. */
  BodyError: 0x0013,
  /** Report cancellation of the opposite body endpoint. */
  BodyCancel: 0x0014,
  /** Publish validated HTTP response headers. */
  HttpResponseHeaders: 0x0100,
  /** Publish the HTTP operation's terminal error. */
  HttpRequestError: 0x0101,
} as const);
export type NetworkV1EventCode =
  (typeof NetworkV1EventCode)[keyof typeof NetworkV1EventCode];

export const NetworkV1ErrorCategory = Object.freeze({
  /** Runtime, lifecycle, admission, or capacity failure. */
  Runtime: 0x0001,
  /** Name resolution failure. */
  Resolver: 0x0002,
  /** Plain transport failure. */
  Transport: 0x0003,
  /** TLS policy or handshake failure. */
  Tls: 0x0004,
  /** Protocol framing or semantic failure. */
  Protocol: 0x0005,
} as const);
export type NetworkV1ErrorCategory =
  (typeof NetworkV1ErrorCategory)[keyof typeof NetworkV1ErrorCategory];

export const NetworkV1ErrorCode = Object.freeze({
  /** The application aborted the operation. */
  Aborted: 0x0100,
  /** A Core-owned monotonic deadline won. */
  TimedOut: 0x0101,
  /** The owning resource closed. */
  Closed: 0x0102,
  /** The operation is invalid in the current state. */
  InvalidState: 0x0103,
  /** A bounded in-flight slot is already occupied. */
  Busy: 0x0104,
  /** An admitted hard resource limit was reached. */
  ResourceLimit: 0x0105,
  /** The Build Plan does not contain the requested feature. */
  Unsupported: 0x0106,
  /** ResolvedNetworkPolicy rejected the operation. */
  PermissionDenied: 0x0107,
  /** The hostname does not exist. */
  DnsNotFound: 0x0200,
  /** Name resolution failed temporarily. */
  DnsTemporaryFailure: 0x0201,
  /** The resolver refused the query. */
  DnsRefused: 0x0202,
  /** The peer refused the connection. */
  ConnectionRefused: 0x0300,
  /** The peer reset the connection. */
  ConnectionReset: 0x0301,
  /** No route is available. */
  NetworkUnreachable: 0x0302,
  /** The local address is already in use. */
  AddressInUse: 0x0303,
  /** The write side is no longer usable. */
  BrokenPipe: 0x0304,
  /** Certificate chain, usage, or time validation failed. */
  TlsCertificateInvalid: 0x0400,
  /** The certificate does not match the authorized hostname. */
  TlsHostnameMismatch: 0x0401,
  /** The TLS handshake failed. */
  TlsHandshakeFailed: 0x0402,
  /** The requested TLS version cannot be negotiated. */
  TlsVersionUnsupported: 0x0403,
  /** The peer sent a TLS alert. */
  TlsAlert: 0x0404,
  /** HTTP framing or semantic validation failed. */
  HttpProtocolError: 0x0500,
  /** WebSocket framing or semantic validation failed. */
  WebSocketProtocolError: 0x0501,
  /** The broker rejected the MQTT protocol version. */
  MqttUnacceptableProtocolVersion: 0x0510,
  /** The broker rejected the client identifier. */
  MqttIdentifierRejected: 0x0511,
  /** The MQTT server is unavailable. */
  MqttServerUnavailable: 0x0512,
  /** The broker rejected supplied credentials. */
  MqttBadCredentials: 0x0513,
  /** The MQTT action is not authorized. */
  MqttNotAuthorized: 0x0514,
  /** MQTT framing or semantic validation failed. */
  MqttProtocolError: 0x0515,
  /** A protocol message exceeded its admitted bound. */
  MessageTooLarge: 0x0520,
  /** A redacted platform failure has no more specific mapping. */
  SystemError: 0x7fff,
} as const);
export type NetworkV1ErrorCode =
  (typeof NetworkV1ErrorCode)[keyof typeof NetworkV1ErrorCode];

export const NetworkV1DispatchStatus = Object.freeze({
  /** The command was accepted and any borrowed input was copied. */
  Accepted: 0x0001,
  /** The synchronous control command completed. */
  Completed: 0x0002,
  /** The command was refused before asynchronous work began. */
  Refused: 0x0003,
} as const);
export type NetworkV1DispatchStatus =
  (typeof NetworkV1DispatchStatus)[keyof typeof NetworkV1DispatchStatus];

export const NetworkV1CompletionPollStatus = Object.freeze({
  /** One completion was removed within the remaining byte budget. */
  Item: 0x0001,
  /** No immediately deliverable completion remains. */
  Drained: 0x0002,
  /** The next completion remains queued because its payload exceeds the remaining budget. */
  BudgetExhausted: 0x0003,
} as const);
export type NetworkV1CompletionPollStatus =
  (typeof NetworkV1CompletionPollStatus)[keyof typeof NetworkV1CompletionPollStatus];

export const NetworkV1BorrowedInputKind = Object.freeze({
  /** Custom CA bytes attached to a start command. */
  CustomCa: 0x0001,
  /** Body bytes attached to BODY_CHUNK. */
  BodyChunk: 0x0002,
} as const);
export type NetworkV1BorrowedInputKind =
  (typeof NetworkV1BorrowedInputKind)[keyof typeof NetworkV1BorrowedInputKind];

export const NetworkV1LimitProtocol = Object.freeze({
  /** HTTP limits and features. */
  Http: 0x0001,
  /** WebSocket limits and features. */
  WebSocket: 0x0002,
  /** MQTT limits and features. */
  Mqtt: 0x0003,
  /** TCP limits and features. */
  Tcp: 0x0004,
  /** UDP limits and features. */
  Udp: 0x0005,
} as const);
export type NetworkV1LimitProtocol =
  (typeof NetworkV1LimitProtocol)[keyof typeof NetworkV1LimitProtocol];

export const NetworkV1LimitRole = Object.freeze({
  /** Client-role limits and features. */
  Client: 0x0001,
  /** Server-role limits and features. */
  Server: 0x0002,
} as const);
export type NetworkV1LimitRole =
  (typeof NetworkV1LimitRole)[keyof typeof NetworkV1LimitRole];

export const NetworkV1HttpRedirectMode = Object.freeze({
  /** Follow redirects inside the HTTP Core. */
  Follow: 0x0001,
  /** Publish the redirect response without following. */
  Manual: 0x0002,
  /** Fail when a redirect response is received. */
  Error: 0x0003,
} as const);
export type NetworkV1HttpRedirectMode =
  (typeof NetworkV1HttpRedirectMode)[keyof typeof NetworkV1HttpRedirectMode];

export const NetworkV1TlsVersion = Object.freeze({
  /** TLS 1.2. */
  V12: 0x0102,
  /** TLS 1.3. */
  V13: 0x0103,
} as const);
export type NetworkV1TlsVersion =
  (typeof NetworkV1TlsVersion)[keyof typeof NetworkV1TlsVersion];

export const NetworkV1TlsVerification = Object.freeze({
  /** Verify trust, time, usage, and hostname. */
  Full: 0x0001,
  /** Development-only invalid-certificate mode. */
  DevelopmentInsecure: 0x0002,
} as const);
export type NetworkV1TlsVerification =
  (typeof NetworkV1TlsVerification)[keyof typeof NetworkV1TlsVerification];

export const NetworkV1TlsRevocation = Object.freeze({
  /** Use the selected TLS provider's revocation policy. */
  HostDefault: 0x0001,
  /** Require the admitted revocation feature. */
  Required: 0x0002,
} as const);
export type NetworkV1TlsRevocation =
  (typeof NetworkV1TlsRevocation)[keyof typeof NetworkV1TlsRevocation];

export const NetworkV1ClientCertificateMode = Object.freeze({
  /** Do not request a client certificate. */
  None: 0x0001,
  /** Accept a client certificate when supplied. */
  Optional: 0x0002,
  /** Require an admitted client certificate. */
  Required: 0x0003,
} as const);
export type NetworkV1ClientCertificateMode =
  (typeof NetworkV1ClientCertificateMode)[keyof typeof NetworkV1ClientCertificateMode];

export const NetworkV1ServiceTurnKind = Object.freeze({
  /** Deliver an ordinary NetworkServiceTurn. */
  Network: 0x0001,
  /** Deliver bounded network cancellation in ShutdownTurn. */
  Shutdown: 0x0002,
} as const);
export type NetworkV1ServiceTurnKind =
  (typeof NetworkV1ServiceTurnKind)[keyof typeof NetworkV1ServiceTurnKind];

export const NetworkV1ServiceTurnStatus = Object.freeze({
  /** No immediately deliverable network work remains. */
  Drained: 0x0001,
  /** Work remains and the Host must keep service ready. */
  MoreReady: 0x0002,
} as const);
export type NetworkV1ServiceTurnStatus =
  (typeof NetworkV1ServiceTurnStatus)[keyof typeof NetworkV1ServiceTurnStatus];

export const NetworkV1LeaseState = Object.freeze({
  /** The Core owns a lease referenced by a completion. */
  Queued: 0x0001,
  /** The owner-thread Guest Binding claimed the lease. */
  Taken: 0x0002,
  /** The lease returned to the native pool. */
  Released: 0x0003,
} as const);
export type NetworkV1LeaseState =
  (typeof NetworkV1LeaseState)[keyof typeof NetworkV1LeaseState];

export const NetworkV1LeaseAction = Object.freeze({
  /** Claim a queued lease. */
  Take: 0x0001,
  /** Release a taken lease. */
  Release: 0x0002,
  /** Native stale/cancel teardown releases an untaken lease. */
  Cleanup: 0x0003,
} as const);
export type NetworkV1LeaseAction =
  (typeof NetworkV1LeaseAction)[keyof typeof NetworkV1LeaseAction];

export const NETWORK_V1_FEATURE_IDS = Object.freeze([
  NetworkV1FeatureId.HttpClient,
  NetworkV1FeatureId.HttpClientTls,
  NetworkV1FeatureId.HttpClientH2,
  NetworkV1FeatureId.HttpClientH3,
  NetworkV1FeatureId.HttpClientCompression,
  NetworkV1FeatureId.HttpClientTlsCustomCa,
  NetworkV1FeatureId.HttpClientTlsClientAuth,
  NetworkV1FeatureId.HttpClientTlsAlpn,
  NetworkV1FeatureId.HttpClientTlsV13,
  NetworkV1FeatureId.HttpClientTlsRevocation,
  NetworkV1FeatureId.HttpServer,
  NetworkV1FeatureId.HttpServerTls,
  NetworkV1FeatureId.HttpServerH2,
  NetworkV1FeatureId.HttpServerH3,
  NetworkV1FeatureId.HttpServerCompression,
  NetworkV1FeatureId.HttpServerTlsCustomCa,
  NetworkV1FeatureId.HttpServerTlsClientAuth,
  NetworkV1FeatureId.HttpServerTlsAlpn,
  NetworkV1FeatureId.HttpServerTlsV13,
  NetworkV1FeatureId.HttpServerTlsRevocation,
  NetworkV1FeatureId.WebSocketClient,
  NetworkV1FeatureId.WebSocketClientTls,
  NetworkV1FeatureId.WebSocketClientCompression,
  NetworkV1FeatureId.WebSocketClientTlsCustomCa,
  NetworkV1FeatureId.WebSocketClientTlsClientAuth,
  NetworkV1FeatureId.WebSocketClientTlsAlpn,
  NetworkV1FeatureId.WebSocketClientTlsV13,
  NetworkV1FeatureId.WebSocketClientTlsRevocation,
  NetworkV1FeatureId.WebSocketServer,
  NetworkV1FeatureId.WebSocketServerTls,
  NetworkV1FeatureId.WebSocketServerUpgrade,
  NetworkV1FeatureId.WebSocketServerCompression,
  NetworkV1FeatureId.WebSocketServerTlsCustomCa,
  NetworkV1FeatureId.WebSocketServerTlsClientAuth,
  NetworkV1FeatureId.WebSocketServerTlsAlpn,
  NetworkV1FeatureId.WebSocketServerTlsV13,
  NetworkV1FeatureId.WebSocketServerTlsRevocation,
  NetworkV1FeatureId.MqttClient,
  NetworkV1FeatureId.MqttClientTls,
  NetworkV1FeatureId.MqttClientV5,
  NetworkV1FeatureId.MqttClientQos2,
  NetworkV1FeatureId.MqttClientTlsCustomCa,
  NetworkV1FeatureId.MqttClientTlsClientAuth,
  NetworkV1FeatureId.MqttClientTlsAlpn,
  NetworkV1FeatureId.MqttClientTlsV13,
  NetworkV1FeatureId.MqttClientTlsRevocation,
  NetworkV1FeatureId.TcpClient,
  NetworkV1FeatureId.TcpClientTls,
  NetworkV1FeatureId.TcpClientIpv6,
  NetworkV1FeatureId.TcpClientSocketOptions,
  NetworkV1FeatureId.TcpClientTlsCustomCa,
  NetworkV1FeatureId.TcpClientTlsClientAuth,
  NetworkV1FeatureId.TcpClientTlsAlpn,
  NetworkV1FeatureId.TcpClientTlsV13,
  NetworkV1FeatureId.TcpClientTlsRevocation,
  NetworkV1FeatureId.TcpServer,
  NetworkV1FeatureId.TcpServerTls,
  NetworkV1FeatureId.TcpServerIpv6,
  NetworkV1FeatureId.TcpServerSocketOptions,
  NetworkV1FeatureId.TcpServerTlsCustomCa,
  NetworkV1FeatureId.TcpServerTlsClientAuth,
  NetworkV1FeatureId.TcpServerTlsAlpn,
  NetworkV1FeatureId.TcpServerTlsV13,
  NetworkV1FeatureId.TcpServerTlsRevocation,
  NetworkV1FeatureId.Udp,
  NetworkV1FeatureId.UdpIpv6,
  NetworkV1FeatureId.UdpBroadcast,
  NetworkV1FeatureId.UdpMulticast,
  NetworkV1FeatureId.BrowserHttpClient,
  NetworkV1FeatureId.BrowserWebSocketClient,
] as const);

export const NETWORK_V1_COMMAND_OPCODES = Object.freeze([
  NetworkV1CommandOpcode.OperationCancel,
  NetworkV1CommandOpcode.BufferLeaseTake,
  NetworkV1CommandOpcode.BufferLeaseReadInto,
  NetworkV1CommandOpcode.BufferLeaseRelease,
  NetworkV1CommandOpcode.BodyPull,
  NetworkV1CommandOpcode.BodyChunk,
  NetworkV1CommandOpcode.BodyEnd,
  NetworkV1CommandOpcode.BodyError,
  NetworkV1CommandOpcode.BodyCancel,
  NetworkV1CommandOpcode.HttpRequestStart,
] as const);

export const NETWORK_V1_EVENT_CODES = Object.freeze([
  NetworkV1EventCode.BodyPull,
  NetworkV1EventCode.BodyChunk,
  NetworkV1EventCode.BodyEnd,
  NetworkV1EventCode.BodyError,
  NetworkV1EventCode.BodyCancel,
  NetworkV1EventCode.HttpResponseHeaders,
  NetworkV1EventCode.HttpRequestError,
] as const);

export const NETWORK_V1_ERROR_CODES = Object.freeze([
  NetworkV1ErrorCode.Aborted,
  NetworkV1ErrorCode.TimedOut,
  NetworkV1ErrorCode.Closed,
  NetworkV1ErrorCode.InvalidState,
  NetworkV1ErrorCode.Busy,
  NetworkV1ErrorCode.ResourceLimit,
  NetworkV1ErrorCode.Unsupported,
  NetworkV1ErrorCode.PermissionDenied,
  NetworkV1ErrorCode.DnsNotFound,
  NetworkV1ErrorCode.DnsTemporaryFailure,
  NetworkV1ErrorCode.DnsRefused,
  NetworkV1ErrorCode.ConnectionRefused,
  NetworkV1ErrorCode.ConnectionReset,
  NetworkV1ErrorCode.NetworkUnreachable,
  NetworkV1ErrorCode.AddressInUse,
  NetworkV1ErrorCode.BrokenPipe,
  NetworkV1ErrorCode.TlsCertificateInvalid,
  NetworkV1ErrorCode.TlsHostnameMismatch,
  NetworkV1ErrorCode.TlsHandshakeFailed,
  NetworkV1ErrorCode.TlsVersionUnsupported,
  NetworkV1ErrorCode.TlsAlert,
  NetworkV1ErrorCode.HttpProtocolError,
  NetworkV1ErrorCode.WebSocketProtocolError,
  NetworkV1ErrorCode.MqttUnacceptableProtocolVersion,
  NetworkV1ErrorCode.MqttIdentifierRejected,
  NetworkV1ErrorCode.MqttServerUnavailable,
  NetworkV1ErrorCode.MqttBadCredentials,
  NetworkV1ErrorCode.MqttNotAuthorized,
  NetworkV1ErrorCode.MqttProtocolError,
  NetworkV1ErrorCode.MessageTooLarge,
  NetworkV1ErrorCode.SystemError,
] as const);

export const NETWORK_V1_FEATURE_CAPABILITY_BY_ID = Object.freeze({
  [NetworkV1FeatureId.HttpClient]: "network.http.client",
  [NetworkV1FeatureId.HttpClientTls]: "network.http.client.tls",
  [NetworkV1FeatureId.HttpClientH2]: "network.http.client.h2",
  [NetworkV1FeatureId.HttpClientH3]: "network.http.client.h3",
  [NetworkV1FeatureId.HttpClientCompression]: "network.http.client.compression",
  [NetworkV1FeatureId.HttpClientTlsCustomCa]: "network.http.client.tls.custom-ca",
  [NetworkV1FeatureId.HttpClientTlsClientAuth]: "network.http.client.tls.client-auth",
  [NetworkV1FeatureId.HttpClientTlsAlpn]: "network.http.client.tls.alpn",
  [NetworkV1FeatureId.HttpClientTlsV13]: "network.http.client.tls.v1-3",
  [NetworkV1FeatureId.HttpClientTlsRevocation]: "network.http.client.tls.revocation",
  [NetworkV1FeatureId.HttpServer]: "network.http.server",
  [NetworkV1FeatureId.HttpServerTls]: "network.http.server.tls",
  [NetworkV1FeatureId.HttpServerH2]: "network.http.server.h2",
  [NetworkV1FeatureId.HttpServerH3]: "network.http.server.h3",
  [NetworkV1FeatureId.HttpServerCompression]: "network.http.server.compression",
  [NetworkV1FeatureId.HttpServerTlsCustomCa]: "network.http.server.tls.custom-ca",
  [NetworkV1FeatureId.HttpServerTlsClientAuth]: "network.http.server.tls.client-auth",
  [NetworkV1FeatureId.HttpServerTlsAlpn]: "network.http.server.tls.alpn",
  [NetworkV1FeatureId.HttpServerTlsV13]: "network.http.server.tls.v1-3",
  [NetworkV1FeatureId.HttpServerTlsRevocation]: "network.http.server.tls.revocation",
  [NetworkV1FeatureId.WebSocketClient]: "network.websocket.client",
  [NetworkV1FeatureId.WebSocketClientTls]: "network.websocket.client.tls",
  [NetworkV1FeatureId.WebSocketClientCompression]: "network.websocket.client.compression",
  [NetworkV1FeatureId.WebSocketClientTlsCustomCa]: "network.websocket.client.tls.custom-ca",
  [NetworkV1FeatureId.WebSocketClientTlsClientAuth]: "network.websocket.client.tls.client-auth",
  [NetworkV1FeatureId.WebSocketClientTlsAlpn]: "network.websocket.client.tls.alpn",
  [NetworkV1FeatureId.WebSocketClientTlsV13]: "network.websocket.client.tls.v1-3",
  [NetworkV1FeatureId.WebSocketClientTlsRevocation]: "network.websocket.client.tls.revocation",
  [NetworkV1FeatureId.WebSocketServer]: "network.websocket.server",
  [NetworkV1FeatureId.WebSocketServerTls]: "network.websocket.server.tls",
  [NetworkV1FeatureId.WebSocketServerUpgrade]: "network.websocket.server.upgrade",
  [NetworkV1FeatureId.WebSocketServerCompression]: "network.websocket.server.compression",
  [NetworkV1FeatureId.WebSocketServerTlsCustomCa]: "network.websocket.server.tls.custom-ca",
  [NetworkV1FeatureId.WebSocketServerTlsClientAuth]: "network.websocket.server.tls.client-auth",
  [NetworkV1FeatureId.WebSocketServerTlsAlpn]: "network.websocket.server.tls.alpn",
  [NetworkV1FeatureId.WebSocketServerTlsV13]: "network.websocket.server.tls.v1-3",
  [NetworkV1FeatureId.WebSocketServerTlsRevocation]: "network.websocket.server.tls.revocation",
  [NetworkV1FeatureId.MqttClient]: "network.mqtt.client",
  [NetworkV1FeatureId.MqttClientTls]: "network.mqtt.client.tls",
  [NetworkV1FeatureId.MqttClientV5]: "network.mqtt.client.v5",
  [NetworkV1FeatureId.MqttClientQos2]: "network.mqtt.client.qos2",
  [NetworkV1FeatureId.MqttClientTlsCustomCa]: "network.mqtt.client.tls.custom-ca",
  [NetworkV1FeatureId.MqttClientTlsClientAuth]: "network.mqtt.client.tls.client-auth",
  [NetworkV1FeatureId.MqttClientTlsAlpn]: "network.mqtt.client.tls.alpn",
  [NetworkV1FeatureId.MqttClientTlsV13]: "network.mqtt.client.tls.v1-3",
  [NetworkV1FeatureId.MqttClientTlsRevocation]: "network.mqtt.client.tls.revocation",
  [NetworkV1FeatureId.TcpClient]: "network.tcp.client",
  [NetworkV1FeatureId.TcpClientTls]: "network.tcp.client.tls",
  [NetworkV1FeatureId.TcpClientIpv6]: "network.tcp.client.ipv6",
  [NetworkV1FeatureId.TcpClientSocketOptions]: "network.tcp.client.socket-options",
  [NetworkV1FeatureId.TcpClientTlsCustomCa]: "network.tcp.client.tls.custom-ca",
  [NetworkV1FeatureId.TcpClientTlsClientAuth]: "network.tcp.client.tls.client-auth",
  [NetworkV1FeatureId.TcpClientTlsAlpn]: "network.tcp.client.tls.alpn",
  [NetworkV1FeatureId.TcpClientTlsV13]: "network.tcp.client.tls.v1-3",
  [NetworkV1FeatureId.TcpClientTlsRevocation]: "network.tcp.client.tls.revocation",
  [NetworkV1FeatureId.TcpServer]: "network.tcp.server",
  [NetworkV1FeatureId.TcpServerTls]: "network.tcp.server.tls",
  [NetworkV1FeatureId.TcpServerIpv6]: "network.tcp.server.ipv6",
  [NetworkV1FeatureId.TcpServerSocketOptions]: "network.tcp.server.socket-options",
  [NetworkV1FeatureId.TcpServerTlsCustomCa]: "network.tcp.server.tls.custom-ca",
  [NetworkV1FeatureId.TcpServerTlsClientAuth]: "network.tcp.server.tls.client-auth",
  [NetworkV1FeatureId.TcpServerTlsAlpn]: "network.tcp.server.tls.alpn",
  [NetworkV1FeatureId.TcpServerTlsV13]: "network.tcp.server.tls.v1-3",
  [NetworkV1FeatureId.TcpServerTlsRevocation]: "network.tcp.server.tls.revocation",
  [NetworkV1FeatureId.Udp]: "network.udp",
  [NetworkV1FeatureId.UdpIpv6]: "network.udp.ipv6",
  [NetworkV1FeatureId.UdpBroadcast]: "network.udp.broadcast",
  [NetworkV1FeatureId.UdpMulticast]: "network.udp.multicast",
  [NetworkV1FeatureId.BrowserHttpClient]: "network.browser.http.client",
  [NetworkV1FeatureId.BrowserWebSocketClient]: "network.browser.websocket.client",
} as const);
export const NETWORK_V1_FEATURE_ID_BY_CAPABILITY = Object.freeze({
  "network.http.client": NetworkV1FeatureId.HttpClient,
  "network.http.client.tls": NetworkV1FeatureId.HttpClientTls,
  "network.http.client.h2": NetworkV1FeatureId.HttpClientH2,
  "network.http.client.h3": NetworkV1FeatureId.HttpClientH3,
  "network.http.client.compression": NetworkV1FeatureId.HttpClientCompression,
  "network.http.client.tls.custom-ca": NetworkV1FeatureId.HttpClientTlsCustomCa,
  "network.http.client.tls.client-auth": NetworkV1FeatureId.HttpClientTlsClientAuth,
  "network.http.client.tls.alpn": NetworkV1FeatureId.HttpClientTlsAlpn,
  "network.http.client.tls.v1-3": NetworkV1FeatureId.HttpClientTlsV13,
  "network.http.client.tls.revocation": NetworkV1FeatureId.HttpClientTlsRevocation,
  "network.http.server": NetworkV1FeatureId.HttpServer,
  "network.http.server.tls": NetworkV1FeatureId.HttpServerTls,
  "network.http.server.h2": NetworkV1FeatureId.HttpServerH2,
  "network.http.server.h3": NetworkV1FeatureId.HttpServerH3,
  "network.http.server.compression": NetworkV1FeatureId.HttpServerCompression,
  "network.http.server.tls.custom-ca": NetworkV1FeatureId.HttpServerTlsCustomCa,
  "network.http.server.tls.client-auth": NetworkV1FeatureId.HttpServerTlsClientAuth,
  "network.http.server.tls.alpn": NetworkV1FeatureId.HttpServerTlsAlpn,
  "network.http.server.tls.v1-3": NetworkV1FeatureId.HttpServerTlsV13,
  "network.http.server.tls.revocation": NetworkV1FeatureId.HttpServerTlsRevocation,
  "network.websocket.client": NetworkV1FeatureId.WebSocketClient,
  "network.websocket.client.tls": NetworkV1FeatureId.WebSocketClientTls,
  "network.websocket.client.compression": NetworkV1FeatureId.WebSocketClientCompression,
  "network.websocket.client.tls.custom-ca": NetworkV1FeatureId.WebSocketClientTlsCustomCa,
  "network.websocket.client.tls.client-auth": NetworkV1FeatureId.WebSocketClientTlsClientAuth,
  "network.websocket.client.tls.alpn": NetworkV1FeatureId.WebSocketClientTlsAlpn,
  "network.websocket.client.tls.v1-3": NetworkV1FeatureId.WebSocketClientTlsV13,
  "network.websocket.client.tls.revocation": NetworkV1FeatureId.WebSocketClientTlsRevocation,
  "network.websocket.server": NetworkV1FeatureId.WebSocketServer,
  "network.websocket.server.tls": NetworkV1FeatureId.WebSocketServerTls,
  "network.websocket.server.upgrade": NetworkV1FeatureId.WebSocketServerUpgrade,
  "network.websocket.server.compression": NetworkV1FeatureId.WebSocketServerCompression,
  "network.websocket.server.tls.custom-ca": NetworkV1FeatureId.WebSocketServerTlsCustomCa,
  "network.websocket.server.tls.client-auth": NetworkV1FeatureId.WebSocketServerTlsClientAuth,
  "network.websocket.server.tls.alpn": NetworkV1FeatureId.WebSocketServerTlsAlpn,
  "network.websocket.server.tls.v1-3": NetworkV1FeatureId.WebSocketServerTlsV13,
  "network.websocket.server.tls.revocation": NetworkV1FeatureId.WebSocketServerTlsRevocation,
  "network.mqtt.client": NetworkV1FeatureId.MqttClient,
  "network.mqtt.client.tls": NetworkV1FeatureId.MqttClientTls,
  "network.mqtt.client.v5": NetworkV1FeatureId.MqttClientV5,
  "network.mqtt.client.qos2": NetworkV1FeatureId.MqttClientQos2,
  "network.mqtt.client.tls.custom-ca": NetworkV1FeatureId.MqttClientTlsCustomCa,
  "network.mqtt.client.tls.client-auth": NetworkV1FeatureId.MqttClientTlsClientAuth,
  "network.mqtt.client.tls.alpn": NetworkV1FeatureId.MqttClientTlsAlpn,
  "network.mqtt.client.tls.v1-3": NetworkV1FeatureId.MqttClientTlsV13,
  "network.mqtt.client.tls.revocation": NetworkV1FeatureId.MqttClientTlsRevocation,
  "network.tcp.client": NetworkV1FeatureId.TcpClient,
  "network.tcp.client.tls": NetworkV1FeatureId.TcpClientTls,
  "network.tcp.client.ipv6": NetworkV1FeatureId.TcpClientIpv6,
  "network.tcp.client.socket-options": NetworkV1FeatureId.TcpClientSocketOptions,
  "network.tcp.client.tls.custom-ca": NetworkV1FeatureId.TcpClientTlsCustomCa,
  "network.tcp.client.tls.client-auth": NetworkV1FeatureId.TcpClientTlsClientAuth,
  "network.tcp.client.tls.alpn": NetworkV1FeatureId.TcpClientTlsAlpn,
  "network.tcp.client.tls.v1-3": NetworkV1FeatureId.TcpClientTlsV13,
  "network.tcp.client.tls.revocation": NetworkV1FeatureId.TcpClientTlsRevocation,
  "network.tcp.server": NetworkV1FeatureId.TcpServer,
  "network.tcp.server.tls": NetworkV1FeatureId.TcpServerTls,
  "network.tcp.server.ipv6": NetworkV1FeatureId.TcpServerIpv6,
  "network.tcp.server.socket-options": NetworkV1FeatureId.TcpServerSocketOptions,
  "network.tcp.server.tls.custom-ca": NetworkV1FeatureId.TcpServerTlsCustomCa,
  "network.tcp.server.tls.client-auth": NetworkV1FeatureId.TcpServerTlsClientAuth,
  "network.tcp.server.tls.alpn": NetworkV1FeatureId.TcpServerTlsAlpn,
  "network.tcp.server.tls.v1-3": NetworkV1FeatureId.TcpServerTlsV13,
  "network.tcp.server.tls.revocation": NetworkV1FeatureId.TcpServerTlsRevocation,
  "network.udp": NetworkV1FeatureId.Udp,
  "network.udp.ipv6": NetworkV1FeatureId.UdpIpv6,
  "network.udp.broadcast": NetworkV1FeatureId.UdpBroadcast,
  "network.udp.multicast": NetworkV1FeatureId.UdpMulticast,
  "network.browser.http.client": NetworkV1FeatureId.BrowserHttpClient,
  "network.browser.websocket.client": NetworkV1FeatureId.BrowserWebSocketClient,
} as const);

export const NETWORK_V1_ERROR_CATEGORY_NAME_BY_ID = Object.freeze({
  [NetworkV1ErrorCategory.Runtime]: "runtime",
  [NetworkV1ErrorCategory.Resolver]: "resolver",
  [NetworkV1ErrorCategory.Transport]: "transport",
  [NetworkV1ErrorCategory.Tls]: "tls",
  [NetworkV1ErrorCategory.Protocol]: "protocol",
} as const);
export const NETWORK_V1_ERROR_CATEGORY_ID_BY_NAME = Object.freeze({
  "runtime": NetworkV1ErrorCategory.Runtime,
  "resolver": NetworkV1ErrorCategory.Resolver,
  "transport": NetworkV1ErrorCategory.Transport,
  "tls": NetworkV1ErrorCategory.Tls,
  "protocol": NetworkV1ErrorCategory.Protocol,
} as const);

export const NETWORK_V1_ERROR_NAME_BY_ID = Object.freeze({
  [NetworkV1ErrorCode.Aborted]: "aborted",
  [NetworkV1ErrorCode.TimedOut]: "timed_out",
  [NetworkV1ErrorCode.Closed]: "closed",
  [NetworkV1ErrorCode.InvalidState]: "invalid_state",
  [NetworkV1ErrorCode.Busy]: "busy",
  [NetworkV1ErrorCode.ResourceLimit]: "resource_limit",
  [NetworkV1ErrorCode.Unsupported]: "unsupported",
  [NetworkV1ErrorCode.PermissionDenied]: "permission_denied",
  [NetworkV1ErrorCode.DnsNotFound]: "dns_not_found",
  [NetworkV1ErrorCode.DnsTemporaryFailure]: "dns_temporary_failure",
  [NetworkV1ErrorCode.DnsRefused]: "dns_refused",
  [NetworkV1ErrorCode.ConnectionRefused]: "connection_refused",
  [NetworkV1ErrorCode.ConnectionReset]: "connection_reset",
  [NetworkV1ErrorCode.NetworkUnreachable]: "network_unreachable",
  [NetworkV1ErrorCode.AddressInUse]: "address_in_use",
  [NetworkV1ErrorCode.BrokenPipe]: "broken_pipe",
  [NetworkV1ErrorCode.TlsCertificateInvalid]: "tls_certificate_invalid",
  [NetworkV1ErrorCode.TlsHostnameMismatch]: "tls_hostname_mismatch",
  [NetworkV1ErrorCode.TlsHandshakeFailed]: "tls_handshake_failed",
  [NetworkV1ErrorCode.TlsVersionUnsupported]: "tls_version_unsupported",
  [NetworkV1ErrorCode.TlsAlert]: "tls_alert",
  [NetworkV1ErrorCode.HttpProtocolError]: "http_protocol_error",
  [NetworkV1ErrorCode.WebSocketProtocolError]: "websocket_protocol_error",
  [NetworkV1ErrorCode.MqttUnacceptableProtocolVersion]: "mqtt_unacceptable_protocol_version",
  [NetworkV1ErrorCode.MqttIdentifierRejected]: "mqtt_identifier_rejected",
  [NetworkV1ErrorCode.MqttServerUnavailable]: "mqtt_server_unavailable",
  [NetworkV1ErrorCode.MqttBadCredentials]: "mqtt_bad_credentials",
  [NetworkV1ErrorCode.MqttNotAuthorized]: "mqtt_not_authorized",
  [NetworkV1ErrorCode.MqttProtocolError]: "mqtt_protocol_error",
  [NetworkV1ErrorCode.MessageTooLarge]: "message_too_large",
  [NetworkV1ErrorCode.SystemError]: "system_error",
} as const);
export const NETWORK_V1_ERROR_ID_BY_NAME = Object.freeze({
  "aborted": NetworkV1ErrorCode.Aborted,
  "timed_out": NetworkV1ErrorCode.TimedOut,
  "closed": NetworkV1ErrorCode.Closed,
  "invalid_state": NetworkV1ErrorCode.InvalidState,
  "busy": NetworkV1ErrorCode.Busy,
  "resource_limit": NetworkV1ErrorCode.ResourceLimit,
  "unsupported": NetworkV1ErrorCode.Unsupported,
  "permission_denied": NetworkV1ErrorCode.PermissionDenied,
  "dns_not_found": NetworkV1ErrorCode.DnsNotFound,
  "dns_temporary_failure": NetworkV1ErrorCode.DnsTemporaryFailure,
  "dns_refused": NetworkV1ErrorCode.DnsRefused,
  "connection_refused": NetworkV1ErrorCode.ConnectionRefused,
  "connection_reset": NetworkV1ErrorCode.ConnectionReset,
  "network_unreachable": NetworkV1ErrorCode.NetworkUnreachable,
  "address_in_use": NetworkV1ErrorCode.AddressInUse,
  "broken_pipe": NetworkV1ErrorCode.BrokenPipe,
  "tls_certificate_invalid": NetworkV1ErrorCode.TlsCertificateInvalid,
  "tls_hostname_mismatch": NetworkV1ErrorCode.TlsHostnameMismatch,
  "tls_handshake_failed": NetworkV1ErrorCode.TlsHandshakeFailed,
  "tls_version_unsupported": NetworkV1ErrorCode.TlsVersionUnsupported,
  "tls_alert": NetworkV1ErrorCode.TlsAlert,
  "http_protocol_error": NetworkV1ErrorCode.HttpProtocolError,
  "websocket_protocol_error": NetworkV1ErrorCode.WebSocketProtocolError,
  "mqtt_unacceptable_protocol_version": NetworkV1ErrorCode.MqttUnacceptableProtocolVersion,
  "mqtt_identifier_rejected": NetworkV1ErrorCode.MqttIdentifierRejected,
  "mqtt_server_unavailable": NetworkV1ErrorCode.MqttServerUnavailable,
  "mqtt_bad_credentials": NetworkV1ErrorCode.MqttBadCredentials,
  "mqtt_not_authorized": NetworkV1ErrorCode.MqttNotAuthorized,
  "mqtt_protocol_error": NetworkV1ErrorCode.MqttProtocolError,
  "message_too_large": NetworkV1ErrorCode.MessageTooLarge,
  "system_error": NetworkV1ErrorCode.SystemError,
} as const);
