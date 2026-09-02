/* Internal state shared between the queue and its engine executors. */
#ifndef POCKETJS_GPU_INTERNAL_H
#define POCKETJS_GPU_INTERNAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "pocketjs_gpu.h"
#include "pocketjs_gpu_chip.h"
#include "pocketjs_gpu_host.h"

/* Executor results. */
#define POCKETJS_GPU_EXEC_OK 0
#define POCKETJS_GPU_EXEC_REJECT 1
#define POCKETJS_GPU_EXEC_ERROR (-1)

/* Texture registry entry kinds. */
#define POCKETJS_GPU_TEXTURE_NATIVE 0u   /* format = POCKETJS_GPU_NATIVE_* */
#define POCKETJS_GPU_TEXTURE_PORTABLE 1u /* format = POCKETJS_GPU_PSM_* */

typedef struct
{
    uint16_t *pixels;
    uint32_t width;
    uint32_t height;
    uint32_t kind;
} PocketjsGpuTarget;

typedef struct
{
    int32_t handle;
    uint64_t revision;
    uint32_t kind;
    uint32_t format;
    const uint8_t *pixels;
    size_t pixel_len;
    const uint8_t *palette; /* 1024 bytes for L8 (BGRA) and PSM_T8 (RGBA) */
    uint32_t width;
    uint32_t height;
} PocketjsGpuTexture;

/* Queue-side helpers used by executors. */
const PocketjsGpuTarget *pocketjs_gpu_target(void);
const PocketjsGpuTexture *pocketjs_gpu_texture_by_id(uint32_t id);
uint8_t *pocketjs_gpu_mask_base(uint32_t id, size_t *len);
uint16_t *pocketjs_gpu_tile_base(uint32_t id, size_t *len);
void pocketjs_gpu_profile_submit(uint32_t started);
void pocketjs_gpu_profile_wait(uint32_t started);
bool pocketjs_gpu_rect_in_target(const PocketjsGpuRect *rect);

/* EPIC executor (pocketjs_gpu_epic.c). */
bool pocketjs_gpu_epic_open(void);
void pocketjs_gpu_epic_close(void);
void pocketjs_gpu_epic_wait(void);
int pocketjs_gpu_epic_fill(const PocketjsGpuCmd *cmd);
int pocketjs_gpu_epic_gradient(const PocketjsGpuCmd *cmd);
int pocketjs_gpu_epic_blend_a8(const PocketjsGpuCmd *cmd);
int pocketjs_gpu_epic_blit(const PocketjsGpuCmd *cmd);
int pocketjs_gpu_epic_tile_out(const PocketjsGpuCmd *cmd);
int pocketjs_gpu_epic_tile_in(const PocketjsGpuCmd *cmd);

/* VG Lite executor (pocketjs_gpu_vglite.c, SF32LB58 with USING_VGLITE). */
#if POCKETJS_GPU_HAS_VGLITE
bool pocketjs_gpu_vglite_open(void);
void pocketjs_gpu_vglite_close(void);
bool pocketjs_gpu_vglite_ready(void);
void pocketjs_gpu_vglite_wait(void);
void pocketjs_gpu_vglite_bind(const PocketjsGpuTarget *target);
int pocketjs_gpu_vglite_blit(const PocketjsGpuCmd *cmd, bool quad);
#endif

#endif
