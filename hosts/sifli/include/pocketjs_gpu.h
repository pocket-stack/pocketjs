/*
 * PocketJS SiFli GPU command queue — the C ABI the `pocketjs-sifli` Rust
 * crate submits render commands through. Implemented by
 * components/pocketjs_gpu over the SiFli HAL (EPIC) and, on SF32LB58 with
 * USING_VGLITE, VG Lite. Every rectangle is in physical pixels of the target
 * bound by pocketjs_gpu_begin(); texture bytes referenced by a command stay
 * valid until the next fence.
 *
 * Layouts are mirrored by `hosts/sifli/rust/src/gpu.rs`; both sides assert
 * the struct sizes, so change them together.
 */
#ifndef POCKETJS_GPU_H
#define POCKETJS_GPU_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

#define POCKETJS_GPU_ABI_VERSION 1u

/* Capability flags. */
#define POCKETJS_GPU_CAP_FILL_OPAQUE       (1u << 0)
#define POCKETJS_GPU_CAP_FILL_ALPHA        (1u << 1)
#define POCKETJS_GPU_CAP_A8_BLEND          (1u << 2)
#define POCKETJS_GPU_CAP_GRADIENT          (1u << 3)
#define POCKETJS_GPU_CAP_COPY_PSM5650      (1u << 4)
#define POCKETJS_GPU_CAP_DIRECT_CPU_WRITES (1u << 5)
#define POCKETJS_GPU_CAP_BLIT_NATIVE       (1u << 6) /* axis-aligned blits of registered textures */
#define POCKETJS_GPU_CAP_BLIT_QUAD_NATIVE  (1u << 7) /* four-point blits of registered textures */
#define POCKETJS_GPU_CAP_BLIT_MODULATE     (1u << 8) /* blits honour the RGB modulate color */

/* Texture format bits (PocketJS portable layouts). */
#define POCKETJS_GPU_FORMAT_PSM5650  (1u << 0) /* RGB565, red in the low bits */
#define POCKETJS_GPU_FORMAT_RGBA8888 (1u << 1) /* R, G, B, A bytes           */
#define POCKETJS_GPU_FORMAT_T8CLUT   (1u << 2) /* 8-bit index + ABGR palette */

typedef struct
{
    uint32_t abi_version;      /* POCKETJS_GPU_ABI_VERSION */
    uint32_t flags;            /* POCKETJS_GPU_CAP_* */
    uint32_t blit_formats;     /* POCKETJS_GPU_FORMAT_* for axis-aligned blits */
    uint32_t blit_quad_formats;/* POCKETJS_GPU_FORMAT_* for four-point quads */
    uint32_t coordinate_limit; /* largest extent per axis; UINT32_MAX = none */
    uint32_t mask_tile_bytes;  /* bytes per A8 plane; 0 = target sized */
    uint32_t cpu_tile_pixels;  /* pixels per RGB565 tile for CPU fallback */
    uint32_t min_fill;         /* thresholds in physical pixels */
    uint32_t min_gradient;
    uint32_t min_blend;
    uint32_t min_blit;
} PocketjsGpuCaps;

/* Command opcodes. */
#define POCKETJS_GPU_OP_FILL       1u
#define POCKETJS_GPU_OP_FILL_ALPHA 2u
#define POCKETJS_GPU_OP_BLEND_A8   3u
#define POCKETJS_GPU_OP_GRADIENT   4u
#define POCKETJS_GPU_OP_BLIT       5u
#define POCKETJS_GPU_OP_BLIT_QUAD  6u
#define POCKETJS_GPU_OP_TILE_OUT   7u
#define POCKETJS_GPU_OP_TILE_IN    8u
#define POCKETJS_GPU_OP_FENCE      9u

/* Command flags. */
#define POCKETJS_GPU_FLAG_MIRROR_X (1u << 0)
#define POCKETJS_GPU_FLAG_MIRROR_Y (1u << 1)
#define POCKETJS_GPU_FLAG_LINEAR   (1u << 2)

/* Texture source kinds. */
#define POCKETJS_GPU_SRC_PORTABLE 0u
#define POCKETJS_GPU_SRC_NATIVE   1u
#define POCKETJS_GPU_SRC_SOLID    2u

/* Texture source formats (values, not bits). */
#define POCKETJS_GPU_PIXEL_PSM5650  0u
#define POCKETJS_GPU_PIXEL_RGBA8888 1u
#define POCKETJS_GPU_PIXEL_T8CLUT   2u

/* Target kinds for pocketjs_gpu_begin(). */
#define POCKETJS_GPU_TARGET_FRAMEBUFFER 0u
#define POCKETJS_GPU_TARGET_STRIP       1u

typedef struct
{
    uint32_t x, y, w, h;
} PocketjsGpuRect;

typedef struct
{
    int32_t x, y;
} PocketjsGpuPoint;

typedef struct
{
    uint32_t op;                /* POCKETJS_GPU_OP_* */
    uint32_t flags;             /* POCKETJS_GPU_FLAG_* */
    PocketjsGpuRect dst;        /* fill/blend/gradient/blit destination, TILE_IN dst */
    PocketjsGpuRect clip;       /* blit/quad write clip, TILE_OUT source */
    PocketjsGpuRect src;        /* texture source rectangle in texels */
    PocketjsGpuPoint quad[4];   /* BLIT_QUAD: TL, BL, BR, TR */
    uint32_t color;             /* ABGR: fill color + alpha, blend color + global alpha, blit modulate */
    uint32_t corners[4];        /* GRADIENT: TL, TR, BL, BR (ABGR) */
    uint32_t src_kind;          /* POCKETJS_GPU_SRC_* */
    uint32_t src_id;            /* native texture id, or solid ABGR */
    const uint8_t *src_pixels;  /* portable texels */
    size_t src_len;
    const uint8_t *src_palette; /* 1024-byte ABGR palette for T8 */
    uint32_t src_width;
    uint32_t src_height;
    uint32_t src_format;        /* POCKETJS_GPU_PIXEL_* */
    uint32_t mask_id;           /* BLEND_A8 plane */
    uint32_t mask_offset;       /* byte offset of the rectangle's top-left */
    uint32_t mask_stride;       /* bytes per plane row */
    uint32_t tile_id;           /* TILE_OUT / TILE_IN */
} PocketjsGpuCmd;

/* Fill `out` with this build's capabilities. Returns 0 on success. */
int pocketjs_gpu_caps(PocketjsGpuCaps *out);

/* Bind `target` (`width * height` RGB565 pixels) for one frame or strip.
 * Returns 0 on success. */
int pocketjs_gpu_begin(uint16_t *target, size_t pixels, uint32_t width,
                       uint32_t height, uint32_t kind);

/* Run `count` commands in order after every earlier command. Returns 0, or
 * -(index + 1) for the first command that was not admitted, or
 * POCKETJS_GPU_FAILED when the driver failed. */
#define POCKETJS_GPU_FAILED (-0x7fff)
int pocketjs_gpu_submit(const PocketjsGpuCmd *cmds, size_t count);

/* Complete every submitted command. Returns 0 on success. */
int pocketjs_gpu_fence(void);

/* Complete everything and release the target. Returns 0 on success. */
int pocketjs_gpu_end(void);

/* CPU-writable A8 plane `id` (at least mask_tile_bytes, or target sized). */
uint8_t *pocketjs_gpu_mask(uint32_t id, size_t *len);

/* CPU-writable RGB565 tile `id` (at least cpu_tile_pixels). */
uint16_t *pocketjs_gpu_tile(uint32_t id, size_t *len);

/* Native copy the driver registered for a core texture handle at
 * `revision`, or 0 when it must use the portable bytes. */
uint32_t pocketjs_gpu_native_texture(int32_t handle, uint64_t revision);

#ifdef __cplusplus
}
#endif

#endif
