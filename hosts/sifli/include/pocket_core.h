/*
 * PocketJS core C ABI for the SiFli host, exported by the `pocketjs-sifli`
 * staticlib (hosts/sifli/rust). The host owns QuickJS, input, and the
 * framebuffers; the core owns the retained tree, layout, animation, the
 * DrawList, and the hybrid EPIC/VG Lite renderer.
 *
 * PocketRenderStats grows append-only so older hosts keep reading the
 * fields they know.
 */
#ifndef POCKET_CORE_H
#define POCKET_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

typedef struct PocketCore PocketCore;

typedef struct
{
    uint32_t draw_words;
    uint32_t damage_regions;
    uint32_t damage_pixels;
    uint32_t full_redraw;
    uint32_t full_redraw_promoted;
    uint32_t glyph_misses;
    uint32_t epic_fills;
    uint32_t epic_gradients;
    uint32_t epic_blends;
    uint32_t epic_copies;
    uint32_t software_ops;
    uint32_t software_words;
    uint32_t fences;
    uint32_t cpu_tiles;
    uint32_t cpu_tile_pixels;
    uint32_t mask_bands;
} PocketRenderStats;

/* Largest number of persistent framebuffers one core tracks damage for. */
#define POCKET_CORE_MAX_TARGETS 4u

PocketCore *pocket_core_create(uint32_t logical_width, uint32_t logical_height,
                               uint32_t scale, uint32_t raster_density,
                               uint32_t target_count);
void pocket_core_destroy(PocketCore *handle);
int32_t pocket_core_set_tick_rate(PocketCore *handle, uint32_t hz);

int32_t pocket_core_load_styles(PocketCore *handle, const uint8_t *data,
                                size_t len);
int32_t pocket_core_load_font_atlas(PocketCore *handle, const uint8_t *data,
                                    size_t len);
int32_t pocket_core_upload_img_entry(PocketCore *handle, const uint8_t *data,
                                     size_t len);
int32_t pocket_core_upload_texture(PocketCore *handle, const uint8_t *data,
                                   size_t len, uint32_t width, uint32_t height,
                                   uint32_t psm);
void pocket_core_free_texture(PocketCore *handle, int32_t texture);

/* Content revision of a live texture, the key a native (.epic) copy is
 * registered under with pocketjs_gpu_texture_register(); UINT64_MAX when
 * `texture` is not live. */
uint64_t pocket_core_texture_revision(PocketCore *handle, int32_t texture);

int32_t pocket_core_create_node(PocketCore *handle, uint32_t node_type);
void pocket_core_destroy_node(PocketCore *handle, int32_t id);
void pocket_core_insert_before(PocketCore *handle, int32_t parent,
                               int32_t child, int32_t anchor);
void pocket_core_remove_child(PocketCore *handle, int32_t parent,
                              int32_t child);
void pocket_core_set_style(PocketCore *handle, int32_t id, int32_t style_id);
void pocket_core_set_prop(PocketCore *handle, int32_t id, uint32_t prop,
                          double value);
void pocket_core_set_text(PocketCore *handle, int32_t id, const uint8_t *data,
                          size_t len);
void pocket_core_replace_text(PocketCore *handle, int32_t id,
                              const uint8_t *data, size_t len);
float pocket_core_measure_text(PocketCore *handle, const uint8_t *data,
                               size_t len, uint32_t font_slot);
void pocket_core_set_image(PocketCore *handle, int32_t id, int32_t texture);
void pocket_core_set_sprite(PocketCore *handle, int32_t id, int32_t atlas,
                            uint32_t frames, uint32_t cols, uint32_t step);
int32_t pocket_core_animate(PocketCore *handle, int32_t id, uint32_t prop,
                            double to, uint32_t duration_ms, uint32_t easing,
                            uint32_t delay_ms);
void pocket_core_cancel_anim(PocketCore *handle, int32_t animation);
void pocket_core_set_focus(PocketCore *handle, int32_t id);
void pocket_core_set_active(PocketCore *handle, int32_t id, int32_t active);
int32_t pocket_core_hit_test(PocketCore *handle, float x, float y);
int32_t pocket_core_hit_test_bounds(PocketCore *handle, float x, float y);
size_t pocket_core_touch_hits(PocketCore *handle, const uint32_t *packed,
                              size_t count, int32_t *out);
void pocket_core_set_cursor(PocketCore *handle, int32_t texture, float hot_x,
                            float hot_y, float width, float height);
void pocket_core_set_cursor_pos(PocketCore *handle, float x, float y);

void pocket_core_tick(PocketCore *handle);

/* Render the current DrawList into persistent framebuffer `target_index`
 * through the GPU command queue (pocketjs_gpu.h), repainting only the
 * damage since that framebuffer was last presented. Returns 0 on success. */
int32_t pocket_core_render_rgb565(PocketCore *handle, uint16_t *framebuffer,
                                  size_t pixel_count, uint32_t target_index,
                                  PocketRenderStats *out_stats);

/* Render the current DrawList with the core's software rasterizer into a
 * scratch buffer that is not damage tracked (device self-check and CRC
 * parity). Returns 0 on success. */
int32_t pocket_core_render_rgb565_software(PocketCore *handle,
                                           uint16_t *framebuffer,
                                           size_t pixel_count);

/* FNV-1a hash of the current DrawList words: a cheap frame identity for
 * logs and parity tooling. */
uint64_t pocket_core_draw_hash(PocketCore *handle);

void pocket_core_debug_inspect(PocketCore *handle, int32_t id);
int32_t pocket_core_debug_rect_xy(PocketCore *handle);
int32_t pocket_core_debug_rect_wh(PocketCore *handle);
void pocket_core_debug_pause(PocketCore *handle, int32_t on);
void pocket_core_debug_step(PocketCore *handle);

#ifdef __cplusplus
}
#endif

#endif
