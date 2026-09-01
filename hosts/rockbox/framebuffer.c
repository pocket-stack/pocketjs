#include "framebuffer.h"

void rockbox_bgra_to_rgb565(uint16_t *out, const uint8_t *bgra, size_t pixels) {
  size_t index;
  if (out == 0 || bgra == 0) return;
  for (index = 0; index < pixels; ++index) {
    const uint8_t blue = bgra[index * 4u];
    const uint8_t green = bgra[index * 4u + 1u];
    const uint8_t red = bgra[index * 4u + 2u];
    out[index] = (uint16_t)(((uint16_t)(red & 0xf8u) << 8u) |
                            ((uint16_t)(green & 0xfcu) << 3u) |
                            ((uint16_t)blue >> 3u));
  }
}
