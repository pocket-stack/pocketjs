#ifndef POCKET_OFFLOAD_COVERAGE_H
#define POCKET_OFFLOAD_COVERAGE_H
#include <stdint.h>
#include <stddef.h>
#include <string.h>
static inline int coverage_digit(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  return c == '+' ? 62 : c == '/' ? 63 : -1;
}
/* Maximum envelope 512x16 RGBA. The caller owns one reusable scratch buffer.
 * Input is 2-bit alpha, four pixels per byte, low bits first. */
static inline int coverage_decode(const char *base64, size_t length, unsigned width, unsigned height, uint32_t color, uint8_t *rgba) {
  if (!width || width > 512 || width % 4 || !height || height > 16) return 0;
  unsigned count = width * height, bytes = count / 4;
  if (length != ((bytes + 2) / 3) * 4) return 0;
  unsigned envelope = 8; while (envelope < width) envelope *= 2;
  memset(rgba, 0, 512 * 16 * 4);
  unsigned pixel = 0;
  for (size_t i = 0; i < length; i += 4) {
    uint32_t value = 0;
    for (unsigned j = 0; j < 4; j++) {
      int digit = coverage_digit(base64[i + j]);
      if (digit < 0) {
        if (base64[i + j] != '=' || i + 4 != length || j < 2) return 0;
        digit = 0;
      }
      value = (value << 6) | (unsigned)digit;
    }
    for (int byte = 2; byte >= 0 && pixel < count; byte--) {
      unsigned packed = (value >> (byte * 8)) & 255;
      for (unsigned part = 0; part < 4; part++, pixel++) {
        uint8_t *p = rgba + ((pixel / width) * envelope + pixel % width) * 4;
        p[0] = color; p[1] = color >> 8; p[2] = color >> 16;
        p[3] = ((packed >> (part * 2)) & 3) * 85;
      }
    }
  }
  return (int)envelope;
}
#endif
