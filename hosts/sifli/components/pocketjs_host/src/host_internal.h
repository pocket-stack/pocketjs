/* Internal contracts between the host's translation units. */
#ifndef POCKETJS_HOST_INTERNAL_H
#define POCKETJS_HOST_INTERNAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocket_core.h"
#include "pocketjs_host.h"

/* host_heap.c */
bool pocketjs_heap_open(void);

/* host_lcd.c */
bool pocketjs_lcd_open(void);
uint16_t *pocketjs_lcd_framebuffer(uint32_t index);
void pocketjs_lcd_present(uint16_t *framebuffer);

/* host_input.c */
typedef struct
{
    uint32_t buttons;
    uint32_t touch;       /* packed wide contact, valid when touch_count == 1 */
    size_t touch_count;
    bool home_request;    /* long KEY1 while a guest other than the launcher runs */
} PocketjsInputFrame;

void pocketjs_input_open(void);
void pocketjs_input_poll(PocketjsInputFrame *frame, bool launcher_active);

/* host_guest.c */
typedef bool (*PocketjsLaunchHandler)(const char *output, size_t output_len,
                                      void *context);

void pocketjs_guest_set_launch_handler(PocketjsLaunchHandler handler, void *context);
bool pocketjs_guest_mount(const PocketjsGuest *guest);
void pocketjs_guest_unmount(void);
bool pocketjs_guest_frame(uint32_t buttons, const uint32_t *touches, size_t touch_count);
bool pocketjs_guest_render(uint16_t *framebuffer, size_t pixel_count, uint32_t target_index,
                           PocketRenderStats *stats);
bool pocketjs_guest_render_software(uint16_t *framebuffer, size_t pixel_count);
uint64_t pocketjs_guest_draw_hash(void);
size_t pocketjs_guest_js_heap_bytes(void);

/* host_selfcheck.c */
uint32_t pocketjs_crc32(const void *data, size_t len);
void pocketjs_frame_crc(uint32_t frame, const uint16_t *framebuffer, uint64_t draw_hash);
void pocketjs_selfcheck_frame(uint32_t frame, const uint16_t *hardware,
                              const PocketRenderStats *stats, uint32_t vglite_commands);

/* host_main.c */
void pocketjs_host_fatal(const char *message);

#endif
