/*
 * The RGB565 framebuffer ring and the RT-Thread LCD device. Presentation
 * is asynchronous: one draw_rect_async stays in flight; the next present
 * waits for its tx_complete first, so the scanned, pending, and rendering
 * buffers stay distinct on RAM-less DPI panels.
 */
#include <rtdevice.h>
#include <rtthread.h>

#include "mem_section.h"

#include "host_internal.h"

L2_NON_RET_BSS_SECT_BEGIN(pocketjs_framebuffers)
// clang-format off
L2_NON_RET_BSS_SECT(pocketjs_framebuffers, ALIGN(64) static uint16_t g_framebuffers[POCKETJS_FRAMEBUFFER_COUNT][POCKETJS_FRAMEBUFFER_PIXELS]);
// clang-format on
L2_NON_RET_BSS_SECT_END

static rt_device_t g_lcd;
static struct rt_semaphore g_lcd_done;
static bool g_in_flight;

static rt_err_t flush_done(rt_device_t device, void *buffer)
{
    (void)device;
    (void)buffer;
    return rt_sem_release(&g_lcd_done);
}

bool pocketjs_lcd_open(void)
{
    struct rt_device_graphic_info info;
    uint16_t format = RTGRAPHIC_PIXEL_FORMAT_RGB565;
    uint8_t brightness = 100;
    uintptr_t start = (uintptr_t)g_framebuffers;
    uintptr_t end = start + sizeof(g_framebuffers);

#ifdef POCKETJS_MPU_OVERRIDE
    if (start < 0x62000000U || end > 0x63000000U)
    {
        rt_kprintf("[PocketJS] fatal: framebuffers are not linked into PSRAM2\n");
        return false;
    }
#endif
    rt_kprintf("[PocketJS] framebuffer: %p..%p (%u x %ux%u RGB565)\n", (void *)start,
               (void *)end, (unsigned)POCKETJS_FRAMEBUFFER_COUNT,
               (unsigned)POCKETJS_PHYSICAL_WIDTH, (unsigned)POCKETJS_PHYSICAL_HEIGHT);

    if (rt_sem_init(&g_lcd_done, "pocket_lcd", 0, RT_IPC_FLAG_FIFO) != RT_EOK)
    {
        rt_kprintf("[PocketJS] fatal: LCD semaphore initialization failed\n");
        return false;
    }
    g_lcd = rt_device_find("lcd");
    if (g_lcd == RT_NULL || rt_device_open(g_lcd, RT_DEVICE_OFLAG_RDWR) != RT_EOK)
    {
        rt_kprintf("[PocketJS] fatal: LCD device open failed\n");
        return false;
    }
    if (rt_device_control(g_lcd, RTGRAPHIC_CTRL_GET_INFO, &info) != RT_EOK ||
        info.width != POCKETJS_PHYSICAL_WIDTH || info.height != POCKETJS_PHYSICAL_HEIGHT)
    {
        rt_kprintf("[PocketJS] fatal: LCD is %ux%u, the host is configured for %ux%u\n",
                   (unsigned)info.width, (unsigned)info.height,
                   (unsigned)POCKETJS_PHYSICAL_WIDTH, (unsigned)POCKETJS_PHYSICAL_HEIGHT);
        return false;
    }
    if (rt_device_control(g_lcd, RTGRAPHIC_CTRL_SET_BUF_FORMAT, &format) != RT_EOK)
    {
        rt_kprintf("[PocketJS] fatal: LCD rejected the RGB565 framebuffer format\n");
        return false;
    }
    rt_graphix_ops(g_lcd)->set_window(0, 0, POCKETJS_PHYSICAL_WIDTH - 1u,
                                      POCKETJS_PHYSICAL_HEIGHT - 1u);
    rt_device_set_tx_complete(g_lcd, flush_done);
    rt_device_control(g_lcd, RTGRAPHIC_CTRL_SET_BRIGHTNESS, &brightness);
    rt_kprintf("[PocketJS] LCD ready: %ux%u RGB565 %u-buffer ring\n", (unsigned)info.width,
               (unsigned)info.height, (unsigned)POCKETJS_FRAMEBUFFER_COUNT);
    return true;
}

uint16_t *pocketjs_lcd_framebuffer(uint32_t index)
{
    return index < POCKETJS_FRAMEBUFFER_COUNT ? g_framebuffers[index] : RT_NULL;
}

void pocketjs_lcd_present(uint16_t *framebuffer)
{
    if (g_in_flight && rt_sem_take(&g_lcd_done, RT_WAITING_FOREVER) != RT_EOK)
    {
        pocketjs_host_fatal("LCD present wait failed");
    }
    g_in_flight = false;
    rt_graphix_ops(g_lcd)->draw_rect_async((const char *)framebuffer, 0, 0,
                                           POCKETJS_PHYSICAL_WIDTH - 1u,
                                           POCKETJS_PHYSICAL_HEIGHT - 1u);
    g_in_flight = true;
}
