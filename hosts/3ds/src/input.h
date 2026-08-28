#ifndef POCKETJS_3DS_INPUT_H
#define POCKETJS_3DS_INPUT_H

#include <stddef.h>
#include <stdint.h>

/* The frame contract's two arguments (contracts/spec/spec.ts). `buttons` is
 * the PSP BTN bitmask, identical on every host; `analog` packs the left stick
 * as (x << 8) | y with 128 the centre of each axis. Call hidScanInput() once
 * per frame before either. */
int32_t input_buttons(void);
int32_t input_analog(void);
/** Read the bottom-screen contact in its own 320x240 logical space. Returns
 * 1 while down and writes one legacy-packed touch word, else 0. */
size_t input_touch(uint32_t *packed);

#endif
