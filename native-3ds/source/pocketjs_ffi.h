// pocketjs_ffi.h — C declarations for the Rust bridge (native-3ds/ffi, crate
// pocketjs-3ds-ffi). scripts/3ds.ts cross-compiles that crate for
// armv6k-nintendo-3ds and the Makefile links libpocketjs_3ds_ffi.a. Signatures
// mirror src/host.ts HostOps + the spec op ids; keep them in sync with
// native-3ds/ffi/src/lib.rs.
#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void    pj_init(void);
uint32_t pj_screen_w(void);
uint32_t pj_screen_h(void);

// op mirror (DESIGN.md "The native contract")
int32_t pj_create_node(uint32_t node_type);
void    pj_destroy_node(int32_t id);
void    pj_insert_before(int32_t parent, int32_t child, int32_t anchor);
void    pj_remove_child(int32_t parent, int32_t child);
void    pj_set_style(int32_t id, int32_t style_id);
void    pj_set_prop(int32_t id, uint32_t prop, double value);
void    pj_set_text(int32_t id, const uint8_t *ptr, size_t len);
void    pj_replace_text(int32_t id, const uint8_t *ptr, size_t len);
int32_t pj_upload_texture(const uint8_t *ptr, size_t len, uint32_t w, uint32_t h, uint32_t psm);
void    pj_set_image(int32_t id, int32_t tex);
int32_t pj_animate(int32_t id, uint32_t prop, double to, uint32_t dur_ms, uint32_t easing, uint32_t delay_ms);
void    pj_cancel_anim(int32_t anim_id);
void    pj_set_focus(int32_t id);
int32_t pj_load_styles(const uint8_t *ptr, size_t len);
int32_t pj_load_font_atlas(const uint8_t *ptr, size_t len);
float   pj_measure_text(const uint8_t *ptr, size_t len, uint32_t font_slot);

// frame
void          pj_tick(void);
const uint8_t *pj_render(void);   // RGBA8 SCREEN_W*SCREEN_H*4, row-major, top-left

// asset pack (native feed, parity with native/src/pak.rs)
int32_t pj_feed_pak(const uint8_t *ptr, size_t len);
int32_t pj_texture_count(void);
int32_t pj_texture_handle(int32_t i);
int32_t pj_texture_name(int32_t i, uint8_t *out, size_t cap);

#ifdef __cplusplus
}
#endif
