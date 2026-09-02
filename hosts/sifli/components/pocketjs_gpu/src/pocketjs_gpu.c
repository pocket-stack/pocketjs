/*
 * PocketJS GPU command queue: the executor behind pocketjs_gpu.h.
 *
 * Commands arrive in painter order from the Rust renderer. EPIC
 * (pocketjs_gpu_epic.c) runs fills, gradients, A8 blends, native
 * axis-aligned blits, and tile copies one transaction at a time; VG Lite
 * (pocketjs_gpu_vglite.c, SF32LB58) runs four-point quads, tinted blits,
 * and blits from textures kept in portable formats. The two engines share
 * no arbitration, so a command that moves to the other engine first drains
 * the one in use. A8 planes and RGB565 tiles live in on-chip SRAM so the
 * CPU builds coverage and renders fallbacks without touching the
 * framebuffer or maintaining caches.
 */
#include <string.h>

#include "mem_section.h"

#include "pocketjs_gpu_internal.h"

#define MASK_BYTES ((size_t)POCKETJS_GPU_MASK_TILE_KB * 1024u)
#define TILE_PIXELS ((size_t)POCKETJS_GPU_CPU_TILE_KB * 1024u / sizeof(uint16_t))
#define PLANE_SLOTS 2u

enum
{
    ENGINE_NONE,
    ENGINE_EPIC,
    ENGINE_VGLITE,
};

L1_NON_RET_BSS_SECT(pocketjs_gpu_masks,
                    ALIGN(64) static uint8_t g_masks[PLANE_SLOTS][MASK_BYTES]);
L1_NON_RET_BSS_SECT(pocketjs_gpu_tiles,
                    ALIGN(64) static uint16_t g_tiles[PLANE_SLOTS][TILE_PIXELS]);

static bool g_open;
static bool g_vglite;
static uint32_t g_engine;
static PocketjsGpuTarget g_target;
static PocketjsGpuTexture g_textures[POCKETJS_GPU_MAX_TEXTURES];
static uint32_t g_texture_count;
static PocketjsGpuProfile g_profile;

const PocketjsGpuTarget *pocketjs_gpu_target(void)
{
    return &g_target;
}

const PocketjsGpuTexture *pocketjs_gpu_texture_by_id(uint32_t id)
{
    if (id == 0 || id > g_texture_count)
    {
        return NULL;
    }
    return &g_textures[id - 1u];
}

uint8_t *pocketjs_gpu_mask_base(uint32_t id, size_t *len)
{
    if (id >= PLANE_SLOTS)
    {
        return NULL;
    }
    if (len != NULL)
    {
        *len = MASK_BYTES;
    }
    return g_masks[id];
}

uint16_t *pocketjs_gpu_tile_base(uint32_t id, size_t *len)
{
    if (id >= PLANE_SLOTS)
    {
        return NULL;
    }
    if (len != NULL)
    {
        *len = TILE_PIXELS;
    }
    return g_tiles[id];
}

void pocketjs_gpu_profile_submit(uint32_t started)
{
    g_profile.submit_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);
    ++g_profile.transactions;
}

void pocketjs_gpu_profile_wait(uint32_t started)
{
    g_profile.wait_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);
}

bool pocketjs_gpu_rect_in_target(const PocketjsGpuRect *rect)
{
    return rect->w > 0 && rect->h > 0 && rect->x < g_target.width &&
           rect->y < g_target.height && rect->w <= g_target.width - rect->x &&
           rect->h <= g_target.height - rect->y;
}

/* ---- engines ---------------------------------------------------------- */

static void wait_all(void)
{
    pocketjs_gpu_epic_wait();
#if POCKETJS_GPU_HAS_VGLITE
    if (g_vglite)
    {
        pocketjs_gpu_vglite_wait();
    }
#endif
}

/* Make `engine` the one in use: the other engine is drained first because
 * nothing orders EPIC and VG Lite writes to the same target otherwise. */
static void switch_engine(uint32_t engine)
{
    if (g_engine == engine)
    {
        return;
    }
    if (g_engine == ENGINE_EPIC)
    {
        pocketjs_gpu_epic_wait();
    }
#if POCKETJS_GPU_HAS_VGLITE
    else if (g_engine == ENGINE_VGLITE)
    {
        pocketjs_gpu_vglite_wait();
    }
#endif
    if (g_engine != ENGINE_NONE)
    {
        ++g_profile.engine_switches;
    }
    g_engine = engine;
}

/* ---- host API --------------------------------------------------------- */

int32_t pocketjs_gpu_open(void)
{
    if (g_open)
    {
        return 1;
    }
    if (!pocketjs_gpu_epic_open())
    {
        return 0;
    }
#if POCKETJS_GPU_HAS_VGLITE
    g_vglite = pocketjs_gpu_vglite_open();
#endif
    memset(&g_profile, 0, sizeof(g_profile));
    g_engine = ENGINE_NONE;
    g_open = true;
    return 1;
}

void pocketjs_gpu_close(void)
{
    if (!g_open)
    {
        return;
    }
    wait_all();
#if POCKETJS_GPU_HAS_VGLITE
    if (g_vglite)
    {
        pocketjs_gpu_vglite_close();
        g_vglite = false;
    }
#endif
    pocketjs_gpu_epic_close();
    g_open = false;
}

static uint16_t read_u16_le(const uint8_t *data)
{
    return (uint16_t)((uint16_t)data[0] | ((uint16_t)data[1] << 8));
}

static PocketjsGpuTexture *registry_slot(int32_t handle, const uint8_t *blob, size_t blob_len)
{
    uint32_t index;
    if (handle < 0 || blob == NULL || blob_len < POCKETJS_GPU_NATIVE_HEADER ||
        ((uintptr_t)blob & 63u) != 0)
    {
        return NULL;
    }
    for (index = 0; index < g_texture_count; ++index)
    {
        if (g_textures[index].handle == handle)
        {
            return NULL; /* one registered copy per handle */
        }
    }
    if (g_texture_count >= POCKETJS_GPU_MAX_TEXTURES)
    {
        return NULL;
    }
    return &g_textures[g_texture_count];
}

static int32_t register_blob(int32_t handle, uint64_t revision, const uint8_t *blob,
                             size_t blob_len, uint32_t kind, size_t bytes_per_pixel,
                             size_t palette_len)
{
    PocketjsGpuTexture *texture = registry_slot(handle, blob, blob_len);
    uint32_t width;
    uint32_t height;
    uint64_t pixels;
    size_t required;

    if (texture == NULL)
    {
        return 0;
    }
    width = read_u16_le(blob);
    height = read_u16_le(blob + 2);
    pixels = (uint64_t)width * height;
    if (width == 0 || height == 0 || pixels > SIZE_MAX / 4u)
    {
        return 0;
    }
    required = (size_t)pixels * bytes_per_pixel;
    if (blob_len - POCKETJS_GPU_NATIVE_HEADER < palette_len ||
        required > blob_len - POCKETJS_GPU_NATIVE_HEADER - palette_len)
    {
        return 0;
    }

    /* The engines read memory, not the CPU cache; a blob staged in cached
     * PSRAM is cleaned once here (a no-op for XIP flash and SRAM). */
    mpu_dcache_clean((void *)blob, (uint32_t)blob_len);

    texture->handle = handle;
    texture->revision = revision;
    texture->kind = kind;
    texture->format = blob[4];
    texture->width = width;
    texture->height = height;
    texture->palette = palette_len != 0 ? blob + POCKETJS_GPU_NATIVE_HEADER : NULL;
    texture->pixels = blob + POCKETJS_GPU_NATIVE_HEADER + palette_len;
    texture->pixel_len = required;
    ++g_texture_count;
    return 1;
}

int32_t pocketjs_gpu_texture_register(int32_t handle, uint64_t revision,
                                      const uint8_t *blob, size_t blob_len)
{
    if (blob == NULL || blob_len < POCKETJS_GPU_NATIVE_HEADER)
    {
        return 0;
    }
    switch (blob[4])
    {
    case POCKETJS_GPU_NATIVE_RGB565:
        return register_blob(handle, revision, blob, blob_len, POCKETJS_GPU_TEXTURE_NATIVE, 2, 0);
    case POCKETJS_GPU_NATIVE_BGRA8888:
        return register_blob(handle, revision, blob, blob_len, POCKETJS_GPU_TEXTURE_NATIVE, 4, 0);
#if POCKETJS_GPU_HAS_L8
    case POCKETJS_GPU_NATIVE_L8:
        return register_blob(handle, revision, blob, blob_len, POCKETJS_GPU_TEXTURE_NATIVE, 1,
                             1024);
#endif
    default:
        return 0;
    }
}

int32_t pocketjs_gpu_texture_register_portable(int32_t handle, uint64_t revision,
                                               const uint8_t *entry, size_t entry_len)
{
    if (!g_vglite || entry == NULL || entry_len < POCKETJS_GPU_NATIVE_HEADER)
    {
        return 0;
    }
    switch (entry[4])
    {
    case POCKETJS_GPU_PSM_5650:
    case POCKETJS_GPU_PSM_4444:
        return register_blob(handle, revision, entry, entry_len, POCKETJS_GPU_TEXTURE_PORTABLE,
                             2, 0);
    case POCKETJS_GPU_PSM_8888:
        return register_blob(handle, revision, entry, entry_len, POCKETJS_GPU_TEXTURE_PORTABLE,
                             4, 0);
    case POCKETJS_GPU_PSM_T8:
        return register_blob(handle, revision, entry, entry_len, POCKETJS_GPU_TEXTURE_PORTABLE,
                             1, 1024);
    default:
        return 0;
    }
}

void pocketjs_gpu_texture_reset(void)
{
    wait_all();
    g_texture_count = 0;
    memset(g_textures, 0, sizeof(g_textures));
}

void pocketjs_gpu_profile_take(PocketjsGpuProfile *out)
{
    if (out != NULL)
    {
        *out = g_profile;
    }
    memset(&g_profile, 0, sizeof(g_profile));
}

void pocketjs_gpu_profile_peek(PocketjsGpuProfile *out)
{
    *out = g_profile;
}

/* ---- renderer API ----------------------------------------------------- */

int pocketjs_gpu_caps(PocketjsGpuCaps *out)
{
    if (out == NULL || !g_open)
    {
        return -1;
    }
    memset(out, 0, sizeof(*out));
    out->abi_version = POCKETJS_GPU_ABI_VERSION;
    out->flags = POCKETJS_GPU_CAP_FILL_OPAQUE | POCKETJS_GPU_CAP_FILL_ALPHA |
                 POCKETJS_GPU_CAP_GRADIENT | POCKETJS_GPU_CAP_BLIT_NATIVE;
#if POCKETJS_GPU_HAS_A8
    out->flags |= POCKETJS_GPU_CAP_A8_BLEND;
#endif
#ifdef POCKETJS_GPU_DIRECT_CPU_WRITES
    out->flags |= POCKETJS_GPU_CAP_DIRECT_CPU_WRITES;
#endif
    if (g_vglite)
    {
        /* Registered textures only: VG Lite needs 64-byte-aligned, cache-clean
         * sources, which the host guarantees at registration and inline
         * portable texels cannot. */
        out->flags |= POCKETJS_GPU_CAP_BLIT_QUAD_NATIVE | POCKETJS_GPU_CAP_BLIT_MODULATE;
    }
    out->blit_formats = 0;
    out->blit_quad_formats = 0;
    out->coordinate_limit = POCKETJS_GPU_COORD_MAX;
    out->mask_tile_bytes = (uint32_t)MASK_BYTES;
    out->cpu_tile_pixels = (uint32_t)TILE_PIXELS;
    out->min_fill = POCKETJS_GPU_MIN_PIXELS;
    out->min_gradient = POCKETJS_GPU_MIN_PIXELS;
    out->min_blend = POCKETJS_GPU_MIN_PIXELS;
    out->min_blit = POCKETJS_GPU_MIN_PIXELS;
    return 0;
}

int pocketjs_gpu_begin(uint16_t *target, size_t pixels, uint32_t width, uint32_t height,
                       uint32_t kind)
{
    if (!g_open || target == NULL || width == 0 || height == 0 || width > UINT16_MAX ||
        height > UINT16_MAX || pixels != (size_t)width * height)
    {
        return -1;
    }
    wait_all();
    g_engine = ENGINE_NONE;
    g_target.pixels = target;
    g_target.width = width;
    g_target.height = height;
    g_target.kind = kind;
#if POCKETJS_GPU_HAS_VGLITE
    if (g_vglite)
    {
        pocketjs_gpu_vglite_bind(&g_target);
    }
#endif
    return 0;
}

static bool epic_can_blit(const PocketjsGpuCmd *cmd)
{
    const PocketjsGpuTexture *texture;
    if (cmd->src_kind != POCKETJS_GPU_SRC_NATIVE ||
        (cmd->color & 0x00FFFFFFu) != 0x00FFFFFFu ||
        ((cmd->flags & POCKETJS_GPU_FLAG_MIRROR_Y) != 0 && !POCKETJS_GPU_HAS_V_MIRROR))
    {
        return false;
    }
    texture = pocketjs_gpu_texture_by_id(cmd->src_id);
    return texture != NULL && texture->kind == POCKETJS_GPU_TEXTURE_NATIVE;
}

static int run_blit(const PocketjsGpuCmd *cmd, bool quad)
{
    if (!quad && epic_can_blit(cmd))
    {
        switch_engine(ENGINE_EPIC);
        return pocketjs_gpu_epic_blit(cmd);
    }
#if POCKETJS_GPU_HAS_VGLITE
    if (g_vglite && pocketjs_gpu_vglite_ready())
    {
        int result;
        switch_engine(ENGINE_VGLITE);
        result = pocketjs_gpu_vglite_blit(cmd, quad);
        if (result == POCKETJS_GPU_EXEC_OK)
        {
            ++g_profile.vglite_commands;
        }
        return result;
    }
#endif
    return POCKETJS_GPU_EXEC_REJECT;
}

int pocketjs_gpu_submit(const PocketjsGpuCmd *cmds, size_t count)
{
    size_t index;

    if (!g_open || g_target.pixels == NULL || (cmds == NULL && count != 0))
    {
        return POCKETJS_GPU_FAILED;
    }
    for (index = 0; index < count; ++index)
    {
        const PocketjsGpuCmd *cmd = &cmds[index];
        int result;

        switch (cmd->op)
        {
        case POCKETJS_GPU_OP_FILL:
        case POCKETJS_GPU_OP_FILL_ALPHA:
            switch_engine(ENGINE_EPIC);
            result = pocketjs_gpu_epic_fill(cmd);
            break;
        case POCKETJS_GPU_OP_BLEND_A8:
            switch_engine(ENGINE_EPIC);
            result = pocketjs_gpu_epic_blend_a8(cmd);
            break;
        case POCKETJS_GPU_OP_GRADIENT:
            switch_engine(ENGINE_EPIC);
            result = pocketjs_gpu_epic_gradient(cmd);
            break;
        case POCKETJS_GPU_OP_BLIT:
            result = run_blit(cmd, false);
            break;
        case POCKETJS_GPU_OP_BLIT_QUAD:
            result = run_blit(cmd, true);
            break;
        case POCKETJS_GPU_OP_TILE_OUT:
            switch_engine(ENGINE_EPIC);
            result = pocketjs_gpu_epic_tile_out(cmd);
            break;
        case POCKETJS_GPU_OP_TILE_IN:
            switch_engine(ENGINE_EPIC);
            result = pocketjs_gpu_epic_tile_in(cmd);
            break;
        case POCKETJS_GPU_OP_FENCE:
            wait_all();
            result = POCKETJS_GPU_EXEC_OK;
            break;
        default:
            result = POCKETJS_GPU_EXEC_REJECT;
            break;
        }
        if (result == POCKETJS_GPU_EXEC_REJECT)
        {
            ++g_profile.rejected;
            return -(int)(index + 1u);
        }
        if (result != POCKETJS_GPU_EXEC_OK)
        {
            return POCKETJS_GPU_FAILED;
        }
    }
    return 0;
}

int pocketjs_gpu_fence(void)
{
    if (!g_open)
    {
        return POCKETJS_GPU_FAILED;
    }
    wait_all();
    return 0;
}

int pocketjs_gpu_end(void)
{
    if (!g_open)
    {
        return POCKETJS_GPU_FAILED;
    }
    wait_all();
    g_engine = ENGINE_NONE;
    g_target.pixels = NULL;
    return 0;
}

uint8_t *pocketjs_gpu_mask(uint32_t id, size_t *len)
{
    return pocketjs_gpu_mask_base(id, len);
}

uint16_t *pocketjs_gpu_tile(uint32_t id, size_t *len)
{
    return pocketjs_gpu_tile_base(id, len);
}

uint32_t pocketjs_gpu_native_texture(int32_t handle, uint64_t revision)
{
    uint32_t index;
    for (index = 0; index < g_texture_count; ++index)
    {
        if (g_textures[index].handle == handle && g_textures[index].revision == revision)
        {
            return index + 1u;
        }
    }
    return 0;
}
