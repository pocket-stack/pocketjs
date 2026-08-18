/* GENERATED — do not edit; run `bun contracts/spec/network/generate.ts`.
 * Source of truth: contracts/spec/network/definition.ts.
 */
#ifndef POCKETJS_NETWORK_V1_ABI_H
#define POCKETJS_NETWORK_V1_ABI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POCKETJS_NETWORK_V1_ABI_MAJOR UINT16_C(1)
#define POCKETJS_NETWORK_V1_ABI_MINOR UINT16_C(1)
#define POCKETJS_NETWORK_V1_PLAN_HASH_BYTES UINT16_C(32)
#define POCKETJS_NETWORK_V1_SEQUENCE_MAX UINT64_C(9007199254740991)
#define POCKETJS_NETWORK_V1_LIMIT_ENTRY_MAX UINT16_C(64)
#define POCKETJS_NETWORK_V1_LIMIT_NAME_MAX_BYTES UINT16_C(64)
#define POCKETJS_NETWORK_V1_ABSENT_ID UINT32_C(0)
#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_ANY UINT16_C(0)
#define POCKETJS_NETWORK_V1_LIMIT_ROLE_ANY UINT16_C(0)
#define POCKETJS_NETWORK_V1_FEATURE_COUNT UINT16_C(70)

typedef uint16_t pocketjs_network_v1_feature_id_t;
typedef uint16_t pocketjs_network_v1_command_opcode_t;
typedef uint16_t pocketjs_network_v1_event_code_t;
typedef uint16_t pocketjs_network_v1_error_category_t;
typedef uint16_t pocketjs_network_v1_error_code_t;
typedef uint16_t pocketjs_network_v1_dispatch_status_t;
typedef uint16_t pocketjs_network_v1_completion_poll_status_t;
typedef uint16_t pocketjs_network_v1_borrowed_input_kind_t;
typedef uint16_t pocketjs_network_v1_limit_protocol_t;
typedef uint16_t pocketjs_network_v1_limit_role_t;
typedef uint16_t pocketjs_network_v1_http_redirect_mode_t;
typedef uint16_t pocketjs_network_v1_tls_version_t;
typedef uint16_t pocketjs_network_v1_tls_verification_t;
typedef uint16_t pocketjs_network_v1_tls_revocation_t;
typedef uint16_t pocketjs_network_v1_client_certificate_mode_t;
typedef uint16_t pocketjs_network_v1_service_turn_kind_t;
typedef uint16_t pocketjs_network_v1_service_turn_status_t;
typedef uint16_t pocketjs_network_v1_lease_state_t;
typedef uint16_t pocketjs_network_v1_lease_action_t;

/** HTTP client role. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT ((pocketjs_network_v1_feature_id_t)UINT16_C(256))
/** TLS for the HTTP client role. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(257))
/** HTTP/2 client extension. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_H2 ((pocketjs_network_v1_feature_id_t)UINT16_C(272))
/** HTTP/3 client extension. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_H3 ((pocketjs_network_v1_feature_id_t)UINT16_C(273))
/** HTTP client content decoding. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_COMPRESSION ((pocketjs_network_v1_feature_id_t)UINT16_C(274))
/** HTTP client custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(280))
/** HTTP client certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(281))
/** HTTP client custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(282))
/** Required HTTP client TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(283))
/** Required HTTP client certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(284))
/** HTTP server role. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER ((pocketjs_network_v1_feature_id_t)UINT16_C(288))
/** TLS for the HTTP server role. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(289))
/** HTTP/2 server extension. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_H2 ((pocketjs_network_v1_feature_id_t)UINT16_C(304))
/** HTTP/3 server extension. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_H3 ((pocketjs_network_v1_feature_id_t)UINT16_C(305))
/** HTTP server content encoding. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_COMPRESSION ((pocketjs_network_v1_feature_id_t)UINT16_C(306))
/** HTTP server custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(312))
/** HTTP server client-certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(313))
/** HTTP server custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(314))
/** Required HTTP server TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(315))
/** Required HTTP server certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(316))
/** WebSocket client role. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT ((pocketjs_network_v1_feature_id_t)UINT16_C(512))
/** TLS for the WebSocket client role. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(513))
/** WebSocket client compression. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_COMPRESSION ((pocketjs_network_v1_feature_id_t)UINT16_C(528))
/** WebSocket client custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(536))
/** WebSocket client certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(537))
/** WebSocket client custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(538))
/** Required WebSocket client TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(539))
/** Required WebSocket client certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(540))
/** WebSocket server role. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER ((pocketjs_network_v1_feature_id_t)UINT16_C(544))
/** TLS for the WebSocket server role. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(545))
/** HTTP-to-WebSocket server handoff. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_UPGRADE ((pocketjs_network_v1_feature_id_t)UINT16_C(546))
/** WebSocket server compression. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_COMPRESSION ((pocketjs_network_v1_feature_id_t)UINT16_C(560))
/** WebSocket server custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(568))
/** WebSocket server client-certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(569))
/** WebSocket server custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(570))
/** Required WebSocket server TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(571))
/** Required WebSocket server certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(572))
/** MQTT client role. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT ((pocketjs_network_v1_feature_id_t)UINT16_C(768))
/** TLS for the MQTT client role. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(769))
/** MQTT 5 extension. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_V5 ((pocketjs_network_v1_feature_id_t)UINT16_C(784))
/** MQTT QoS 2 extension. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_QOS2 ((pocketjs_network_v1_feature_id_t)UINT16_C(785))
/** MQTT client custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(792))
/** MQTT client certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(793))
/** MQTT client custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(794))
/** Required MQTT client TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(795))
/** Required MQTT client certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(796))
/** TCP client role. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT ((pocketjs_network_v1_feature_id_t)UINT16_C(1024))
/** TLS for the TCP client role. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(1025))
/** TCP client IPv6 extension. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_IPV6 ((pocketjs_network_v1_feature_id_t)UINT16_C(1040))
/** TCP client socket options. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_SOCKET_OPTIONS ((pocketjs_network_v1_feature_id_t)UINT16_C(1041))
/** TCP client custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(1048))
/** TCP client certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(1049))
/** TCP client custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(1050))
/** Required TCP client TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(1051))
/** Required TCP client certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(1052))
/** TCP server role. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER ((pocketjs_network_v1_feature_id_t)UINT16_C(1056))
/** TLS for the TCP server role. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS ((pocketjs_network_v1_feature_id_t)UINT16_C(1057))
/** TCP server IPv6 extension. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_IPV6 ((pocketjs_network_v1_feature_id_t)UINT16_C(1072))
/** TCP server socket options. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_SOCKET_OPTIONS ((pocketjs_network_v1_feature_id_t)UINT16_C(1073))
/** TCP server custom CA extension. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_CUSTOM_CA ((pocketjs_network_v1_feature_id_t)UINT16_C(1080))
/** TCP server client-certificate authentication. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_CLIENT_AUTH ((pocketjs_network_v1_feature_id_t)UINT16_C(1081))
/** TCP server custom ALPN. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_ALPN ((pocketjs_network_v1_feature_id_t)UINT16_C(1082))
/** Required TCP server TLS 1.3. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_V1_3 ((pocketjs_network_v1_feature_id_t)UINT16_C(1083))
/** Required TCP server certificate revocation. */
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_REVOCATION ((pocketjs_network_v1_feature_id_t)UINT16_C(1084))
/** UDP socket role. */
#define POCKETJS_NETWORK_V1_FEATURE_UDP ((pocketjs_network_v1_feature_id_t)UINT16_C(1280))
/** UDP IPv6 extension. */
#define POCKETJS_NETWORK_V1_FEATURE_UDP_IPV6 ((pocketjs_network_v1_feature_id_t)UINT16_C(1296))
/** UDP broadcast extension. */
#define POCKETJS_NETWORK_V1_FEATURE_UDP_BROADCAST ((pocketjs_network_v1_feature_id_t)UINT16_C(1297))
/** UDP multicast extension. */
#define POCKETJS_NETWORK_V1_FEATURE_UDP_MULTICAST ((pocketjs_network_v1_feature_id_t)UINT16_C(1298))
/** Browser HTTP adapter role. */
#define POCKETJS_NETWORK_V1_FEATURE_BROWSER_HTTP_CLIENT ((pocketjs_network_v1_feature_id_t)UINT16_C(28672))
/** Browser WebSocket adapter role. */
#define POCKETJS_NETWORK_V1_FEATURE_BROWSER_WEBSOCKET_CLIENT ((pocketjs_network_v1_feature_id_t)UINT16_C(28688))

#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_CAPABILITY "network.http.client"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_CAPABILITY "network.http.client.tls"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_H2_CAPABILITY "network.http.client.h2"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_H3_CAPABILITY "network.http.client.h3"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_COMPRESSION_CAPABILITY "network.http.client.compression"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_CUSTOM_CA_CAPABILITY "network.http.client.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_CLIENT_AUTH_CAPABILITY "network.http.client.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_ALPN_CAPABILITY "network.http.client.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_V1_3_CAPABILITY "network.http.client.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_CLIENT_TLS_REVOCATION_CAPABILITY "network.http.client.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_CAPABILITY "network.http.server"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_CAPABILITY "network.http.server.tls"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_H2_CAPABILITY "network.http.server.h2"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_H3_CAPABILITY "network.http.server.h3"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_COMPRESSION_CAPABILITY "network.http.server.compression"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_CUSTOM_CA_CAPABILITY "network.http.server.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_CLIENT_AUTH_CAPABILITY "network.http.server.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_ALPN_CAPABILITY "network.http.server.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_V1_3_CAPABILITY "network.http.server.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_HTTP_SERVER_TLS_REVOCATION_CAPABILITY "network.http.server.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_CAPABILITY "network.websocket.client"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_CAPABILITY "network.websocket.client.tls"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_COMPRESSION_CAPABILITY "network.websocket.client.compression"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_CUSTOM_CA_CAPABILITY "network.websocket.client.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_CLIENT_AUTH_CAPABILITY "network.websocket.client.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_ALPN_CAPABILITY "network.websocket.client.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_V1_3_CAPABILITY "network.websocket.client.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_CLIENT_TLS_REVOCATION_CAPABILITY "network.websocket.client.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_CAPABILITY "network.websocket.server"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_CAPABILITY "network.websocket.server.tls"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_UPGRADE_CAPABILITY "network.websocket.server.upgrade"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_COMPRESSION_CAPABILITY "network.websocket.server.compression"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_CUSTOM_CA_CAPABILITY "network.websocket.server.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_CLIENT_AUTH_CAPABILITY "network.websocket.server.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_ALPN_CAPABILITY "network.websocket.server.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_V1_3_CAPABILITY "network.websocket.server.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_WEBSOCKET_SERVER_TLS_REVOCATION_CAPABILITY "network.websocket.server.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_CAPABILITY "network.mqtt.client"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_CAPABILITY "network.mqtt.client.tls"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_V5_CAPABILITY "network.mqtt.client.v5"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_QOS2_CAPABILITY "network.mqtt.client.qos2"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_CUSTOM_CA_CAPABILITY "network.mqtt.client.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_CLIENT_AUTH_CAPABILITY "network.mqtt.client.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_ALPN_CAPABILITY "network.mqtt.client.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_V1_3_CAPABILITY "network.mqtt.client.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_MQTT_CLIENT_TLS_REVOCATION_CAPABILITY "network.mqtt.client.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_CAPABILITY "network.tcp.client"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_CAPABILITY "network.tcp.client.tls"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_IPV6_CAPABILITY "network.tcp.client.ipv6"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_SOCKET_OPTIONS_CAPABILITY "network.tcp.client.socket-options"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_CUSTOM_CA_CAPABILITY "network.tcp.client.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_CLIENT_AUTH_CAPABILITY "network.tcp.client.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_ALPN_CAPABILITY "network.tcp.client.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_V1_3_CAPABILITY "network.tcp.client.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_CLIENT_TLS_REVOCATION_CAPABILITY "network.tcp.client.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_CAPABILITY "network.tcp.server"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_CAPABILITY "network.tcp.server.tls"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_IPV6_CAPABILITY "network.tcp.server.ipv6"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_SOCKET_OPTIONS_CAPABILITY "network.tcp.server.socket-options"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_CUSTOM_CA_CAPABILITY "network.tcp.server.tls.custom-ca"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_CLIENT_AUTH_CAPABILITY "network.tcp.server.tls.client-auth"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_ALPN_CAPABILITY "network.tcp.server.tls.alpn"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_V1_3_CAPABILITY "network.tcp.server.tls.v1-3"
#define POCKETJS_NETWORK_V1_FEATURE_TCP_SERVER_TLS_REVOCATION_CAPABILITY "network.tcp.server.tls.revocation"
#define POCKETJS_NETWORK_V1_FEATURE_UDP_CAPABILITY "network.udp"
#define POCKETJS_NETWORK_V1_FEATURE_UDP_IPV6_CAPABILITY "network.udp.ipv6"
#define POCKETJS_NETWORK_V1_FEATURE_UDP_BROADCAST_CAPABILITY "network.udp.broadcast"
#define POCKETJS_NETWORK_V1_FEATURE_UDP_MULTICAST_CAPABILITY "network.udp.multicast"
#define POCKETJS_NETWORK_V1_FEATURE_BROWSER_HTTP_CLIENT_CAPABILITY "network.browser.http.client"
#define POCKETJS_NETWORK_V1_FEATURE_BROWSER_WEBSOCKET_CLIENT_CAPABILITY "network.browser.websocket.client"

/** Compete for an operation's single terminal claim. */
#define POCKETJS_NETWORK_V1_COMMAND_OPERATION_CANCEL ((pocketjs_network_v1_command_opcode_t)UINT16_C(1))
/** Synchronously claim a delivered BufferLease. */
#define POCKETJS_NETWORK_V1_COMMAND_BUFFER_LEASE_TAKE ((pocketjs_network_v1_command_opcode_t)UINT16_C(2))
/** Synchronously copy from a taken lease into borrowed output. */
#define POCKETJS_NETWORK_V1_COMMAND_BUFFER_LEASE_READ_INTO ((pocketjs_network_v1_command_opcode_t)UINT16_C(3))
/** Release a taken BufferLease exactly once. */
#define POCKETJS_NETWORK_V1_COMMAND_BUFFER_LEASE_RELEASE ((pocketjs_network_v1_command_opcode_t)UINT16_C(4))
/** Grant one bounded body-chunk credit. */
#define POCKETJS_NETWORK_V1_COMMAND_BODY_PULL ((pocketjs_network_v1_command_opcode_t)UINT16_C(16))
/** Satisfy body credit with one non-empty chunk. */
#define POCKETJS_NETWORK_V1_COMMAND_BODY_CHUNK ((pocketjs_network_v1_command_opcode_t)UINT16_C(17))
/** End a body normally. */
#define POCKETJS_NETWORK_V1_COMMAND_BODY_END ((pocketjs_network_v1_command_opcode_t)UINT16_C(18))
/** End a body with a normalized error. */
#define POCKETJS_NETWORK_V1_COMMAND_BODY_ERROR ((pocketjs_network_v1_command_opcode_t)UINT16_C(19))
/** Cancel the opposite body producer or consumer. */
#define POCKETJS_NETWORK_V1_COMMAND_BODY_CANCEL ((pocketjs_network_v1_command_opcode_t)UINT16_C(20))
/** Start an admitted HTTP client exchange. */
#define POCKETJS_NETWORK_V1_COMMAND_HTTP_REQUEST_START ((pocketjs_network_v1_command_opcode_t)UINT16_C(256))

/** Request one bounded chunk from a Guest body producer. */
#define POCKETJS_NETWORK_V1_EVENT_BODY_PULL ((pocketjs_network_v1_event_code_t)UINT16_C(16))
/** Publish one native BufferLease-backed body chunk. */
#define POCKETJS_NETWORK_V1_EVENT_BODY_CHUNK ((pocketjs_network_v1_event_code_t)UINT16_C(17))
/** Report normal body end. */
#define POCKETJS_NETWORK_V1_EVENT_BODY_END ((pocketjs_network_v1_event_code_t)UINT16_C(18))
/** Report normalized body failure. */
#define POCKETJS_NETWORK_V1_EVENT_BODY_ERROR ((pocketjs_network_v1_event_code_t)UINT16_C(19))
/** Report cancellation of the opposite body endpoint. */
#define POCKETJS_NETWORK_V1_EVENT_BODY_CANCEL ((pocketjs_network_v1_event_code_t)UINT16_C(20))
/** Publish validated HTTP response headers. */
#define POCKETJS_NETWORK_V1_EVENT_HTTP_RESPONSE_HEADERS ((pocketjs_network_v1_event_code_t)UINT16_C(256))
/** Publish the HTTP operation's terminal error. */
#define POCKETJS_NETWORK_V1_EVENT_HTTP_REQUEST_ERROR ((pocketjs_network_v1_event_code_t)UINT16_C(257))

/** Runtime, lifecycle, admission, or capacity failure. */
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME ((pocketjs_network_v1_error_category_t)UINT16_C(1))
/** Name resolution failure. */
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_RESOLVER ((pocketjs_network_v1_error_category_t)UINT16_C(2))
/** Plain transport failure. */
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_TRANSPORT ((pocketjs_network_v1_error_category_t)UINT16_C(3))
/** TLS policy or handshake failure. */
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS ((pocketjs_network_v1_error_category_t)UINT16_C(4))
/** Protocol framing or semantic failure. */
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_PROTOCOL ((pocketjs_network_v1_error_category_t)UINT16_C(5))

#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME_NAME "runtime"
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_RESOLVER_NAME "resolver"
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_TRANSPORT_NAME "transport"
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS_NAME "tls"
#define POCKETJS_NETWORK_V1_ERROR_CATEGORY_PROTOCOL_NAME "protocol"

/** The application aborted the operation. */
#define POCKETJS_NETWORK_V1_ERROR_ABORTED ((pocketjs_network_v1_error_code_t)UINT16_C(256))
/** A Core-owned monotonic deadline won. */
#define POCKETJS_NETWORK_V1_ERROR_TIMED_OUT ((pocketjs_network_v1_error_code_t)UINT16_C(257))
/** The owning resource closed. */
#define POCKETJS_NETWORK_V1_ERROR_CLOSED ((pocketjs_network_v1_error_code_t)UINT16_C(258))
/** The operation is invalid in the current state. */
#define POCKETJS_NETWORK_V1_ERROR_INVALID_STATE ((pocketjs_network_v1_error_code_t)UINT16_C(259))
/** A bounded in-flight slot is already occupied. */
#define POCKETJS_NETWORK_V1_ERROR_BUSY ((pocketjs_network_v1_error_code_t)UINT16_C(260))
/** An admitted hard resource limit was reached. */
#define POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT ((pocketjs_network_v1_error_code_t)UINT16_C(261))
/** The Build Plan does not contain the requested feature. */
#define POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED ((pocketjs_network_v1_error_code_t)UINT16_C(262))
/** ResolvedNetworkPolicy rejected the operation. */
#define POCKETJS_NETWORK_V1_ERROR_PERMISSION_DENIED ((pocketjs_network_v1_error_code_t)UINT16_C(263))
/** The hostname does not exist. */
#define POCKETJS_NETWORK_V1_ERROR_DNS_NOT_FOUND ((pocketjs_network_v1_error_code_t)UINT16_C(512))
/** Name resolution failed temporarily. */
#define POCKETJS_NETWORK_V1_ERROR_DNS_TEMPORARY_FAILURE ((pocketjs_network_v1_error_code_t)UINT16_C(513))
/** The resolver refused the query. */
#define POCKETJS_NETWORK_V1_ERROR_DNS_REFUSED ((pocketjs_network_v1_error_code_t)UINT16_C(514))
/** The peer refused the connection. */
#define POCKETJS_NETWORK_V1_ERROR_CONNECTION_REFUSED ((pocketjs_network_v1_error_code_t)UINT16_C(768))
/** The peer reset the connection. */
#define POCKETJS_NETWORK_V1_ERROR_CONNECTION_RESET ((pocketjs_network_v1_error_code_t)UINT16_C(769))
/** No route is available. */
#define POCKETJS_NETWORK_V1_ERROR_NETWORK_UNREACHABLE ((pocketjs_network_v1_error_code_t)UINT16_C(770))
/** The local address is already in use. */
#define POCKETJS_NETWORK_V1_ERROR_ADDRESS_IN_USE ((pocketjs_network_v1_error_code_t)UINT16_C(771))
/** The write side is no longer usable. */
#define POCKETJS_NETWORK_V1_ERROR_BROKEN_PIPE ((pocketjs_network_v1_error_code_t)UINT16_C(772))
/** Certificate chain, usage, or time validation failed. */
#define POCKETJS_NETWORK_V1_ERROR_TLS_CERTIFICATE_INVALID ((pocketjs_network_v1_error_code_t)UINT16_C(1024))
/** The certificate does not match the authorized hostname. */
#define POCKETJS_NETWORK_V1_ERROR_TLS_HOSTNAME_MISMATCH ((pocketjs_network_v1_error_code_t)UINT16_C(1025))
/** The TLS handshake failed. */
#define POCKETJS_NETWORK_V1_ERROR_TLS_HANDSHAKE_FAILED ((pocketjs_network_v1_error_code_t)UINT16_C(1026))
/** The requested TLS version cannot be negotiated. */
#define POCKETJS_NETWORK_V1_ERROR_TLS_VERSION_UNSUPPORTED ((pocketjs_network_v1_error_code_t)UINT16_C(1027))
/** The peer sent a TLS alert. */
#define POCKETJS_NETWORK_V1_ERROR_TLS_ALERT ((pocketjs_network_v1_error_code_t)UINT16_C(1028))
/** HTTP framing or semantic validation failed. */
#define POCKETJS_NETWORK_V1_ERROR_HTTP_PROTOCOL_ERROR ((pocketjs_network_v1_error_code_t)UINT16_C(1280))
/** WebSocket framing or semantic validation failed. */
#define POCKETJS_NETWORK_V1_ERROR_WEBSOCKET_PROTOCOL_ERROR ((pocketjs_network_v1_error_code_t)UINT16_C(1281))
/** The broker rejected the MQTT protocol version. */
#define POCKETJS_NETWORK_V1_ERROR_MQTT_UNACCEPTABLE_PROTOCOL_VERSION ((pocketjs_network_v1_error_code_t)UINT16_C(1296))
/** The broker rejected the client identifier. */
#define POCKETJS_NETWORK_V1_ERROR_MQTT_IDENTIFIER_REJECTED ((pocketjs_network_v1_error_code_t)UINT16_C(1297))
/** The MQTT server is unavailable. */
#define POCKETJS_NETWORK_V1_ERROR_MQTT_SERVER_UNAVAILABLE ((pocketjs_network_v1_error_code_t)UINT16_C(1298))
/** The broker rejected supplied credentials. */
#define POCKETJS_NETWORK_V1_ERROR_MQTT_BAD_CREDENTIALS ((pocketjs_network_v1_error_code_t)UINT16_C(1299))
/** The MQTT action is not authorized. */
#define POCKETJS_NETWORK_V1_ERROR_MQTT_NOT_AUTHORIZED ((pocketjs_network_v1_error_code_t)UINT16_C(1300))
/** MQTT framing or semantic validation failed. */
#define POCKETJS_NETWORK_V1_ERROR_MQTT_PROTOCOL_ERROR ((pocketjs_network_v1_error_code_t)UINT16_C(1301))
/** A protocol message exceeded its admitted bound. */
#define POCKETJS_NETWORK_V1_ERROR_MESSAGE_TOO_LARGE ((pocketjs_network_v1_error_code_t)UINT16_C(1312))
/** A redacted platform failure has no more specific mapping. */
#define POCKETJS_NETWORK_V1_ERROR_SYSTEM_ERROR ((pocketjs_network_v1_error_code_t)UINT16_C(32767))

#define POCKETJS_NETWORK_V1_ERROR_ABORTED_NAME "aborted"
#define POCKETJS_NETWORK_V1_ERROR_TIMED_OUT_NAME "timed_out"
#define POCKETJS_NETWORK_V1_ERROR_CLOSED_NAME "closed"
#define POCKETJS_NETWORK_V1_ERROR_INVALID_STATE_NAME "invalid_state"
#define POCKETJS_NETWORK_V1_ERROR_BUSY_NAME "busy"
#define POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT_NAME "resource_limit"
#define POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED_NAME "unsupported"
#define POCKETJS_NETWORK_V1_ERROR_PERMISSION_DENIED_NAME "permission_denied"
#define POCKETJS_NETWORK_V1_ERROR_DNS_NOT_FOUND_NAME "dns_not_found"
#define POCKETJS_NETWORK_V1_ERROR_DNS_TEMPORARY_FAILURE_NAME "dns_temporary_failure"
#define POCKETJS_NETWORK_V1_ERROR_DNS_REFUSED_NAME "dns_refused"
#define POCKETJS_NETWORK_V1_ERROR_CONNECTION_REFUSED_NAME "connection_refused"
#define POCKETJS_NETWORK_V1_ERROR_CONNECTION_RESET_NAME "connection_reset"
#define POCKETJS_NETWORK_V1_ERROR_NETWORK_UNREACHABLE_NAME "network_unreachable"
#define POCKETJS_NETWORK_V1_ERROR_ADDRESS_IN_USE_NAME "address_in_use"
#define POCKETJS_NETWORK_V1_ERROR_BROKEN_PIPE_NAME "broken_pipe"
#define POCKETJS_NETWORK_V1_ERROR_TLS_CERTIFICATE_INVALID_NAME "tls_certificate_invalid"
#define POCKETJS_NETWORK_V1_ERROR_TLS_HOSTNAME_MISMATCH_NAME "tls_hostname_mismatch"
#define POCKETJS_NETWORK_V1_ERROR_TLS_HANDSHAKE_FAILED_NAME "tls_handshake_failed"
#define POCKETJS_NETWORK_V1_ERROR_TLS_VERSION_UNSUPPORTED_NAME "tls_version_unsupported"
#define POCKETJS_NETWORK_V1_ERROR_TLS_ALERT_NAME "tls_alert"
#define POCKETJS_NETWORK_V1_ERROR_HTTP_PROTOCOL_ERROR_NAME "http_protocol_error"
#define POCKETJS_NETWORK_V1_ERROR_WEBSOCKET_PROTOCOL_ERROR_NAME "websocket_protocol_error"
#define POCKETJS_NETWORK_V1_ERROR_MQTT_UNACCEPTABLE_PROTOCOL_VERSION_NAME "mqtt_unacceptable_protocol_version"
#define POCKETJS_NETWORK_V1_ERROR_MQTT_IDENTIFIER_REJECTED_NAME "mqtt_identifier_rejected"
#define POCKETJS_NETWORK_V1_ERROR_MQTT_SERVER_UNAVAILABLE_NAME "mqtt_server_unavailable"
#define POCKETJS_NETWORK_V1_ERROR_MQTT_BAD_CREDENTIALS_NAME "mqtt_bad_credentials"
#define POCKETJS_NETWORK_V1_ERROR_MQTT_NOT_AUTHORIZED_NAME "mqtt_not_authorized"
#define POCKETJS_NETWORK_V1_ERROR_MQTT_PROTOCOL_ERROR_NAME "mqtt_protocol_error"
#define POCKETJS_NETWORK_V1_ERROR_MESSAGE_TOO_LARGE_NAME "message_too_large"
#define POCKETJS_NETWORK_V1_ERROR_SYSTEM_ERROR_NAME "system_error"

/** The command was accepted and any borrowed input was copied. */
#define POCKETJS_NETWORK_V1_DISPATCH_ACCEPTED ((pocketjs_network_v1_dispatch_status_t)UINT16_C(1))
/** The synchronous control command completed. */
#define POCKETJS_NETWORK_V1_DISPATCH_COMPLETED ((pocketjs_network_v1_dispatch_status_t)UINT16_C(2))
/** The command was refused before asynchronous work began. */
#define POCKETJS_NETWORK_V1_DISPATCH_REFUSED ((pocketjs_network_v1_dispatch_status_t)UINT16_C(3))

/** One completion was removed within the remaining byte budget. */
#define POCKETJS_NETWORK_V1_COMPLETION_POLL_ITEM ((pocketjs_network_v1_completion_poll_status_t)UINT16_C(1))
/** No immediately deliverable completion remains. */
#define POCKETJS_NETWORK_V1_COMPLETION_POLL_DRAINED ((pocketjs_network_v1_completion_poll_status_t)UINT16_C(2))
/** The next completion remains queued because its payload exceeds the remaining budget. */
#define POCKETJS_NETWORK_V1_COMPLETION_POLL_BUDGET_EXHAUSTED ((pocketjs_network_v1_completion_poll_status_t)UINT16_C(3))

/** Custom CA bytes attached to a start command. */
#define POCKETJS_NETWORK_V1_BORROWED_INPUT_CUSTOM_CA ((pocketjs_network_v1_borrowed_input_kind_t)UINT16_C(1))
/** Body bytes attached to BODY_CHUNK. */
#define POCKETJS_NETWORK_V1_BORROWED_INPUT_BODY_CHUNK ((pocketjs_network_v1_borrowed_input_kind_t)UINT16_C(2))

/** HTTP limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_HTTP ((pocketjs_network_v1_limit_protocol_t)UINT16_C(1))
/** WebSocket limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_WEBSOCKET ((pocketjs_network_v1_limit_protocol_t)UINT16_C(2))
/** MQTT limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_MQTT ((pocketjs_network_v1_limit_protocol_t)UINT16_C(3))
/** TCP limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_TCP ((pocketjs_network_v1_limit_protocol_t)UINT16_C(4))
/** UDP limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_UDP ((pocketjs_network_v1_limit_protocol_t)UINT16_C(5))

/** Client-role limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_ROLE_CLIENT ((pocketjs_network_v1_limit_role_t)UINT16_C(1))
/** Server-role limits and features. */
#define POCKETJS_NETWORK_V1_LIMIT_ROLE_SERVER ((pocketjs_network_v1_limit_role_t)UINT16_C(2))

/** Follow redirects inside the HTTP Core. */
#define POCKETJS_NETWORK_V1_HTTP_REDIRECT_FOLLOW ((pocketjs_network_v1_http_redirect_mode_t)UINT16_C(1))
/** Publish the redirect response without following. */
#define POCKETJS_NETWORK_V1_HTTP_REDIRECT_MANUAL ((pocketjs_network_v1_http_redirect_mode_t)UINT16_C(2))
/** Fail when a redirect response is received. */
#define POCKETJS_NETWORK_V1_HTTP_REDIRECT_ERROR ((pocketjs_network_v1_http_redirect_mode_t)UINT16_C(3))

/** TLS 1.2. */
#define POCKETJS_NETWORK_V1_TLS_VERSION_V1_2 ((pocketjs_network_v1_tls_version_t)UINT16_C(258))
/** TLS 1.3. */
#define POCKETJS_NETWORK_V1_TLS_VERSION_V1_3 ((pocketjs_network_v1_tls_version_t)UINT16_C(259))

/** Verify trust, time, usage, and hostname. */
#define POCKETJS_NETWORK_V1_TLS_VERIFICATION_FULL ((pocketjs_network_v1_tls_verification_t)UINT16_C(1))
/** Development-only invalid-certificate mode. */
#define POCKETJS_NETWORK_V1_TLS_VERIFICATION_DEVELOPMENT_INSECURE ((pocketjs_network_v1_tls_verification_t)UINT16_C(2))

/** Use the selected TLS provider's revocation policy. */
#define POCKETJS_NETWORK_V1_TLS_REVOCATION_HOST_DEFAULT ((pocketjs_network_v1_tls_revocation_t)UINT16_C(1))
/** Require the admitted revocation feature. */
#define POCKETJS_NETWORK_V1_TLS_REVOCATION_REQUIRED ((pocketjs_network_v1_tls_revocation_t)UINT16_C(2))

/** Do not request a client certificate. */
#define POCKETJS_NETWORK_V1_CLIENT_CERTIFICATE_NONE ((pocketjs_network_v1_client_certificate_mode_t)UINT16_C(1))
/** Accept a client certificate when supplied. */
#define POCKETJS_NETWORK_V1_CLIENT_CERTIFICATE_OPTIONAL ((pocketjs_network_v1_client_certificate_mode_t)UINT16_C(2))
/** Require an admitted client certificate. */
#define POCKETJS_NETWORK_V1_CLIENT_CERTIFICATE_REQUIRED ((pocketjs_network_v1_client_certificate_mode_t)UINT16_C(3))

/** Deliver an ordinary NetworkServiceTurn. */
#define POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_NETWORK ((pocketjs_network_v1_service_turn_kind_t)UINT16_C(1))
/** Deliver bounded network cancellation in ShutdownTurn. */
#define POCKETJS_NETWORK_V1_SERVICE_TURN_KIND_SHUTDOWN ((pocketjs_network_v1_service_turn_kind_t)UINT16_C(2))

/** No immediately deliverable network work remains. */
#define POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED ((pocketjs_network_v1_service_turn_status_t)UINT16_C(1))
/** Work remains and the Host must keep service ready. */
#define POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY ((pocketjs_network_v1_service_turn_status_t)UINT16_C(2))

/** The Core owns a lease referenced by a completion. */
#define POCKETJS_NETWORK_V1_LEASE_STATE_QUEUED ((pocketjs_network_v1_lease_state_t)UINT16_C(1))
/** The owner-thread Guest Binding claimed the lease. */
#define POCKETJS_NETWORK_V1_LEASE_STATE_TAKEN ((pocketjs_network_v1_lease_state_t)UINT16_C(2))
/** The lease returned to the native pool. */
#define POCKETJS_NETWORK_V1_LEASE_STATE_RELEASED ((pocketjs_network_v1_lease_state_t)UINT16_C(3))

/** Claim a queued lease. */
#define POCKETJS_NETWORK_V1_LEASE_ACTION_TAKE ((pocketjs_network_v1_lease_action_t)UINT16_C(1))
/** Release a taken lease. */
#define POCKETJS_NETWORK_V1_LEASE_ACTION_RELEASE ((pocketjs_network_v1_lease_action_t)UINT16_C(2))
/** Native stale/cancel teardown releases an untaken lease. */
#define POCKETJS_NETWORK_V1_LEASE_ACTION_CLEANUP ((pocketjs_network_v1_lease_action_t)UINT16_C(3))

/** A zero/zero handle is absent. A live handle has non-zero id and generation. */
typedef struct pocketjs_network_v1_handle {
  uint32_t id;
  uint32_t generation;
} pocketjs_network_v1_handle_t;

/** Identity carried by every command accepted by the native adapter. */
typedef struct pocketjs_network_v1_command_identity {
  uint32_t runtime_generation;
  pocketjs_network_v1_handle_t resource;
  pocketjs_network_v1_handle_t operation;
  pocketjs_network_v1_handle_t body;
  uint64_t command_sequence;
} pocketjs_network_v1_command_identity_t;

/** Identity carried by every Core-to-Guest completion. */
typedef struct pocketjs_network_v1_completion_identity {
  uint32_t runtime_generation;
  pocketjs_network_v1_handle_t resource;
  pocketjs_network_v1_handle_t operation;
  pocketjs_network_v1_handle_t body;
  uint64_t sequence;
} pocketjs_network_v1_completion_identity_t;

/** A completion advertises this descriptor; payload bytes remain native. */
typedef struct pocketjs_network_v1_lease_descriptor {
  uint32_t runtime_generation;
  pocketjs_network_v1_handle_t lease;
  uint32_t byte_length;
} pocketjs_network_v1_lease_descriptor_t;

/**
 * Borrowed input is valid only during the synchronous adapter call. The
 * adapter copies exactly this window to an owned BufferLease before it
 * returns POCKETJS_NETWORK_V1_DISPATCH_ACCEPTED.
 */
typedef struct pocketjs_network_v1_borrowed_input_view {
  pocketjs_network_v1_borrowed_input_kind_t kind;
  uint16_t reserved_zero;
  const uint8_t *data;
  uint32_t byte_length;
} pocketjs_network_v1_borrowed_input_view_t;

/** Writable Guest memory borrowed only for BUFFER_LEASE_READ_INTO. */
typedef struct pocketjs_network_v1_borrowed_output_view {
  uint8_t *data;
  uint32_t byte_length;
} pocketjs_network_v1_borrowed_output_view_t;

/** Refused carries non-zero category/code; Accepted/Completed carry zeros. */
typedef struct pocketjs_network_v1_dispatch_result {
  pocketjs_network_v1_dispatch_status_t status;
  pocketjs_network_v1_error_category_t error_category;
  pocketjs_network_v1_error_code_t error_code;
  uint16_t reserved_zero;
} pocketjs_network_v1_dispatch_result_t;

/** Remaining byte credit passed to one completion dequeue attempt. */
typedef struct pocketjs_network_v1_completion_poll_request {
  uint32_t runtime_generation;
  uint32_t max_payload_bytes;
} pocketjs_network_v1_completion_poll_request_t;

/** ITEM reports the selected completion's entire advertised payload size. */
typedef struct pocketjs_network_v1_completion_poll_result {
  pocketjs_network_v1_completion_poll_status_t status;
  uint16_t reserved_zero;
  uint32_t payload_bytes_delivered;
} pocketjs_network_v1_completion_poll_result_t;

/**
 * Mount handshake view. feature_ids are strictly increasing and describe
 * exactly the true network feature projection of the verified Build Plan.
 * plan_hash is the 32-byte digest portion of the sha256: planHash.
 */
typedef struct pocketjs_network_v1_handshake_view {
  uint16_t abi_major;
  uint16_t abi_minor;
  uint32_t runtime_generation;
  const pocketjs_network_v1_feature_id_t *feature_ids;
  uint16_t feature_count;
  uint16_t reserved_zero;
  uint8_t plan_hash[POCKETJS_NETWORK_V1_PLAN_HASH_BYTES];
} pocketjs_network_v1_handshake_view_t;

/** Zero protocol/role selects the build-wide dimension. */
typedef struct pocketjs_network_v1_limits_query {
  uint32_t runtime_generation;
  pocketjs_network_v1_limit_protocol_t protocol;
  pocketjs_network_v1_limit_role_t role;
} pocketjs_network_v1_limits_query_t;

/** One immutable effective limit entry returned by the Host. */
typedef struct pocketjs_network_v1_limit_entry_view {
  const char *name;
  uint16_t name_length;
  uint16_t reserved_zero;
  uint64_t default_value;
  uint64_t hard_value;
  uint64_t minimum_value;
} pocketjs_network_v1_limit_entry_view_t;

/** Borrowed synchronous view for the ABI 1.1 getLimits method. */
typedef struct pocketjs_network_v1_limits_snapshot_view {
  uint32_t runtime_generation;
  pocketjs_network_v1_limit_protocol_t protocol;
  pocketjs_network_v1_limit_role_t role;
  const pocketjs_network_v1_limit_entry_view_t *values;
  uint16_t value_count;
  const pocketjs_network_v1_feature_id_t *feature_ids;
  uint16_t feature_count;
} pocketjs_network_v1_limits_snapshot_view_t;

/** Host-to-Guest budget for one registered service-dispatcher invocation. */
typedef struct pocketjs_network_v1_service_turn_request {
  uint32_t runtime_generation;
  uint64_t turn_id;
  pocketjs_network_v1_service_turn_kind_t kind;
  uint16_t reserved_zero;
  uint32_t max_events;
  uint32_t max_payload_bytes;
} pocketjs_network_v1_service_turn_request_t;

/** Guest result; counts cannot exceed the request and sequence is monotonic. */
typedef struct pocketjs_network_v1_service_turn_result {
  pocketjs_network_v1_service_turn_status_t status;
  uint16_t reserved_zero;
  uint32_t events_delivered;
  uint32_t payload_bytes_delivered;
  uint64_t last_sequence;
} pocketjs_network_v1_service_turn_result_t;

static inline int pocketjs_network_v1_handle_is_absent(
    pocketjs_network_v1_handle_t handle) {
  return handle.id == POCKETJS_NETWORK_V1_ABSENT_ID &&
         handle.generation == POCKETJS_NETWORK_V1_ABSENT_ID;
}

static inline int pocketjs_network_v1_handle_is_live(
    pocketjs_network_v1_handle_t handle) {
  return handle.id != POCKETJS_NETWORK_V1_ABSENT_ID &&
         handle.generation != POCKETJS_NETWORK_V1_ABSENT_ID;
}

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(pocketjs_network_v1_handle_t) == 8, "network v1 handle layout");
_Static_assert(sizeof(uint64_t) == 8, "network v1 requires uint64_t");
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* POCKETJS_NETWORK_V1_ABI_H */
