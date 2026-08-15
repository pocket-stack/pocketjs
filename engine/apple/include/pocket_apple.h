// pocket-apple C ABI — the PocketJS guest + ui surface + software rasterizer
// (engine/apple/src/lib.rs). Single-threaded: create, drive, and destroy a
// handle from one thread (in practice the main thread, with CADisplayLink).
//
// Call order per handle:
//   create -> load_pak* -> [set_identity] -> [set_tick_rate] -> eval_bundle
//   -> per tick: frame, render -> destroy
// load_pak/set_identity/set_tick_rate are all rejected after eval_bundle:
// the surface publishes them to the guest when `ui` is mounted (the rate as
// ui.__tickHz), and the bundle's mount-time animate() calls convert ms to
// frames at the rate in force while it evaluates.

#ifndef POCKET_APPLE_H
#define POCKET_APPLE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define POCKET_APPLE_MAX_DAMAGE_REGIONS 8

typedef struct PocketApple PocketApple;

// One rendered frame. `pixels` is ARGB32 words — BGRA byte order in memory on
// little-endian, i.e. kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst.
// The pointer stays valid until the next render/destroy on the same handle.
typedef struct PocketAppleFrame {
  const uint8_t *pixels;
  uint32_t width_px;
  uint32_t height_px;
  uint32_t stride_bytes;
  // Repaint rects in pixel coordinates as x, y, w, h. region_count == 0 means
  // nothing changed this frame; previous contents are still current.
  int32_t regions[POCKET_APPLE_MAX_DAMAGE_REGIONS][4];
  uint32_t region_count;
  int32_t full_redraw;
} PocketAppleFrame;

uint32_t pocket_apple_abi_version(void);

// Last failure message for this thread; valid until the next failing call.
const char *pocket_apple_last_error(void);

// density is the raster scale (1..4); logical viewport is in pocketjs units
// (hero is 480x272). Returns NULL on failure.
PocketApple *pocket_apple_create(uint32_t density, uint32_t logical_width,
                                 uint32_t logical_height);

int32_t pocket_apple_set_identity(PocketApple *handle, const char *host_id,
                                  uint32_t host_abi);

// Ticks per second of guest virtual time (1..240, default 60); rejected
// after eval_bundle — the mount publishes it as ui.__tickHz and bundles
// refuse a rate other than the one they were built for. The display link
// must be driven at the same rate.
int32_t pocket_apple_set_tick_rate(PocketApple *handle, uint32_t hz);

int32_t pocket_apple_load_pak(PocketApple *handle, const uint8_t *bytes,
                              size_t length);

// Mounts `ui` on first call, evaluates the bundle, and requires it to install
// globalThis.frame. `label` may be NULL ("app").
int32_t pocket_apple_eval_bundle(PocketApple *handle, const uint8_t *source,
                                 size_t length, const char *label);

// touches: up to 8 packed words in logical coordinates. Legacy words carry
// x:9, y:9, id:8 with bit 31 clear. Wide words set bit 31 and carry x:10,
// y:10, id:8. A contact present this tick means down/move, absent means
// released. The Apple core resolves and carries the committed-frame hit fact
// for each contact and delivers it as frame() argument 4. analog 0 means
// centered (0x8080).
int32_t pocket_apple_frame(PocketApple *handle, uint32_t buttons,
                           uint32_t analog, const uint32_t *touches,
                           size_t touch_count);

int32_t pocket_apple_render(PocketApple *handle, PocketAppleFrame *out);

// Logical coordinates; returns the hit node id or 0.
int32_t pocket_apple_hit_test_bounds(PocketApple *handle, float x, float y);

// Guest -> host effect sink: lines the guest's effect driver svcSend()s
// (JSON by convention), delivered synchronously during pocket_apple_frame on
// the calling thread. context must outlive the registration.
typedef void (*PocketAppleEffectCallback)(const char *line, void *context);
int32_t pocket_apple_set_effect_callback(PocketApple *handle,
                                         PocketAppleEffectCallback callback,
                                         void *context);

// Host -> guest: queue one line for the guest's next svcPoll (delivered at a
// frame boundary, never mid-tick).
int32_t pocket_apple_post_event(PocketApple *handle, const char *line);

void pocket_apple_destroy(PocketApple *handle);

// ---- external-guest mode ---------------------------------------------------
// The embedding runtime owns the JS guest; this side owns only the core, the
// pak feed, the raster pipeline, and the svc queues. Mount globalThis.ui in
// the embedding engine over these ops. Same single-thread rules.

typedef struct PocketAppleCore PocketAppleCore;

PocketAppleCore *pocket_apple_core_create(uint32_t density, uint32_t logical_width,
                                          uint32_t logical_height);
int32_t pocket_apple_core_load_pak(PocketAppleCore *handle, const uint8_t *bytes,
                                   size_t length);

int32_t pocket_apple_core_create_node(PocketAppleCore *handle, uint32_t node_type);
void pocket_apple_core_destroy_node(PocketAppleCore *handle, int32_t id);
void pocket_apple_core_insert_before(PocketAppleCore *handle, int32_t parent, int32_t child,
                                     int32_t anchor);
void pocket_apple_core_remove_child(PocketAppleCore *handle, int32_t parent, int32_t child);
void pocket_apple_core_set_style(PocketAppleCore *handle, int32_t id, int32_t style);
void pocket_apple_core_set_prop(PocketAppleCore *handle, int32_t id, uint32_t prop, double value);
void pocket_apple_core_set_text(PocketAppleCore *handle, int32_t id, const uint8_t *text,
                                size_t length);
void pocket_apple_core_replace_text(PocketAppleCore *handle, int32_t id, const uint8_t *text,
                                    size_t length);
float pocket_apple_core_measure_text(PocketAppleCore *handle, const uint8_t *text, size_t length,
                                     uint32_t font_slot);
int32_t pocket_apple_core_upload_texture(PocketAppleCore *handle, const uint8_t *bytes,
                                         size_t length, uint32_t width, uint32_t height,
                                         uint32_t psm);
void pocket_apple_core_set_image(PocketAppleCore *handle, int32_t id, int32_t texture);
void pocket_apple_core_set_sprite(PocketAppleCore *handle, int32_t id, int32_t atlas,
                                  uint32_t frames, uint32_t cols, uint32_t step);
int32_t pocket_apple_core_animate(PocketAppleCore *handle, int32_t id, uint32_t prop, double to,
                                  uint32_t duration_ms, uint32_t easing, uint32_t delay_ms);
void pocket_apple_core_cancel_anim(PocketAppleCore *handle, int32_t anim_id);
void pocket_apple_core_set_focus(PocketAppleCore *handle, int32_t id);
void pocket_apple_core_set_active(PocketAppleCore *handle, int32_t id, int32_t active);
int32_t pocket_apple_core_hit_test_bounds(PocketAppleCore *handle, float x, float y);

uint32_t pocket_apple_core_texture_count(PocketAppleCore *handle);
const char *pocket_apple_core_texture_name(PocketAppleCore *handle, uint32_t index);
int32_t pocket_apple_core_texture_handle(PocketAppleCore *handle, uint32_t index);
uint32_t pocket_apple_core_sprite_count(PocketAppleCore *handle);
const char *pocket_apple_core_sprite_name(PocketAppleCore *handle, uint32_t index);
// out must hold 4 int32: handle, frames, cols, step.
int32_t pocket_apple_core_sprite_info(PocketAppleCore *handle, uint32_t index, int32_t *out);

void pocket_apple_core_svc_send(PocketAppleCore *handle, const uint8_t *text, size_t length);
// Newline-joined batch or NULL; valid until the next poll on this handle.
const char *pocket_apple_core_svc_poll(PocketAppleCore *handle);
int32_t pocket_apple_core_post_event(PocketAppleCore *handle, const char *line);
void pocket_apple_core_drain_effects(PocketAppleCore *handle, PocketAppleEffectCallback callback,
                                     void *context);

// Ticks per second of the core's virtual time (1..240, default 60); rejected
// after the first core_animate or tick — animate converts ms to frames at
// the rate then in force, so declare the rate before the guest evaluates,
// and declare it on the mounted namespace as ui.__tickHz. Same
// bundle/display-link pairing as the guest mode.
int32_t pocket_apple_core_set_tick_rate(PocketAppleCore *handle, uint32_t hz);

void pocket_apple_core_tick(PocketAppleCore *handle);
int32_t pocket_apple_core_render(PocketAppleCore *handle, PocketAppleFrame *out);
void pocket_apple_core_destroy(PocketAppleCore *handle);

#ifdef __cplusplus
}
#endif

#endif // POCKET_APPLE_H
