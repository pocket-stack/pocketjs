#ifndef POCKETJS_IPHONE2G_RUNTIME_H
#define POCKETJS_IPHONE2G_RUNTIME_H

#include <stddef.h>
#include <stdint.h>

int pocket_runtime_boot(
  const char *java_script,
  size_t java_script_length,
  const uint8_t *pack,
  size_t pack_length,
  int width,
  int height
);
/* `pack` is borrowed by QuickJS and must remain valid until shutdown. */
int pocket_runtime_frame(int touch_down, int touch_x, int touch_y, int touch_hit);
int pocket_runtime_hit_test(float x, float y);
int pocket_runtime_hit_test_bounds(float x, float y);
const char *pocket_runtime_action_name(void);
int pocket_runtime_action_value(void);
unsigned long pocket_runtime_action_sequence(void);
const uint8_t *pocket_runtime_render(void);
/*
 * Rendered pixels are opaque top-left BGRA bytes (ARGB32 words). The pointer
 * remains valid only until the next render, viewport change, or shutdown.
 */

/*
 * Hardware path. `pocket_runtime_gl_initialize` needs a current OpenGL ES 1.1
 * context and returns zero if the GPU pipeline cannot be established, which is
 * the host's signal to keep using the software rasterizer above.
 * `pocket_runtime_gl_render` draws the current retained tree into the bound
 * framebuffer; the CPU never rasterizes a pixel on this path.
 */
int pocket_runtime_gl_initialize(void);
int pocket_runtime_gl_render(int width, int height);
void pocket_runtime_gl_shutdown(void);

uint32_t pocket_runtime_width(void);
uint32_t pocket_runtime_height(void);
uint32_t pocket_runtime_stride(void);
size_t pocket_runtime_length(void);
const char *pocket_runtime_error(void);
void pocket_runtime_shutdown(void);

#endif
