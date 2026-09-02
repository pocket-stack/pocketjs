/*
 * Device self-check and frame CRC: the hardware frame against the core's
 * software rasterizer on the board, and against the simulator through a
 * per-frame CRC32. Both are validation modes; neither runs in a product
 * build.
 */
#include <math.h>
#include <rtthread.h>
#include <string.h>

#include "mem_section.h"

#include "host_internal.h"

#if defined(POCKETJS_SELF_CHECK) || defined(POCKETJS_FRAME_CRC)
static uint32_t g_crc_table[256];

static void crc32_init(void)
{
    uint32_t index;
    if (g_crc_table[1] != 0)
    {
        return;
    }
    for (index = 0; index < 256; ++index)
    {
        uint32_t value = index;
        int bit;
        for (bit = 0; bit < 8; ++bit)
        {
            value = (value & 1u) != 0 ? (value >> 1) ^ 0xEDB88320u : value >> 1;
        }
        g_crc_table[index] = value;
    }
}

/* IEEE CRC-32 (reflected, 0xEDB88320, init and final xor 0xFFFFFFFF) over
 * the little-endian RGB565 bytes; tools/sifli.ts computes the same. */
uint32_t pocketjs_crc32(const void *data, size_t len)
{
    const uint8_t *bytes = data;
    uint32_t crc = 0xFFFFFFFFu;
    size_t index;
    crc32_init();
    for (index = 0; index < len; ++index)
    {
        crc = g_crc_table[(crc ^ bytes[index]) & 0xFFu] ^ (crc >> 8);
    }
    return crc ^ 0xFFFFFFFFu;
}
#endif

#ifdef POCKETJS_FRAME_CRC
void pocketjs_frame_crc(uint32_t frame, const uint16_t *framebuffer, uint64_t draw_hash)
{
    uint32_t crc = pocketjs_crc32(framebuffer, (size_t)POCKETJS_FRAMEBUFFER_PIXELS * 2u);
    rt_kprintf("[PocketJS] crc frame=%u hash=%08x%08x crc=%08x\n", frame,
               (unsigned)(draw_hash >> 32), (unsigned)draw_hash, (unsigned)crc);
}
#endif

#ifdef POCKETJS_SELF_CHECK
#define DIFF_REPORTS 16

L2_NON_RET_BSS_SECT_BEGIN(pocketjs_selfcheck)
// clang-format off
L2_NON_RET_BSS_SECT(pocketjs_selfcheck, ALIGN(64) static uint16_t g_reference[POCKETJS_FRAMEBUFFER_PIXELS]);
// clang-format on
L2_NON_RET_BSS_SECT_END

static uint32_t channel_delta(uint16_t a, uint16_t b, uint32_t *squared)
{
    uint32_t ra = (a >> 11) & 0x1Fu, ga = (a >> 5) & 0x3Fu, ba = a & 0x1Fu;
    uint32_t rb = (b >> 11) & 0x1Fu, gb = (b >> 5) & 0x3Fu, bb = b & 0x1Fu;
    uint32_t dr = ra > rb ? (ra - rb) << 3 : (rb - ra) << 3;
    uint32_t dg = ga > gb ? (ga - gb) << 2 : (gb - ga) << 2;
    uint32_t db = ba > bb ? (ba - bb) << 3 : (bb - ba) << 3;
    uint32_t max = dr > dg ? dr : dg;
    *squared += dr * dr + dg * dg + db * db;
    return max > db ? max : db;
}

void pocketjs_selfcheck_frame(uint32_t frame, const uint16_t *hardware,
                              const PocketRenderStats *stats, uint32_t vglite_commands)
{
    uint32_t mismatches = 0;
    uint32_t max_delta = 0;
    uint64_t squared_sum = 0;
    uint32_t reports = 0;
    uint32_t report_x[DIFF_REPORTS];
    uint32_t report_y[DIFF_REPORTS];
    uint16_t report_hw[DIFF_REPORTS];
    uint16_t report_sw[DIFF_REPORTS];
    uint32_t index;
    uint32_t psnr_tenths;
    uint32_t mismatch_permille;

    if ((frame % POCKETJS_SELF_CHECK_INTERVAL) != 0)
    {
        return;
    }
    if (!pocketjs_guest_render_software(g_reference, POCKETJS_FRAMEBUFFER_PIXELS))
    {
        rt_kprintf("[PocketJS] selfcheck frame=%u software render failed\n", frame);
        return;
    }
    for (index = 0; index < POCKETJS_FRAMEBUFFER_PIXELS; ++index)
    {
        uint16_t hw = hardware[index];
        uint16_t sw = g_reference[index];
        uint32_t squared = 0;
        uint32_t delta;
        if (hw == sw)
        {
            continue;
        }
        delta = channel_delta(hw, sw, &squared);
        squared_sum += squared;
        ++mismatches;
        if (delta > max_delta)
        {
            max_delta = delta;
        }
        if (reports < DIFF_REPORTS)
        {
            report_x[reports] = index % POCKETJS_PHYSICAL_WIDTH;
            report_y[reports] = index / POCKETJS_PHYSICAL_WIDTH;
            report_hw[reports] = hw;
            report_sw[reports] = sw;
            ++reports;
        }
    }
    if (mismatches == 0)
    {
        psnr_tenths = 999u * 10u; /* identical frames: report 999.0 dB */
    }
    else
    {
        double mse = (double)squared_sum / ((double)POCKETJS_FRAMEBUFFER_PIXELS * 3.0);
        double psnr = 10.0 * log10((255.0 * 255.0) / mse);
        psnr_tenths = psnr <= 0.0 ? 0 : (uint32_t)(psnr * 10.0 + 0.5);
    }
    mismatch_permille =
        (uint32_t)(((uint64_t)mismatches * 1000u + POCKETJS_FRAMEBUFFER_PIXELS / 2u) /
                   POCKETJS_FRAMEBUFFER_PIXELS);
    rt_kprintf("[PocketJS] selfcheck frame=%u mismatch=%u/%u (%u.%u%%) psnr=%u.%u maxd=%u "
               "crc_hw=%08x crc_sw=%08x gpu=%u/%u/%u/%u sw=%u vg=%u\n",
               frame, mismatches, (unsigned)POCKETJS_FRAMEBUFFER_PIXELS, mismatch_permille / 10u,
               mismatch_permille % 10u, psnr_tenths / 10u, psnr_tenths % 10u, max_delta,
               (unsigned)pocketjs_crc32(hardware, (size_t)POCKETJS_FRAMEBUFFER_PIXELS * 2u),
               (unsigned)pocketjs_crc32(g_reference, (size_t)POCKETJS_FRAMEBUFFER_PIXELS * 2u),
               stats->epic_fills, stats->epic_gradients, stats->epic_blends, stats->epic_copies,
               stats->software_ops, vglite_commands);
    for (index = 0; index < reports; ++index)
    {
        rt_kprintf("[PocketJS] selfcheck diff x=%u y=%u hw=%04x sw=%04x\n", report_x[index],
                   report_y[index], report_hw[index], report_sw[index]);
    }
}
#endif
