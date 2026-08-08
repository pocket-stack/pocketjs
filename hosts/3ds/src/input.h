#ifndef POCKETJS_3DS_INPUT_H
#define POCKETJS_3DS_INPUT_H

#include <stdint.h>

/* The frame contract's two arguments (contracts/spec/spec.ts). `buttons` is
 * the PSP BTN bitmask, identical on every host; `analog` packs the left stick
 * as (x << 8) | y with 128 the centre of each axis. Call hidScanInput() once
 * per frame before either. */
int32_t input_buttons(void);
int32_t input_analog(void);

#endif
