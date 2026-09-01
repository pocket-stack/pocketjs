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
int pocket_runtime_boot_bytecode(
  const uint8_t *bytecode,
  size_t bytecode_length,
  const uint8_t *pack,
  size_t pack_length,
  int width,
  int height
);
/* `pack` is borrowed by QuickJS and must remain valid until shutdown. */
/*
 * One guest turn followed by exactly one core tick — the frame contract
 * (docs/RUNTIMES.md, law 3). Hosts call it once per presented frame with the
 * portable button mask (pocket_spec.h) and the sampled touch contact in
 * logical pixels; `touch_hit` is the host-resolved bounds hit for that
 * contact (pocket_runtime_hit_test_bounds) or zero.
 */
typedef struct {
  uint32_t buttons;
  int touch_down;
  int touch_x;
  int touch_y;
  int touch_hit;
} PocketRuntimeInput;
int pocket_runtime_tick(const PocketRuntimeInput *input);
/* Button + analog-only entry for hosts with a wheel/stick and no touch. */
int pocket_runtime_tick_analog(uint32_t buttons, uint32_t analog);
int pocket_runtime_frame_analog(
  uint32_t buttons,
  uint32_t analog,
  unsigned int tick_count
);

/*
 * Multi-contact frame entry. `id` is the host's contact slot (0-255, stable
 * while the finger stays down, reusable after release), `x`/`y` are logical
 * pixels, and `hit` is the bounds hit resolved once at the contact's down
 * edge (pocket_runtime_hit_test_bounds) or zero. Contacts pack into the
 * frame() wire words — legacy x:9/y:9/id:8 below 512 logical pixels, the
 * wide bit-31 form above — so a single id-0 contact is byte-identical to the
 * single-touch entry points and every existing tape. The guest snapshot caps
 * at eight contacts (framework/src/touch.ts).
 */
#define POCKET_RUNTIME_MAX_CONTACTS 8
typedef struct {
  int id;
  int x;
  int y;
  int hit;
} PocketRuntimeContact;
typedef struct {
  uint32_t buttons;
  unsigned int contact_count;
  PocketRuntimeContact contacts[POCKET_RUNTIME_MAX_CONTACTS];
} PocketRuntimeContactsInput;
int pocket_runtime_tick_contacts(const PocketRuntimeContactsInput *input);
int pocket_runtime_frame_contacts(
  const PocketRuntimeContactsInput *input,
  unsigned int tick_count
);

/*
 * Legacy frame entry points for the original iPhone host, which presents at
 * 30 Hz and advances two core ticks per guest turn, and for the Windows CE
 * host's tick-count form. They pass an empty button mask. New hosts call
 * pocket_runtime_tick.
 */
int pocket_runtime_frame(int touch_down, int touch_x, int touch_y, int touch_hit);
int pocket_runtime_frame_ticks(
  int touch_down,
  int touch_x,
  int touch_y,
  int touch_hit,
  unsigned int tick_count
);
int pocket_runtime_hit_test(float x, float y);
int pocket_runtime_hit_test_bounds(float x, float y);
const char *pocket_runtime_action_name(void);
int pocket_runtime_action_value(void);
unsigned long pocket_runtime_action_sequence(void);
/*
 * Rendered pixels are opaque top-left BGRA bytes (ARGB32 words). The pointer
 * remains valid only until the next render, viewport change, or shutdown.
 */
const uint8_t *pocket_runtime_render(void);
/* Render directly into a persistent, tightly packed host-owned RGB565 buffer. */
int pocket_runtime_render_rgb565(uint16_t *framebuffer, size_t pixel_count);

/*
 * Damage statistics for the software raster path, and the most recent plan's
 * bounds so the host can scope its composite. `bounds` receives x0,y0,x1,y1 in
 * logical pixels, top-left origin; the return is zero when nothing changed.
 */
unsigned long pocket_runtime_damage_attempts(void);
unsigned long pocket_runtime_damage_failures(void);
unsigned long pocket_runtime_damage_full_redraws(void);
unsigned long pocket_runtime_damage_pixels(void);
int pocket_runtime_damage_bounds(int *bounds);

/*
 * Hardware path. `pocket_runtime_gl_initialize` needs a current OpenGL ES
 * context matching the core backend selected at compile time and returns zero
 * if the GPU pipeline cannot be established.
 * `pocket_runtime_gl_render` draws the current retained tree into the bound
 * framebuffer; the CPU never rasterizes a pixel on this path.
 */
int pocket_runtime_gl_initialize(void);
void pocket_runtime_gl_reset(void);
int pocket_runtime_gl_render(int width, int height);
void pocket_runtime_gl_shutdown(void);

uint32_t pocket_runtime_width(void);
uint32_t pocket_runtime_height(void);
uint32_t pocket_runtime_stride(void);
size_t pocket_runtime_length(void);
const char *pocket_runtime_error(void);
void pocket_runtime_shutdown(void);

#endif
