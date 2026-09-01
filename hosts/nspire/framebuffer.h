#ifndef POCKETJS_NSPIRE_FRAMEBUFFER_H
#define POCKETJS_NSPIRE_FRAMEBUFFER_H

#include <stddef.h>
#include <stdint.h>

#define NSPIRE_SCREEN_WIDTH 320u
#define NSPIRE_SCREEN_HEIGHT 240u
#define NSPIRE_SCREEN_PIXELS (NSPIRE_SCREEN_WIDTH * NSPIRE_SCREEN_HEIGHT)

/* PocketJS software frames are top-left BGRA bytes. Ndless consumes RGB565. */
void nspire_bgra_to_rgb565(uint16_t *out, const uint8_t *bgra, size_t pixels);

#endif
