#ifndef POCKETJS_3DS_DEV_PROTOCOL_H
#define POCKETJS_3DS_DEV_PROTOCOL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define POCKET_RUNTIME_WIRE_MAGIC 0x54524b50u /* 'PKRT' little-endian */
#define POCKET_RUNTIME_DISCOVERY_MAGIC 0x44524b50u /* 'PKRD' little-endian */
#define POCKET_RUNTIME_WIRE_VERSION 1u
#define POCKET_RUNTIME_WIRE_PORT 8131u
#define POCKET_RUNTIME_DISCOVERY_REQUEST_BYTES 8u
#define POCKET_RUNTIME_DISCOVERY_REPLY_BYTES 64u
#define POCKET_RUNTIME_DISCOVERY_REQUEST 1u
#define POCKET_RUNTIME_DISCOVERY_REPLY 2u
#define POCKET_RUNTIME_TOKEN_BYTES 32u
#define POCKET_RUNTIME_HELLO_BYTES 40u
#define POCKET_RUNTIME_ACK_BYTES 24u
#define POCKET_RUNTIME_FRAME_HEADER_BYTES 8u
#define POCKET_RUNTIME_MAX_FRAME_BYTES (64u * 1024u)
#define POCKET_RUNTIME_MAX_CTRL_BYTES (16u * 1024u)
#define POCKET_RUNTIME_PACKAGE_BEGIN_BYTES 12u
#define POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES 24u
#define POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8 1u

enum PocketRuntimeMessage {
  POCKET_RUNTIME_MSG_PING = 0x01,
  POCKET_RUNTIME_MSG_PONG = 0x02,
  POCKET_RUNTIME_MSG_CTRL = 0x10,
  POCKET_RUNTIME_MSG_PACKAGE_BEGIN = 0x20,
  POCKET_RUNTIME_MSG_PACKAGE_CHUNK = 0x21,
  POCKET_RUNTIME_MSG_PACKAGE_COMMIT = 0x22,
  POCKET_RUNTIME_MSG_PACKAGE_ABORT = 0x23,
  POCKET_RUNTIME_MSG_SCREENSHOT_BEGIN = 0x30,
  POCKET_RUNTIME_MSG_SCREENSHOT_CHUNK = 0x31,
  POCKET_RUNTIME_MSG_SCREENSHOT_END = 0x32,
  POCKET_RUNTIME_MSG_STATUS_REQUEST = 0x40,
};

typedef struct {
  uint8_t type;
  uint8_t flags;
  uint32_t length;
} PocketRuntimeFrameHeader;

typedef struct {
  uint32_t length;
  uint64_t footer_hash;
} PocketRuntimePackageBegin;

uint16_t pocket_runtime_read_u16(const uint8_t *bytes);
uint32_t pocket_runtime_read_u32(const uint8_t *bytes);
uint64_t pocket_runtime_read_u64(const uint8_t *bytes);
void pocket_runtime_write_u16(uint8_t *bytes, uint16_t value);
void pocket_runtime_write_u32(uint8_t *bytes, uint32_t value);
void pocket_runtime_write_u64(uint8_t *bytes, uint64_t value);

bool pocket_runtime_verify_hello(
  const uint8_t *bytes,
  size_t length,
  const uint8_t token[POCKET_RUNTIME_TOKEN_BYTES]
);
void pocket_runtime_encode_ack(
  uint8_t out[POCKET_RUNTIME_ACK_BYTES],
  uint8_t status,
  uint16_t host_abi,
  uint32_t generation,
  uint32_t flags,
  uint64_t active_hash
);
bool pocket_runtime_parse_frame_header(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimeFrameHeader *out
);
void pocket_runtime_encode_frame_header(
  uint8_t out[POCKET_RUNTIME_FRAME_HEADER_BYTES],
  uint8_t type,
  uint8_t flags,
  uint32_t length
);
bool pocket_runtime_parse_package_begin(
  const uint8_t *bytes,
  size_t length,
  PocketRuntimePackageBegin *out
);
void pocket_runtime_encode_screenshot_begin(
  uint8_t out[POCKET_RUNTIME_SCREENSHOT_BEGIN_BYTES],
  uint32_t frame,
  uint16_t top_width,
  uint16_t top_height,
  uint16_t auxiliary_width,
  uint16_t auxiliary_height,
  uint32_t top_bytes,
  uint32_t auxiliary_bytes
);
uint64_t pocket_runtime_device_id(
  const uint8_t token[POCKET_RUNTIME_TOKEN_BYTES]
);
bool pocket_runtime_is_discovery_request(const uint8_t *bytes, size_t length);
void pocket_runtime_encode_discovery_reply(
  uint8_t out[POCKET_RUNTIME_DISCOVERY_REPLY_BYTES],
  uint16_t host_abi,
  uint16_t port,
  uint16_t flags,
  uint32_t generation,
  uint64_t active_hash,
  uint64_t device_id,
  const char *target,
  const char *label
);

#endif
