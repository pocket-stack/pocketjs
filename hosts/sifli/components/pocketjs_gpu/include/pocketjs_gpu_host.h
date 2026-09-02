/*
 * Host-facing side of the PocketJS GPU command queue: lifecycle, the
 * texture registry, and profiling. The renderer-facing side is
 * hosts/sifli/include/pocketjs_gpu.h.
 */
#ifndef POCKETJS_GPU_HOST_H
#define POCKETJS_GPU_HOST_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

/* Initialize the engines and the SRAM planes. Returns 1 on success, 0 on
 * failure; calling it again is a no-op that returns 1. */
int32_t pocketjs_gpu_open(void);

/* Wait for the hardware and release it. */
void pocketjs_gpu_close(void);

/* Native texture blob layout (the `.epic` pak payload): u16 width, u16
 * height, u8 format, u8 flags, u16 reserved, then the pixels; L8 blobs carry
 * a 1024-byte EPIC-order (BGRA) palette before the indices. */
#define POCKETJS_GPU_NATIVE_RGB565   0u
#define POCKETJS_GPU_NATIVE_BGRA8888 1u
#define POCKETJS_GPU_NATIVE_L8       2u
#define POCKETJS_GPU_NATIVE_HEADER   8u

/* Portable IMG entry layout (the PocketJS pak payload): the same 8-byte
 * header with the PSM code as format, then the core's pixel bytes; PSM_T8
 * carries a 1024-byte RGBA palette before the indices. */
#define POCKETJS_GPU_PSM_5650 0u
#define POCKETJS_GPU_PSM_4444 2u
#define POCKETJS_GPU_PSM_8888 3u
#define POCKETJS_GPU_PSM_T8   5u

/* Register a native blob for core texture `handle` at content `revision`.
 * The blob must stay valid, unchanged, and 64-byte aligned until
 * pocketjs_gpu_texture_reset(). Returns 1 on success, 0 when the blob is
 * malformed, the handle is already registered, or the registry is full. */
int32_t pocketjs_gpu_texture_register(int32_t handle, uint64_t revision,
                                      const uint8_t *blob, size_t blob_len);

/* Register the core's portable IMG entry for `handle` (VG Lite reads the
 * portable formats directly). Same lifetime and alignment rules; returns 0
 * when no engine can read portable textures. */
int32_t pocketjs_gpu_texture_register_portable(int32_t handle, uint64_t revision,
                                               const uint8_t *entry, size_t entry_len);

/* Forget every registered texture (guest switch). Waits for the hardware. */
void pocketjs_gpu_texture_reset(void);

typedef struct
{
    uint64_t submit_cycles;  /* DWT cycles spent programming the engines */
    uint64_t wait_cycles;    /* DWT cycles spent waiting for completion */
    uint32_t transactions;   /* hardware transactions started */
    uint32_t rejected;       /* commands the queue refused */
    uint32_t engine_switches; /* EPIC <-> VG Lite drains */
    uint32_t vglite_commands; /* commands VG Lite ran */
} PocketjsGpuProfile;

/* Read and reset the counters (NULL just resets). */
void pocketjs_gpu_profile_take(PocketjsGpuProfile *out);

/* Read the counters without resetting them. */
void pocketjs_gpu_profile_peek(PocketjsGpuProfile *out);

#ifdef __cplusplus
}
#endif

#endif
