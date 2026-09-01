#include <assert.h>
#include <stdint.h>

#include "../framebuffer.h"
#include "../input.h"
#include "../../iphone2g/pocket_spec.h"

static void framebuffer_test(void) {
  const uint8_t bgra[] = {
    0x00, 0x00, 0xff, 0xff,
    0x00, 0xff, 0x00, 0xff,
    0xff, 0x00, 0x00, 0xff,
    0xff, 0xff, 0xff, 0xff,
  };
  uint16_t rgb565[4] = {0};
  rockbox_bgra_to_rgb565(rgb565, bgra, 4);
  assert(rgb565[0] == 0xf800u);
  assert(rgb565[1] == 0x07e0u);
  assert(rgb565[2] == 0x001fu);
  assert(rgb565[3] == 0xffffu);
}

static void input_test(void) {
  const RockboxInputCodes codes = {
    .select = 1 << 0,
    .menu = 1 << 1,
    .left = 1 << 2,
    .right = 1 << 3,
    .scroll_forward = 1 << 4,
    .scroll_back = 1 << 5,
    .play = 1 << 6,
    .repeat = 1 << 7,
  };
  assert(rockbox_input_buttons(codes.select, 0, &codes) == POCKET_BTN_CIRCLE);
  assert(rockbox_input_buttons(0, codes.scroll_forward, &codes) == POCKET_BTN_DOWN);
  assert(rockbox_input_buttons(0, codes.scroll_back, &codes) == POCKET_BTN_UP);
  assert(rockbox_input_buttons(codes.left | codes.play, 0, &codes) ==
         (POCKET_BTN_LEFT | POCKET_BTN_START));
  assert(rockbox_input_exit_requested(codes.menu | codes.repeat, &codes));
  assert(!rockbox_input_exit_requested(codes.menu, &codes));
}

int main(void) {
  framebuffer_test();
  input_test();
  return 0;
}
