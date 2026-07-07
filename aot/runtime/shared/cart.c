// aot/runtime/shared/cart.c — PJGB cartridge container access.
//
// The blob layout (little-endian):
//   header (PJGB_HEADER_SIZE bytes): magic[4], u16 version, u16 chunk_count,
//                                    u32 chunk_table_offset, u32 total_size
//   chunk table: chunk_count entries of { u32 kind, u32 id, u32 offset, u32 size }
//   ...chunk payloads (offset is measured from the blob base).
#include "runtime.h"

static const u8 *cart_base;

void cart_load(const void *blob) { cart_base = (const u8 *)blob; }

const u8 *cart_chunk(u32 kind, u32 id, u32 *out_size) {
  u16 count = *(const u16 *)(cart_base + 6);
  u32 table_off = *(const u32 *)(cart_base + 8);
  const u8 *entry = cart_base + table_off;
  for (u16 i = 0; i < count; i++, entry += PJGB_CHUNK_ENTRY_SIZE) {
    u32 k = *(const u32 *)(entry + 0);
    u32 eid = *(const u32 *)(entry + 4);
    if (k == kind && eid == id) {
      u32 off = *(const u32 *)(entry + 8);
      u32 sz = *(const u32 *)(entry + 12);
      if (out_size) *out_size = sz;
      return cart_base + off;
    }
  }
  if (out_size) *out_size = 0;
  return 0;
}
