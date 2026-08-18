/**
 * Single source of truth for the PocketJS private network ABI v1.
 *
 * Numeric identifiers are append-only within an ABI major. Never renumber,
 * remove, or reuse an entry. New entries require an ABI minor increment.
 * Run `bun contracts/spec/network/generate.ts` after changing this file.
 */

export interface NetworkV1NumericEntry {
  readonly name: string;
  readonly cName: string;
  readonly value: number;
  readonly description: string;
}

export interface NetworkV1FeatureEntry extends NetworkV1NumericEntry {
  readonly capability: string;
}

export interface NetworkV1NamedEntry extends NetworkV1NumericEntry {
  readonly wireName: string;
}

export const NETWORK_V1_DEFINITION = {
  abi: {
    major: 1,
    minor: 1,
    planHashBytes: 32,
    sequenceMax: Number.MAX_SAFE_INTEGER,
    limitEntryMax: 64,
    limitNameMaxBytes: 64,
  },

  /**
   * The exact native/Browser network projection of ResolvedBuildPlan.features.
   * Feature ids are sparse so protocol and role additions do not renumber an
   * already shipped feature.
   */
  features: [
    { name: "HttpClient", cName: "HTTP_CLIENT", value: 0x0100, capability: "network.http.client", description: "HTTP client role" },
    { name: "HttpClientTls", cName: "HTTP_CLIENT_TLS", value: 0x0101, capability: "network.http.client.tls", description: "TLS for the HTTP client role" },
    { name: "HttpClientH2", cName: "HTTP_CLIENT_H2", value: 0x0110, capability: "network.http.client.h2", description: "HTTP/2 client extension" },
    { name: "HttpClientH3", cName: "HTTP_CLIENT_H3", value: 0x0111, capability: "network.http.client.h3", description: "HTTP/3 client extension" },
    { name: "HttpClientCompression", cName: "HTTP_CLIENT_COMPRESSION", value: 0x0112, capability: "network.http.client.compression", description: "HTTP client content decoding" },
    { name: "HttpClientTlsCustomCa", cName: "HTTP_CLIENT_TLS_CUSTOM_CA", value: 0x0118, capability: "network.http.client.tls.custom-ca", description: "HTTP client custom CA extension" },
    { name: "HttpClientTlsClientAuth", cName: "HTTP_CLIENT_TLS_CLIENT_AUTH", value: 0x0119, capability: "network.http.client.tls.client-auth", description: "HTTP client certificate authentication" },
    { name: "HttpClientTlsAlpn", cName: "HTTP_CLIENT_TLS_ALPN", value: 0x011a, capability: "network.http.client.tls.alpn", description: "HTTP client custom ALPN" },
    { name: "HttpClientTlsV13", cName: "HTTP_CLIENT_TLS_V1_3", value: 0x011b, capability: "network.http.client.tls.v1-3", description: "Required HTTP client TLS 1.3" },
    { name: "HttpClientTlsRevocation", cName: "HTTP_CLIENT_TLS_REVOCATION", value: 0x011c, capability: "network.http.client.tls.revocation", description: "Required HTTP client certificate revocation" },

    { name: "HttpServer", cName: "HTTP_SERVER", value: 0x0120, capability: "network.http.server", description: "HTTP server role" },
    { name: "HttpServerTls", cName: "HTTP_SERVER_TLS", value: 0x0121, capability: "network.http.server.tls", description: "TLS for the HTTP server role" },
    { name: "HttpServerH2", cName: "HTTP_SERVER_H2", value: 0x0130, capability: "network.http.server.h2", description: "HTTP/2 server extension" },
    { name: "HttpServerH3", cName: "HTTP_SERVER_H3", value: 0x0131, capability: "network.http.server.h3", description: "HTTP/3 server extension" },
    { name: "HttpServerCompression", cName: "HTTP_SERVER_COMPRESSION", value: 0x0132, capability: "network.http.server.compression", description: "HTTP server content encoding" },
    { name: "HttpServerTlsCustomCa", cName: "HTTP_SERVER_TLS_CUSTOM_CA", value: 0x0138, capability: "network.http.server.tls.custom-ca", description: "HTTP server custom CA extension" },
    { name: "HttpServerTlsClientAuth", cName: "HTTP_SERVER_TLS_CLIENT_AUTH", value: 0x0139, capability: "network.http.server.tls.client-auth", description: "HTTP server client-certificate authentication" },
    { name: "HttpServerTlsAlpn", cName: "HTTP_SERVER_TLS_ALPN", value: 0x013a, capability: "network.http.server.tls.alpn", description: "HTTP server custom ALPN" },
    { name: "HttpServerTlsV13", cName: "HTTP_SERVER_TLS_V1_3", value: 0x013b, capability: "network.http.server.tls.v1-3", description: "Required HTTP server TLS 1.3" },
    { name: "HttpServerTlsRevocation", cName: "HTTP_SERVER_TLS_REVOCATION", value: 0x013c, capability: "network.http.server.tls.revocation", description: "Required HTTP server certificate revocation" },

    { name: "WebSocketClient", cName: "WEBSOCKET_CLIENT", value: 0x0200, capability: "network.websocket.client", description: "WebSocket client role" },
    { name: "WebSocketClientTls", cName: "WEBSOCKET_CLIENT_TLS", value: 0x0201, capability: "network.websocket.client.tls", description: "TLS for the WebSocket client role" },
    { name: "WebSocketClientCompression", cName: "WEBSOCKET_CLIENT_COMPRESSION", value: 0x0210, capability: "network.websocket.client.compression", description: "WebSocket client compression" },
    { name: "WebSocketClientTlsCustomCa", cName: "WEBSOCKET_CLIENT_TLS_CUSTOM_CA", value: 0x0218, capability: "network.websocket.client.tls.custom-ca", description: "WebSocket client custom CA extension" },
    { name: "WebSocketClientTlsClientAuth", cName: "WEBSOCKET_CLIENT_TLS_CLIENT_AUTH", value: 0x0219, capability: "network.websocket.client.tls.client-auth", description: "WebSocket client certificate authentication" },
    { name: "WebSocketClientTlsAlpn", cName: "WEBSOCKET_CLIENT_TLS_ALPN", value: 0x021a, capability: "network.websocket.client.tls.alpn", description: "WebSocket client custom ALPN" },
    { name: "WebSocketClientTlsV13", cName: "WEBSOCKET_CLIENT_TLS_V1_3", value: 0x021b, capability: "network.websocket.client.tls.v1-3", description: "Required WebSocket client TLS 1.3" },
    { name: "WebSocketClientTlsRevocation", cName: "WEBSOCKET_CLIENT_TLS_REVOCATION", value: 0x021c, capability: "network.websocket.client.tls.revocation", description: "Required WebSocket client certificate revocation" },

    { name: "WebSocketServer", cName: "WEBSOCKET_SERVER", value: 0x0220, capability: "network.websocket.server", description: "WebSocket server role" },
    { name: "WebSocketServerTls", cName: "WEBSOCKET_SERVER_TLS", value: 0x0221, capability: "network.websocket.server.tls", description: "TLS for the WebSocket server role" },
    { name: "WebSocketServerUpgrade", cName: "WEBSOCKET_SERVER_UPGRADE", value: 0x0222, capability: "network.websocket.server.upgrade", description: "HTTP-to-WebSocket server handoff" },
    { name: "WebSocketServerCompression", cName: "WEBSOCKET_SERVER_COMPRESSION", value: 0x0230, capability: "network.websocket.server.compression", description: "WebSocket server compression" },
    { name: "WebSocketServerTlsCustomCa", cName: "WEBSOCKET_SERVER_TLS_CUSTOM_CA", value: 0x0238, capability: "network.websocket.server.tls.custom-ca", description: "WebSocket server custom CA extension" },
    { name: "WebSocketServerTlsClientAuth", cName: "WEBSOCKET_SERVER_TLS_CLIENT_AUTH", value: 0x0239, capability: "network.websocket.server.tls.client-auth", description: "WebSocket server client-certificate authentication" },
    { name: "WebSocketServerTlsAlpn", cName: "WEBSOCKET_SERVER_TLS_ALPN", value: 0x023a, capability: "network.websocket.server.tls.alpn", description: "WebSocket server custom ALPN" },
    { name: "WebSocketServerTlsV13", cName: "WEBSOCKET_SERVER_TLS_V1_3", value: 0x023b, capability: "network.websocket.server.tls.v1-3", description: "Required WebSocket server TLS 1.3" },
    { name: "WebSocketServerTlsRevocation", cName: "WEBSOCKET_SERVER_TLS_REVOCATION", value: 0x023c, capability: "network.websocket.server.tls.revocation", description: "Required WebSocket server certificate revocation" },

    { name: "MqttClient", cName: "MQTT_CLIENT", value: 0x0300, capability: "network.mqtt.client", description: "MQTT client role" },
    { name: "MqttClientTls", cName: "MQTT_CLIENT_TLS", value: 0x0301, capability: "network.mqtt.client.tls", description: "TLS for the MQTT client role" },
    { name: "MqttClientV5", cName: "MQTT_CLIENT_V5", value: 0x0310, capability: "network.mqtt.client.v5", description: "MQTT 5 extension" },
    { name: "MqttClientQos2", cName: "MQTT_CLIENT_QOS2", value: 0x0311, capability: "network.mqtt.client.qos2", description: "MQTT QoS 2 extension" },
    { name: "MqttClientTlsCustomCa", cName: "MQTT_CLIENT_TLS_CUSTOM_CA", value: 0x0318, capability: "network.mqtt.client.tls.custom-ca", description: "MQTT client custom CA extension" },
    { name: "MqttClientTlsClientAuth", cName: "MQTT_CLIENT_TLS_CLIENT_AUTH", value: 0x0319, capability: "network.mqtt.client.tls.client-auth", description: "MQTT client certificate authentication" },
    { name: "MqttClientTlsAlpn", cName: "MQTT_CLIENT_TLS_ALPN", value: 0x031a, capability: "network.mqtt.client.tls.alpn", description: "MQTT client custom ALPN" },
    { name: "MqttClientTlsV13", cName: "MQTT_CLIENT_TLS_V1_3", value: 0x031b, capability: "network.mqtt.client.tls.v1-3", description: "Required MQTT client TLS 1.3" },
    { name: "MqttClientTlsRevocation", cName: "MQTT_CLIENT_TLS_REVOCATION", value: 0x031c, capability: "network.mqtt.client.tls.revocation", description: "Required MQTT client certificate revocation" },

    { name: "TcpClient", cName: "TCP_CLIENT", value: 0x0400, capability: "network.tcp.client", description: "TCP client role" },
    { name: "TcpClientTls", cName: "TCP_CLIENT_TLS", value: 0x0401, capability: "network.tcp.client.tls", description: "TLS for the TCP client role" },
    { name: "TcpClientIpv6", cName: "TCP_CLIENT_IPV6", value: 0x0410, capability: "network.tcp.client.ipv6", description: "TCP client IPv6 extension" },
    { name: "TcpClientSocketOptions", cName: "TCP_CLIENT_SOCKET_OPTIONS", value: 0x0411, capability: "network.tcp.client.socket-options", description: "TCP client socket options" },
    { name: "TcpClientTlsCustomCa", cName: "TCP_CLIENT_TLS_CUSTOM_CA", value: 0x0418, capability: "network.tcp.client.tls.custom-ca", description: "TCP client custom CA extension" },
    { name: "TcpClientTlsClientAuth", cName: "TCP_CLIENT_TLS_CLIENT_AUTH", value: 0x0419, capability: "network.tcp.client.tls.client-auth", description: "TCP client certificate authentication" },
    { name: "TcpClientTlsAlpn", cName: "TCP_CLIENT_TLS_ALPN", value: 0x041a, capability: "network.tcp.client.tls.alpn", description: "TCP client custom ALPN" },
    { name: "TcpClientTlsV13", cName: "TCP_CLIENT_TLS_V1_3", value: 0x041b, capability: "network.tcp.client.tls.v1-3", description: "Required TCP client TLS 1.3" },
    { name: "TcpClientTlsRevocation", cName: "TCP_CLIENT_TLS_REVOCATION", value: 0x041c, capability: "network.tcp.client.tls.revocation", description: "Required TCP client certificate revocation" },

    { name: "TcpServer", cName: "TCP_SERVER", value: 0x0420, capability: "network.tcp.server", description: "TCP server role" },
    { name: "TcpServerTls", cName: "TCP_SERVER_TLS", value: 0x0421, capability: "network.tcp.server.tls", description: "TLS for the TCP server role" },
    { name: "TcpServerIpv6", cName: "TCP_SERVER_IPV6", value: 0x0430, capability: "network.tcp.server.ipv6", description: "TCP server IPv6 extension" },
    { name: "TcpServerSocketOptions", cName: "TCP_SERVER_SOCKET_OPTIONS", value: 0x0431, capability: "network.tcp.server.socket-options", description: "TCP server socket options" },
    { name: "TcpServerTlsCustomCa", cName: "TCP_SERVER_TLS_CUSTOM_CA", value: 0x0438, capability: "network.tcp.server.tls.custom-ca", description: "TCP server custom CA extension" },
    { name: "TcpServerTlsClientAuth", cName: "TCP_SERVER_TLS_CLIENT_AUTH", value: 0x0439, capability: "network.tcp.server.tls.client-auth", description: "TCP server client-certificate authentication" },
    { name: "TcpServerTlsAlpn", cName: "TCP_SERVER_TLS_ALPN", value: 0x043a, capability: "network.tcp.server.tls.alpn", description: "TCP server custom ALPN" },
    { name: "TcpServerTlsV13", cName: "TCP_SERVER_TLS_V1_3", value: 0x043b, capability: "network.tcp.server.tls.v1-3", description: "Required TCP server TLS 1.3" },
    { name: "TcpServerTlsRevocation", cName: "TCP_SERVER_TLS_REVOCATION", value: 0x043c, capability: "network.tcp.server.tls.revocation", description: "Required TCP server certificate revocation" },

    { name: "Udp", cName: "UDP", value: 0x0500, capability: "network.udp", description: "UDP socket role" },
    { name: "UdpIpv6", cName: "UDP_IPV6", value: 0x0510, capability: "network.udp.ipv6", description: "UDP IPv6 extension" },
    { name: "UdpBroadcast", cName: "UDP_BROADCAST", value: 0x0511, capability: "network.udp.broadcast", description: "UDP broadcast extension" },
    { name: "UdpMulticast", cName: "UDP_MULTICAST", value: 0x0512, capability: "network.udp.multicast", description: "UDP multicast extension" },

    { name: "BrowserHttpClient", cName: "BROWSER_HTTP_CLIENT", value: 0x7000, capability: "network.browser.http.client", description: "Browser HTTP adapter role" },
    { name: "BrowserWebSocketClient", cName: "BROWSER_WEBSOCKET_CLIENT", value: 0x7010, capability: "network.browser.websocket.client", description: "Browser WebSocket adapter role" },
  ] satisfies readonly NetworkV1FeatureEntry[],

  commands: [
    { name: "OperationCancel", cName: "OPERATION_CANCEL", value: 0x0001, description: "Compete for an operation's single terminal claim" },
    { name: "BufferLeaseTake", cName: "BUFFER_LEASE_TAKE", value: 0x0002, description: "Synchronously claim a delivered BufferLease" },
    { name: "BufferLeaseReadInto", cName: "BUFFER_LEASE_READ_INTO", value: 0x0003, description: "Synchronously copy from a taken lease into borrowed output" },
    { name: "BufferLeaseRelease", cName: "BUFFER_LEASE_RELEASE", value: 0x0004, description: "Release a taken BufferLease exactly once" },
    { name: "BodyPull", cName: "BODY_PULL", value: 0x0010, description: "Grant one bounded body-chunk credit" },
    { name: "BodyChunk", cName: "BODY_CHUNK", value: 0x0011, description: "Satisfy body credit with one non-empty chunk" },
    { name: "BodyEnd", cName: "BODY_END", value: 0x0012, description: "End a body normally" },
    { name: "BodyError", cName: "BODY_ERROR", value: 0x0013, description: "End a body with a normalized error" },
    { name: "BodyCancel", cName: "BODY_CANCEL", value: 0x0014, description: "Cancel the opposite body producer or consumer" },
    { name: "HttpRequestStart", cName: "HTTP_REQUEST_START", value: 0x0100, description: "Start an admitted HTTP client exchange" },
  ] satisfies readonly NetworkV1NumericEntry[],

  events: [
    { name: "BodyPull", cName: "BODY_PULL", value: 0x0010, description: "Request one bounded chunk from a Guest body producer" },
    { name: "BodyChunk", cName: "BODY_CHUNK", value: 0x0011, description: "Publish one native BufferLease-backed body chunk" },
    { name: "BodyEnd", cName: "BODY_END", value: 0x0012, description: "Report normal body end" },
    { name: "BodyError", cName: "BODY_ERROR", value: 0x0013, description: "Report normalized body failure" },
    { name: "BodyCancel", cName: "BODY_CANCEL", value: 0x0014, description: "Report cancellation of the opposite body endpoint" },
    { name: "HttpResponseHeaders", cName: "HTTP_RESPONSE_HEADERS", value: 0x0100, description: "Publish validated HTTP response headers" },
    { name: "HttpRequestError", cName: "HTTP_REQUEST_ERROR", value: 0x0101, description: "Publish the HTTP operation's terminal error" },
  ] satisfies readonly NetworkV1NumericEntry[],

  errorCategories: [
    { name: "Runtime", cName: "RUNTIME", value: 1, wireName: "runtime", description: "Runtime, lifecycle, admission, or capacity failure" },
    { name: "Resolver", cName: "RESOLVER", value: 2, wireName: "resolver", description: "Name resolution failure" },
    { name: "Transport", cName: "TRANSPORT", value: 3, wireName: "transport", description: "Plain transport failure" },
    { name: "Tls", cName: "TLS", value: 4, wireName: "tls", description: "TLS policy or handshake failure" },
    { name: "Protocol", cName: "PROTOCOL", value: 5, wireName: "protocol", description: "Protocol framing or semantic failure" },
  ] satisfies readonly NetworkV1NamedEntry[],

  errors: [
    { name: "Aborted", cName: "ABORTED", value: 0x0100, wireName: "aborted", description: "The application aborted the operation" },
    { name: "TimedOut", cName: "TIMED_OUT", value: 0x0101, wireName: "timed_out", description: "A Core-owned monotonic deadline won" },
    { name: "Closed", cName: "CLOSED", value: 0x0102, wireName: "closed", description: "The owning resource closed" },
    { name: "InvalidState", cName: "INVALID_STATE", value: 0x0103, wireName: "invalid_state", description: "The operation is invalid in the current state" },
    { name: "Busy", cName: "BUSY", value: 0x0104, wireName: "busy", description: "A bounded in-flight slot is already occupied" },
    { name: "ResourceLimit", cName: "RESOURCE_LIMIT", value: 0x0105, wireName: "resource_limit", description: "An admitted hard resource limit was reached" },
    { name: "Unsupported", cName: "UNSUPPORTED", value: 0x0106, wireName: "unsupported", description: "The Build Plan does not contain the requested feature" },
    { name: "PermissionDenied", cName: "PERMISSION_DENIED", value: 0x0107, wireName: "permission_denied", description: "ResolvedNetworkPolicy rejected the operation" },
    { name: "DnsNotFound", cName: "DNS_NOT_FOUND", value: 0x0200, wireName: "dns_not_found", description: "The hostname does not exist" },
    { name: "DnsTemporaryFailure", cName: "DNS_TEMPORARY_FAILURE", value: 0x0201, wireName: "dns_temporary_failure", description: "Name resolution failed temporarily" },
    { name: "DnsRefused", cName: "DNS_REFUSED", value: 0x0202, wireName: "dns_refused", description: "The resolver refused the query" },
    { name: "ConnectionRefused", cName: "CONNECTION_REFUSED", value: 0x0300, wireName: "connection_refused", description: "The peer refused the connection" },
    { name: "ConnectionReset", cName: "CONNECTION_RESET", value: 0x0301, wireName: "connection_reset", description: "The peer reset the connection" },
    { name: "NetworkUnreachable", cName: "NETWORK_UNREACHABLE", value: 0x0302, wireName: "network_unreachable", description: "No route is available" },
    { name: "AddressInUse", cName: "ADDRESS_IN_USE", value: 0x0303, wireName: "address_in_use", description: "The local address is already in use" },
    { name: "BrokenPipe", cName: "BROKEN_PIPE", value: 0x0304, wireName: "broken_pipe", description: "The write side is no longer usable" },
    { name: "TlsCertificateInvalid", cName: "TLS_CERTIFICATE_INVALID", value: 0x0400, wireName: "tls_certificate_invalid", description: "Certificate chain, usage, or time validation failed" },
    { name: "TlsHostnameMismatch", cName: "TLS_HOSTNAME_MISMATCH", value: 0x0401, wireName: "tls_hostname_mismatch", description: "The certificate does not match the authorized hostname" },
    { name: "TlsHandshakeFailed", cName: "TLS_HANDSHAKE_FAILED", value: 0x0402, wireName: "tls_handshake_failed", description: "The TLS handshake failed" },
    { name: "TlsVersionUnsupported", cName: "TLS_VERSION_UNSUPPORTED", value: 0x0403, wireName: "tls_version_unsupported", description: "The requested TLS version cannot be negotiated" },
    { name: "TlsAlert", cName: "TLS_ALERT", value: 0x0404, wireName: "tls_alert", description: "The peer sent a TLS alert" },
    { name: "HttpProtocolError", cName: "HTTP_PROTOCOL_ERROR", value: 0x0500, wireName: "http_protocol_error", description: "HTTP framing or semantic validation failed" },
    { name: "WebSocketProtocolError", cName: "WEBSOCKET_PROTOCOL_ERROR", value: 0x0501, wireName: "websocket_protocol_error", description: "WebSocket framing or semantic validation failed" },
    { name: "MqttUnacceptableProtocolVersion", cName: "MQTT_UNACCEPTABLE_PROTOCOL_VERSION", value: 0x0510, wireName: "mqtt_unacceptable_protocol_version", description: "The broker rejected the MQTT protocol version" },
    { name: "MqttIdentifierRejected", cName: "MQTT_IDENTIFIER_REJECTED", value: 0x0511, wireName: "mqtt_identifier_rejected", description: "The broker rejected the client identifier" },
    { name: "MqttServerUnavailable", cName: "MQTT_SERVER_UNAVAILABLE", value: 0x0512, wireName: "mqtt_server_unavailable", description: "The MQTT server is unavailable" },
    { name: "MqttBadCredentials", cName: "MQTT_BAD_CREDENTIALS", value: 0x0513, wireName: "mqtt_bad_credentials", description: "The broker rejected supplied credentials" },
    { name: "MqttNotAuthorized", cName: "MQTT_NOT_AUTHORIZED", value: 0x0514, wireName: "mqtt_not_authorized", description: "The MQTT action is not authorized" },
    { name: "MqttProtocolError", cName: "MQTT_PROTOCOL_ERROR", value: 0x0515, wireName: "mqtt_protocol_error", description: "MQTT framing or semantic validation failed" },
    { name: "MessageTooLarge", cName: "MESSAGE_TOO_LARGE", value: 0x0520, wireName: "message_too_large", description: "A protocol message exceeded its admitted bound" },
    { name: "SystemError", cName: "SYSTEM_ERROR", value: 0x7fff, wireName: "system_error", description: "A redacted platform failure has no more specific mapping" },
  ] satisfies readonly NetworkV1NamedEntry[],

  dispatchStatuses: [
    { name: "Accepted", cName: "ACCEPTED", value: 1, description: "The command was accepted and any borrowed input was copied" },
    { name: "Completed", cName: "COMPLETED", value: 2, description: "The synchronous control command completed" },
    { name: "Refused", cName: "REFUSED", value: 3, description: "The command was refused before asynchronous work began" },
  ] satisfies readonly NetworkV1NumericEntry[],

  completionPollStatuses: [
    { name: "Item", cName: "ITEM", value: 1, description: "One completion was removed within the remaining byte budget" },
    { name: "Drained", cName: "DRAINED", value: 2, description: "No immediately deliverable completion remains" },
    { name: "BudgetExhausted", cName: "BUDGET_EXHAUSTED", value: 3, description: "The next completion remains queued because its payload exceeds the remaining budget" },
  ] satisfies readonly NetworkV1NumericEntry[],

  borrowedInputKinds: [
    { name: "CustomCa", cName: "CUSTOM_CA", value: 1, description: "Custom CA bytes attached to a start command" },
    { name: "BodyChunk", cName: "BODY_CHUNK", value: 2, description: "Body bytes attached to BODY_CHUNK" },
  ] satisfies readonly NetworkV1NumericEntry[],

  limitProtocols: [
    { name: "Http", cName: "HTTP", value: 1, description: "HTTP limits and features" },
    { name: "WebSocket", cName: "WEBSOCKET", value: 2, description: "WebSocket limits and features" },
    { name: "Mqtt", cName: "MQTT", value: 3, description: "MQTT limits and features" },
    { name: "Tcp", cName: "TCP", value: 4, description: "TCP limits and features" },
    { name: "Udp", cName: "UDP", value: 5, description: "UDP limits and features" },
  ] satisfies readonly NetworkV1NumericEntry[],

  limitRoles: [
    { name: "Client", cName: "CLIENT", value: 1, description: "Client-role limits and features" },
    { name: "Server", cName: "SERVER", value: 2, description: "Server-role limits and features" },
  ] satisfies readonly NetworkV1NumericEntry[],

  httpRedirectModes: [
    { name: "Follow", cName: "FOLLOW", value: 1, description: "Follow redirects inside the HTTP Core" },
    { name: "Manual", cName: "MANUAL", value: 2, description: "Publish the redirect response without following" },
    { name: "Error", cName: "ERROR", value: 3, description: "Fail when a redirect response is received" },
  ] satisfies readonly NetworkV1NumericEntry[],

  tlsVersions: [
    { name: "V12", cName: "V1_2", value: 0x0102, description: "TLS 1.2" },
    { name: "V13", cName: "V1_3", value: 0x0103, description: "TLS 1.3" },
  ] satisfies readonly NetworkV1NumericEntry[],

  tlsVerifications: [
    { name: "Full", cName: "FULL", value: 1, description: "Verify trust, time, usage, and hostname" },
    { name: "DevelopmentInsecure", cName: "DEVELOPMENT_INSECURE", value: 2, description: "Development-only invalid-certificate mode" },
  ] satisfies readonly NetworkV1NumericEntry[],

  tlsRevocations: [
    { name: "HostDefault", cName: "HOST_DEFAULT", value: 1, description: "Use the selected TLS provider's revocation policy" },
    { name: "Required", cName: "REQUIRED", value: 2, description: "Require the admitted revocation feature" },
  ] satisfies readonly NetworkV1NumericEntry[],

  clientCertificateModes: [
    { name: "None", cName: "NONE", value: 1, description: "Do not request a client certificate" },
    { name: "Optional", cName: "OPTIONAL", value: 2, description: "Accept a client certificate when supplied" },
    { name: "Required", cName: "REQUIRED", value: 3, description: "Require an admitted client certificate" },
  ] satisfies readonly NetworkV1NumericEntry[],

  serviceTurnKinds: [
    { name: "Network", cName: "NETWORK", value: 1, description: "Deliver an ordinary NetworkServiceTurn" },
    { name: "Shutdown", cName: "SHUTDOWN", value: 2, description: "Deliver bounded network cancellation in ShutdownTurn" },
  ] satisfies readonly NetworkV1NumericEntry[],

  serviceTurnStatuses: [
    { name: "Drained", cName: "DRAINED", value: 1, description: "No immediately deliverable network work remains" },
    { name: "MoreReady", cName: "MORE_READY", value: 2, description: "Work remains and the Host must keep service ready" },
  ] satisfies readonly NetworkV1NumericEntry[],

  leaseStates: [
    { name: "Queued", cName: "QUEUED", value: 1, description: "The Core owns a lease referenced by a completion" },
    { name: "Taken", cName: "TAKEN", value: 2, description: "The owner-thread Guest Binding claimed the lease" },
    { name: "Released", cName: "RELEASED", value: 3, description: "The lease returned to the native pool" },
  ] satisfies readonly NetworkV1NumericEntry[],

  leaseActions: [
    { name: "Take", cName: "TAKE", value: 1, description: "Claim a queued lease" },
    { name: "Release", cName: "RELEASE", value: 2, description: "Release a taken lease" },
    { name: "Cleanup", cName: "CLEANUP", value: 3, description: "Native stale/cancel teardown releases an untaken lease" },
  ] satisfies readonly NetworkV1NumericEntry[],
} as const;

export type NetworkV1Definition = typeof NETWORK_V1_DEFINITION;
