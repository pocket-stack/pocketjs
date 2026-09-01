#ifndef POCKETJS_ROCKBOX_FRAMEBUFFER_H
#define POCKETJS_ROCKBOX_FRAMEBUFFER_H

#include <stddef.h>
#include <stdint.h>

void rockbox_bgra_to_rgb565(uint16_t *out, const uint8_t *bgra, size_t pixels);

#endif
