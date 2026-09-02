/*
 * The frame loop: input, guest frame, render through the GPU queue,
 * present, profile, and guest switches at frame boundaries.
 */
#include <rtthread.h>
#include <string.h>

#include "bf0_hal.h"
#include "pocketjs_gpu_host.h"

#include "host_internal.h"

typedef struct
{
    uint64_t guest_cycles;
    uint64_t render_cycles;
    uint64_t lcd_cycles;
    uint64_t dirty_pixels;
    uint32_t full_frames;
    uint32_t policy_full_frames;
} PerfWindow;

static const PocketjsCatalog *g_catalog;
static const PocketjsGuest *g_current;
static const PocketjsGuest *g_pending;

void pocketjs_host_fatal(const char *message)
{
    rt_kprintf("[PocketJS] fatal: %s\n", message);
    while (1)
    {
        rt_thread_mdelay(1000);
    }
}

static const PocketjsGuest *launcher(void)
{
    return g_catalog->launcher < g_catalog->count ? &g_catalog->guests[g_catalog->launcher]
                                                  : &g_catalog->guests[0];
}

static bool request_launch(const char *output, size_t output_len, void *context)
{
    const PocketjsGuest *guest;
    (void)context;
    if (g_current != launcher() || g_pending != RT_NULL)
    {
        return false;
    }
    guest = pocketjs_catalog_find(g_catalog, output, output_len);
    if (guest == RT_NULL || guest == launcher())
    {
        return false;
    }
    g_pending = guest;
    rt_kprintf("[PocketJS] launch requested: %s\n", guest->output);
    return true;
}

static bool mount(const PocketjsGuest *guest)
{
    if (g_current != RT_NULL)
    {
        pocketjs_guest_unmount();
        g_current = RT_NULL;
    }
    if (!pocketjs_guest_mount(guest))
    {
        return false;
    }
    g_current = guest;
    g_pending = RT_NULL;
    rt_kprintf("[PocketJS] active guest: %s (%s)\n", guest->output,
               guest->title != RT_NULL ? guest->title : guest->output);
    return true;
}

static uint32_t ms_tenths(uint64_t cycles, uint32_t frames, uint32_t frequency)
{
    uint64_t denominator = (uint64_t)frames * frequency;
    if (denominator == 0)
    {
        return 0;
    }
    return (uint32_t)(cycles * 10000u / denominator);
}

#ifdef POCKETJS_PROFILE
static void report(uint32_t frame, uint32_t elapsed_frames, uint32_t elapsed_ticks,
                   const PerfWindow *perf, const PocketRenderStats *stats, uint32_t frequency)
{
    PocketjsGpuProfile gpu;
    uint32_t fps_tenths =
        elapsed_ticks > 0 ? elapsed_frames * RT_TICK_PER_SECOND * 10u / elapsed_ticks : 0;
    uint32_t frame_ms_tenths =
        elapsed_frames > 0 ? elapsed_ticks * 10000u / (RT_TICK_PER_SECOND * elapsed_frames) : 0;
    uint32_t guest_ms_tenths;
    uint32_t render_ms_tenths;
    uint32_t gpu_wait_tenths;
    uint32_t gpu_submit_tenths;
    uint32_t cpu_ms_tenths;
    uint32_t lcd_ms_tenths;
    uint32_t other_ms_tenths;
    uint32_t calls_tenths;
    uint32_t dirty_average;

    pocketjs_gpu_profile_take(&gpu);
    guest_ms_tenths = ms_tenths(perf->guest_cycles, elapsed_frames, frequency);
    render_ms_tenths = ms_tenths(perf->render_cycles, elapsed_frames, frequency);
    gpu_wait_tenths = ms_tenths(gpu.wait_cycles, elapsed_frames, frequency);
    gpu_submit_tenths = ms_tenths(gpu.submit_cycles, elapsed_frames, frequency);
    cpu_ms_tenths = render_ms_tenths > gpu_wait_tenths + gpu_submit_tenths
                        ? render_ms_tenths - gpu_wait_tenths - gpu_submit_tenths
                        : 0;
    lcd_ms_tenths = ms_tenths(perf->lcd_cycles, elapsed_frames, frequency);
    other_ms_tenths = frame_ms_tenths > guest_ms_tenths + render_ms_tenths + lcd_ms_tenths
                          ? frame_ms_tenths - guest_ms_tenths - render_ms_tenths - lcd_ms_tenths
                          : 0;
    calls_tenths = elapsed_frames > 0 ? gpu.transactions * 10u / elapsed_frames : 0;
    dirty_average = elapsed_frames > 0 ? (uint32_t)(perf->dirty_pixels / elapsed_frames) : 0;

    rt_kprintf("[PocketJS] perf frame=%u fps=%u.%u total=%u.%ums guest=%u.%u render=%u.%u "
               "lcd_wait=%u.%u other=%u.%u\n",
               frame, fps_tenths / 10u, fps_tenths % 10u, frame_ms_tenths / 10u,
               frame_ms_tenths % 10u, guest_ms_tenths / 10u, guest_ms_tenths % 10u,
               render_ms_tenths / 10u, render_ms_tenths % 10u, lcd_ms_tenths / 10u,
               lcd_ms_tenths % 10u, other_ms_tenths / 10u, other_ms_tenths % 10u);
    rt_kprintf("[PocketJS] render cpu=%u.%u gpu_submit=%u.%u gpu_wait=%u.%u calls=%u.%u/f "
               "switches=%u rejected=%u full=%u/%u policy=%u dirty_avg=%u last=%u regions=%u%s\n",
               cpu_ms_tenths / 10u, cpu_ms_tenths % 10u, gpu_submit_tenths / 10u,
               gpu_submit_tenths % 10u, gpu_wait_tenths / 10u, gpu_wait_tenths % 10u,
               calls_tenths / 10u, calls_tenths % 10u, gpu.engine_switches, gpu.rejected,
               perf->full_frames, elapsed_frames, perf->policy_full_frames, dirty_average,
               stats->damage_pixels, stats->damage_regions, stats->full_redraw ? " full" : "");
    rt_kprintf("[PocketJS] work words=%u gpu=%u/%u/%u/%u sw=%u/%u tiles=%u/%uKB fences=%u "
               "bands=%u miss=%u mem=%u/%uKB\n",
               stats->draw_words, stats->epic_fills, stats->epic_gradients, stats->epic_blends,
               stats->epic_copies, stats->software_ops, stats->software_words, stats->cpu_tiles,
               (stats->cpu_tile_pixels * 2u) >> 10, stats->fences, stats->mask_bands,
               stats->glyph_misses, (unsigned)(pocketjs_guest_js_heap_bytes() >> 10),
               (unsigned)(pocketjs_heap_available() >> 10));
}
#endif

int pocketjs_host_run(const PocketjsCatalog *catalog)
{
    rt_tick_t next_frame;
    rt_tick_t report_tick;
    uint32_t fractional_ticks = 0;
    uint32_t frame = 0;
    uint32_t report_frame = 0;
    uint32_t target = 0;
    uint32_t frequency;
    PerfWindow perf;

    if (catalog == RT_NULL || catalog->count == 0)
    {
        rt_kprintf("[PocketJS] fatal: empty guest catalog\n");
        return -1;
    }
    g_catalog = catalog;
    rt_kprintf("\n[PocketJS] SiFli host boot: %ux%u logical, scale %u, density %u, %u Hz, "
               "%u guest(s)\n",
               (unsigned)POCKETJS_LOGICAL_WIDTH, (unsigned)POCKETJS_LOGICAL_HEIGHT,
               (unsigned)POCKETJS_RENDER_SCALE, (unsigned)POCKETJS_RASTER_DENSITY,
               (unsigned)POCKETJS_TICK_HZ, (unsigned)catalog->count);
    if (!pocketjs_heap_open() || !pocketjs_lcd_open())
    {
        return -1;
    }
    pocketjs_input_open();
    if (!pocketjs_gpu_open())
    {
        rt_kprintf("[PocketJS] fatal: GPU queue initialization failed\n");
        return -1;
    }
    rt_kprintf("[PocketJS] GPU queue ready\n");
    pocketjs_guest_set_launch_handler(request_launch, RT_NULL);
    if (!mount(launcher()))
    {
        rt_kprintf("[PocketJS] fatal: launcher initialization failed\n");
        return -1;
    }

    HAL_DBG_DWT_Init();
    frequency = HAL_RCC_GetHCLKFreq(CORE_ID_HCPU);
    pocketjs_gpu_profile_take(RT_NULL);
    memset(&perf, 0, sizeof(perf));
    next_frame = rt_tick_get();
    report_tick = next_frame;
    while (1)
    {
        PocketjsInputFrame input;
        PocketRenderStats stats;
        uint16_t *framebuffer = pocketjs_lcd_framebuffer(target);
        rt_tick_t now;
        rt_int32_t remaining;
        uint32_t started;

        pocketjs_input_poll(&input, g_current == launcher());
        if (input.home_request && g_pending == RT_NULL && g_current != launcher())
        {
            g_pending = launcher();
            rt_kprintf("[PocketJS] KEY1 hold: return to launcher\n");
        }

        started = HAL_DBG_DWT_GetCycles();
        if (!pocketjs_guest_frame(input.buttons, &input.touch, input.touch_count))
        {
            pocketjs_host_fatal("guest frame failed");
        }
        perf.guest_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);

        started = HAL_DBG_DWT_GetCycles();
        if (!pocketjs_guest_render(framebuffer, POCKETJS_FRAMEBUFFER_PIXELS, target, &stats))
        {
            pocketjs_host_fatal("render failed");
        }
        perf.render_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);

#ifdef POCKETJS_SELF_CHECK
        {
            PocketjsGpuProfile probe;
            pocketjs_gpu_profile_peek(&probe);
            pocketjs_selfcheck_frame(frame, framebuffer, &stats, probe.vglite_commands);
        }
#endif
#ifdef POCKETJS_FRAME_CRC
        pocketjs_frame_crc(frame, framebuffer, pocketjs_guest_draw_hash());
#endif

        started = HAL_DBG_DWT_GetCycles();
        pocketjs_lcd_present(framebuffer);
        perf.lcd_cycles += (uint32_t)(HAL_DBG_DWT_GetCycles() - started);
        perf.dirty_pixels += stats.damage_pixels;
        perf.full_frames += stats.full_redraw;
        perf.policy_full_frames += stats.full_redraw_promoted;

        ++frame;
        if ((frame % POCKETJS_TICK_HZ) == 0)
        {
            rt_tick_t report_now = rt_tick_get();
#ifdef POCKETJS_PROFILE
            report(frame, frame - report_frame, (uint32_t)(report_now - report_tick), &perf,
                   &stats, frequency);
#endif
            report_tick = report_now;
            report_frame = frame;
            memset(&perf, 0, sizeof(perf));
        }
        if (g_pending != RT_NULL)
        {
            if (!mount(g_pending))
            {
                pocketjs_host_fatal("guest switch failed");
            }
            next_frame = rt_tick_get();
            report_tick = next_frame;
            report_frame = frame;
            fractional_ticks = 0;
            memset(&perf, 0, sizeof(perf));
            pocketjs_gpu_profile_take(RT_NULL);
        }
        if (++target == POCKETJS_FRAMEBUFFER_COUNT)
        {
            target = 0;
        }

        next_frame += RT_TICK_PER_SECOND / POCKETJS_TICK_HZ;
        fractional_ticks += RT_TICK_PER_SECOND % POCKETJS_TICK_HZ;
        if (fractional_ticks >= POCKETJS_TICK_HZ)
        {
            ++next_frame;
            fractional_ticks -= POCKETJS_TICK_HZ;
        }
        now = rt_tick_get();
        remaining = (rt_int32_t)(next_frame - now);
        if (remaining > 0)
        {
            rt_thread_delay((rt_tick_t)remaining);
        }
        else if (remaining < -(rt_int32_t)RT_TICK_PER_SECOND)
        {
            next_frame = now;
            fractional_ticks = 0;
        }
    }
}
