/*
 * PocketJS firmware host for SiFli SF32LB5x: mounts guests from an embedded
 * catalog, runs the frame loop, and owns the heap, framebuffer ring, and
 * input. A product's main() hands over its catalog and never returns.
 */
#ifndef POCKETJS_HOST_H
#define POCKETJS_HOST_H

#include <stddef.h>
#include <stdint.h>

#include "rtconfig.h"

#include "pocketjs_catalog.h"

#ifdef __cplusplus
extern "C"
{
#endif

#define POCKETJS_PHYSICAL_WIDTH (POCKETJS_LOGICAL_WIDTH * POCKETJS_RENDER_SCALE)
#define POCKETJS_PHYSICAL_HEIGHT (POCKETJS_LOGICAL_HEIGHT * POCKETJS_RENDER_SCALE)
#define POCKETJS_FRAMEBUFFER_PIXELS (POCKETJS_PHYSICAL_WIDTH * POCKETJS_PHYSICAL_HEIGHT)

/* Run the host forever: heap, LCD, input, GPU queue, the launcher guest,
 * then the frame loop. Returns only when the catalog is empty or a
 * subsystem failed to initialize (the failure is printed first). */
int pocketjs_host_run(const PocketjsCatalog *catalog);

/* Shared PSRAM allocator used by QuickJS and the Rust core. */
void *pocket_heap_alloc(size_t size, size_t align);
void pocket_heap_free(void *ptr);
size_t pocket_heap_usable_size(const void *ptr);
size_t pocketjs_heap_available(void);
void pocket_rust_panic(void);

#ifdef __cplusplus
}
#endif

#endif
