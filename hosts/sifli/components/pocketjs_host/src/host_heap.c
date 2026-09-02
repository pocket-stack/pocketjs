/*
 * One bounded rt_memheap in cached PSRAM shared by QuickJS and the Rust
 * core, with an alignment-preserving wrapper (the Rust allocator asks for
 * up to 64-byte alignment; rt_memheap only guarantees pointer alignment).
 */
#include <limits.h>
#include <rtthread.h>
#include <string.h>

#include "mem_section.h"

#include "host_internal.h"

#define POCKETJS_HEAP_BYTES ((size_t)POCKETJS_HEAP_KB * 1024u)

L2_CACHE_NON_RET_BSS_SECT_BEGIN(pocketjs_runtime)
// clang-format off
ALIGN(64) static uint8_t g_heap_pool[POCKETJS_HEAP_BYTES] L2_CACHE_NON_RET_BSS_SECT(pocketjs_runtime);
// clang-format on
L2_CACHE_NON_RET_BSS_SECT_END

typedef struct
{
    void *raw;
    size_t size;
} AllocationHeader;

static struct rt_memheap g_heap;

bool pocketjs_heap_open(void)
{
    uintptr_t start = (uintptr_t)g_heap_pool;
    uintptr_t end = start + sizeof(g_heap_pool);

#ifdef PSRAM_DATA_START_ADDR
    if (start < PSRAM_DATA_START_ADDR || end > PSRAM_DATA_START_ADDR + PSRAM_DATA_SIZE)
    {
        rt_kprintf("[PocketJS] fatal: runtime heap is not linked into the PSRAM data partition\n");
        return false;
    }
#endif
    if (rt_memheap_init(&g_heap, "pocket", g_heap_pool, sizeof(g_heap_pool)) != RT_EOK)
    {
        rt_kprintf("[PocketJS] fatal: PSRAM heap initialization failed\n");
        return false;
    }
    rt_kprintf("[PocketJS] runtime heap: cached %p..%p (%uKB)\n", (void *)start, (void *)end,
               (unsigned)(sizeof(g_heap_pool) >> 10));
    return true;
}

void *pocket_heap_alloc(size_t size, size_t align)
{
    uintptr_t base;
    uintptr_t aligned;
    AllocationHeader *header;
    void *raw;
    size_t overhead;

    if (size == 0)
    {
        size = 1;
    }
    if (align < sizeof(void *))
    {
        align = sizeof(void *);
    }
    if ((align & (align - 1u)) != 0)
    {
        return RT_NULL;
    }
    overhead = sizeof(AllocationHeader) + align - 1u;
    if (size > SIZE_MAX - overhead)
    {
        return RT_NULL;
    }
    raw = rt_memheap_alloc(&g_heap, size + overhead);
    if (raw == RT_NULL)
    {
        return RT_NULL;
    }
    base = (uintptr_t)raw + sizeof(AllocationHeader);
    aligned = (base + align - 1u) & ~(uintptr_t)(align - 1u);
    header = (AllocationHeader *)(aligned - sizeof(AllocationHeader));
    header->raw = raw;
    header->size = size;
    return (void *)aligned;
}

void pocket_heap_free(void *ptr)
{
    AllocationHeader *header;
    if (ptr == RT_NULL)
    {
        return;
    }
    header = (AllocationHeader *)((uintptr_t)ptr - sizeof(AllocationHeader));
    rt_memheap_free(header->raw);
}

size_t pocket_heap_usable_size(const void *ptr)
{
    const AllocationHeader *header;
    if (ptr == RT_NULL)
    {
        return 0;
    }
    header = (const AllocationHeader *)((uintptr_t)ptr - sizeof(AllocationHeader));
    return header->size;
}

size_t pocketjs_heap_available(void)
{
    return g_heap.available_size;
}

void pocket_rust_panic(void)
{
    pocketjs_host_fatal("panic in pocketjs-core");
}
