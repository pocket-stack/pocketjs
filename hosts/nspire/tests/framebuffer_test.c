#include <assert.h>
#include <stdint.h>

#include "../framebuffer.h"

int main(void) {
  const uint8_t pixels[] = {
    0, 0, 0, 255,
    255, 255, 255, 255,
    0, 0, 255, 255,
    0, 255, 0, 255,
    255, 0, 0, 255,
  };
  uint16_t out[5] = {0};
  nspire_bgra_to_rgb565(out, pixels, 5);
  assert(out[0] == 0x0000);
  assert(out[1] == 0xffff);
  assert(out[2] == 0xf800);
  assert(out[3] == 0x07e0);
  assert(out[4] == 0x001f);
  return 0;
}
