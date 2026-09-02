/*
 * EPIC executor: one interrupt-driven HAL transaction in flight at a time.
 *
 * Every recipe uses public HAL entry points only. Coordinates arrive
 * target-local; the HAL re-bases layers to their minimum corner, so the
 * limit that matters is each transaction's extent (POCKETJS_GPU_COORD_MAX),
 * which the renderer already respects.
 */
#include <string.h>

#include "pocketjs_gpu_internal.h"

static EPIC_HandleTypeDef g_epic;
#ifdef HAL_EZIP_MODULE_ENABLED
static EZIP_HandleTypeDef g_ezip;
#endif
static bool g_ready;
static volatile bool g_in_flight;

static void epic_complete(EPIC_HandleTypeDef *epic)
{
    (void)epic;
    g_in_flight = false;
}

void pocketjs_gpu_epic_wait(void)
{
    if (g_in_flight)
    {
        uint32_t started = HAL_DBG_DWT_GetCycles();
        while (g_in_flight)
        {
        }
        pocketjs_gpu_profile_wait(started);
    }
}

static void epic_begin(void)
{
    pocketjs_gpu_epic_wait();
    g_epic.XferCpltCallback = epic_complete;
    g_in_flight = true;
}

static int epic_result(HAL_StatusTypeDef status, uint32_t started)
{
    if (status != HAL_OK)
    {
        g_epic.XferCpltCallback = NULL;
        g_in_flight = false;
        return POCKETJS_GPU_EXEC_ERROR;
    }
    pocketjs_gpu_profile_submit(started);
    return POCKETJS_GPU_EXEC_OK;
}

void EPIC_IRQHandler(void)
{
    HAL_EPIC_IRQHandler(&g_epic);
}

bool pocketjs_gpu_epic_open(void)
{
    if (g_ready)
    {
        return true;
    }
    memset(&g_epic, 0, sizeof(g_epic));
#ifdef HAL_EZIP_MODULE_ENABLED
    memset(&g_ezip, 0, sizeof(g_ezip));
    g_ezip.Instance = EZIP;
    if (HAL_EZIP_Init(&g_ezip) != HAL_OK)
    {
        return false;
    }
    g_epic.hezip = &g_ezip;
#endif
    g_epic.Instance = hwp_epic;
    if (HAL_EPIC_Init(&g_epic) != HAL_OK)
    {
        return false;
    }
    HAL_NVIC_SetPriority(EPIC_IRQn, 3, 0);
    HAL_NVIC_EnableIRQ(EPIC_IRQn);
    g_ready = true;
    return true;
}

void pocketjs_gpu_epic_close(void)
{
    if (!g_ready)
    {
        return;
    }
    pocketjs_gpu_epic_wait();
    HAL_NVIC_DisableIRQ(EPIC_IRQn);
    g_ready = false;
}

static bool addressable(const PocketjsGpuRect *rect)
{
    return rect->w <= POCKETJS_GPU_COORD_MAX && rect->h <= POCKETJS_GPU_COORD_MAX;
}

static uint16_t *target_at(uint32_t x, uint32_t y)
{
    const PocketjsGpuTarget *target = pocketjs_gpu_target();
    return target->pixels + (size_t)y * target->width + x;
}

static void layer_rgb565(EPIC_LayerConfigTypeDef *layer, uint16_t *pixels,
                         uint32_t stride, uint32_t width, uint32_t height)
{
    HAL_EPIC_LayerConfigInit(layer);
    layer->data = (uint8_t *)pixels;
    layer->color_mode = EPIC_INPUT_RGB565;
    layer->width = (uint16_t)width;
    layer->height = (uint16_t)height;
    layer->total_width = (uint16_t)stride;
}

static EPIC_ColorDef corner_color(uint32_t abgr)
{
    EPIC_ColorDef color;
    color.ch.color_r = (uint8_t)(abgr & 0xFFu);
    color.ch.color_g = (uint8_t)((abgr >> 8) & 0xFFu);
    color.ch.color_b = (uint8_t)((abgr >> 16) & 0xFFu);
    color.ch.alpha = (uint8_t)(abgr >> 24);
    return color;
}

int pocketjs_gpu_epic_fill(const PocketjsGpuCmd *cmd)
{
    EPIC_FillingCfgTypeDef fill;
    uint32_t started;
    uint8_t alpha = (uint8_t)(cmd->color >> 24);

    if (!g_ready || !pocketjs_gpu_rect_in_target(&cmd->dst) || !addressable(&cmd->dst))
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    if (alpha == 0)
    {
        return POCKETJS_GPU_EXEC_OK;
    }
    HAL_EPIC_FillDataInit(&fill);
    fill.start = (uint8_t *)target_at(cmd->dst.x, cmd->dst.y);
    fill.color_mode = EPIC_OUTPUT_RGB565;
    fill.width = (uint16_t)cmd->dst.w;
    fill.height = (uint16_t)cmd->dst.h;
    fill.total_width = (uint16_t)pocketjs_gpu_target()->width;
    fill.color_r = (uint8_t)(cmd->color & 0xFFu);
    fill.color_g = (uint8_t)((cmd->color >> 8) & 0xFFu);
    fill.color_b = (uint8_t)((cmd->color >> 16) & 0xFFu);
    fill.alpha = cmd->op == POCKETJS_GPU_OP_FILL ? EPIC_LAYER_OPAQUE : alpha;

    started = HAL_DBG_DWT_GetCycles();
    epic_begin();
    return epic_result(HAL_EPIC_FillStart_IT(&g_epic, &fill), started);
}

int pocketjs_gpu_epic_gradient(const PocketjsGpuCmd *cmd)
{
    EPIC_GradCfgTypeDef gradient;
    uint32_t started;

    if (!g_ready || !pocketjs_gpu_rect_in_target(&cmd->dst) || !addressable(&cmd->dst))
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    HAL_EPIC_FillGradDataInit(&gradient);
    gradient.start = (uint8_t *)target_at(cmd->dst.x, cmd->dst.y);
    gradient.color_mode = EPIC_OUTPUT_RGB565;
    gradient.width = (uint16_t)cmd->dst.w;
    gradient.height = (uint16_t)cmd->dst.h;
    gradient.total_width = (uint16_t)pocketjs_gpu_target()->width;
    gradient.color[0][0] = corner_color(cmd->corners[0]); /* TL */
    gradient.color[0][1] = corner_color(cmd->corners[1]); /* TR */
    gradient.color[1][0] = corner_color(cmd->corners[2]); /* BL */
    gradient.color[1][1] = corner_color(cmd->corners[3]); /* BR */

    started = HAL_DBG_DWT_GetCycles();
    epic_begin();
    return epic_result(HAL_EPIC_FillGrad_IT(&g_epic, &gradient), started);
}

int pocketjs_gpu_epic_blend_a8(const PocketjsGpuCmd *cmd)
{
#if !POCKETJS_GPU_HAS_A8
    (void)cmd;
    return POCKETJS_GPU_EXEC_REJECT;
#else
    EPIC_LayerConfigTypeDef layers[2];
    EPIC_LayerConfigTypeDef output;
    size_t plane_len = 0;
    uint8_t *plane = pocketjs_gpu_mask_base(cmd->mask_id, &plane_len);
    uint64_t span;
    uint32_t started;
    uint8_t alpha = (uint8_t)(cmd->color >> 24);

    if (!g_ready || plane == NULL || !pocketjs_gpu_rect_in_target(&cmd->dst) ||
        !addressable(&cmd->dst) || cmd->mask_stride < cmd->dst.w)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    span = (uint64_t)cmd->mask_offset + (uint64_t)(cmd->dst.h - 1u) * cmd->mask_stride +
           cmd->dst.w;
    if (span > plane_len)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    if (alpha == 0)
    {
        return POCKETJS_GPU_EXEC_OK;
    }
    /* No-op for the SRAM planes; keeps cached placements correct. */
    mpu_dcache_clean(plane + cmd->mask_offset, (uint32_t)(span - cmd->mask_offset));

    layer_rgb565(&layers[0], target_at(cmd->dst.x, cmd->dst.y),
                 pocketjs_gpu_target()->width, cmd->dst.w, cmd->dst.h);

    HAL_EPIC_LayerConfigInit(&layers[1]);
    layers[1].data = plane + cmd->mask_offset;
    layers[1].color_mode = EPIC_INPUT_A8;
    layers[1].width = (uint16_t)cmd->dst.w;
    layers[1].height = (uint16_t)cmd->dst.h;
    layers[1].total_width = (uint16_t)cmd->mask_stride;
    layers[1].color_en = true;
    layers[1].color_r = (uint8_t)(cmd->color & 0xFFu);
    layers[1].color_g = (uint8_t)((cmd->color >> 8) & 0xFFu);
    layers[1].color_b = (uint8_t)((cmd->color >> 16) & 0xFFu);
    layers[1].ax_mode = ALPHA_BLEND_RGBCOLOR;
    layers[1].alpha = alpha;

    memcpy(&output, &layers[0], sizeof(output));
    output.color_mode = EPIC_OUTPUT_RGB565;

    started = HAL_DBG_DWT_GetCycles();
    epic_begin();
    return epic_result(HAL_EPIC_BlendStartEx_IT(&g_epic, layers, 2, &output), started);
#endif
}

int pocketjs_gpu_epic_blit(const PocketjsGpuCmd *cmd)
{
    EPIC_LayerConfigTypeDef layers[2];
    EPIC_LayerConfigTypeDef output;
    const PocketjsGpuTexture *texture;
    uint32_t bytes_per_pixel;
    uint32_t color_mode;
    uint64_t offset;
    uint32_t scale_x;
    uint32_t scale_y;
    uint32_t started;
    uint8_t alpha = (uint8_t)(cmd->color >> 24);
    bool mirror_x = (cmd->flags & POCKETJS_GPU_FLAG_MIRROR_X) != 0;
    bool mirror_y = (cmd->flags & POCKETJS_GPU_FLAG_MIRROR_Y) != 0;

    if (!g_ready || cmd->src_kind != POCKETJS_GPU_SRC_NATIVE ||
        (cmd->color & 0x00FFFFFFu) != 0x00FFFFFFu ||
        !pocketjs_gpu_rect_in_target(&cmd->clip) || !addressable(&cmd->clip) ||
        cmd->dst.w == 0 || cmd->dst.h == 0 || !addressable(&cmd->dst) ||
        cmd->dst.x + cmd->dst.w > pocketjs_gpu_target()->width ||
        cmd->dst.y + cmd->dst.h > pocketjs_gpu_target()->height ||
        (mirror_y && !POCKETJS_GPU_HAS_V_MIRROR))
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    texture = pocketjs_gpu_texture_by_id(cmd->src_id);
    if (texture == NULL || texture->kind != POCKETJS_GPU_TEXTURE_NATIVE || cmd->src.w == 0 ||
        cmd->src.h == 0 ||
        cmd->src.x >= texture->width || cmd->src.y >= texture->height ||
        cmd->src.w > texture->width - cmd->src.x ||
        cmd->src.h > texture->height - cmd->src.y)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    if (alpha == 0)
    {
        return POCKETJS_GPU_EXEC_OK;
    }
    switch (texture->format)
    {
    case POCKETJS_GPU_NATIVE_RGB565:
        bytes_per_pixel = 2;
        color_mode = EPIC_INPUT_RGB565;
        break;
    case POCKETJS_GPU_NATIVE_BGRA8888:
        bytes_per_pixel = 4;
        color_mode = EPIC_INPUT_ARGB8888;
        break;
#if POCKETJS_GPU_HAS_L8
    case POCKETJS_GPU_NATIVE_L8:
        bytes_per_pixel = 1;
        color_mode = EPIC_INPUT_L8;
        break;
#endif
    default:
        return POCKETJS_GPU_EXEC_REJECT;
    }
    offset = ((uint64_t)cmd->src.y * texture->width + cmd->src.x) * bytes_per_pixel;
    if (offset >= texture->pixel_len)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    scale_x = (uint32_t)(((uint64_t)cmd->src.w * EPIC_INPUT_SCALE_NONE + cmd->dst.w / 2u) /
                         cmd->dst.w);
    scale_y = (uint32_t)(((uint64_t)cmd->src.h * EPIC_INPUT_SCALE_NONE + cmd->dst.h / 2u) /
                         cmd->dst.h);
    if (scale_x == 0 || scale_y == 0)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }

    /* Background = the clipped destination window; the source layer is
     * placed at the unclipped destination so scaling keeps its phase and
     * the canvas clips it. */
    layer_rgb565(&layers[0], target_at(cmd->clip.x, cmd->clip.y),
                 pocketjs_gpu_target()->width, cmd->clip.w, cmd->clip.h);
    layers[0].x_offset = (int16_t)cmd->clip.x;
    layers[0].y_offset = (int16_t)cmd->clip.y;

    HAL_EPIC_LayerConfigInit(&layers[1]);
    layers[1].data = (uint8_t *)(texture->pixels + (size_t)offset);
    layers[1].color_mode = color_mode;
    layers[1].width = (uint16_t)cmd->src.w;
    layers[1].height = (uint16_t)cmd->src.h;
    layers[1].total_width = (uint16_t)texture->width;
    layers[1].x_offset = (int16_t)cmd->dst.x;
    layers[1].y_offset = (int16_t)cmd->dst.y;
    layers[1].alpha = alpha;
    layers[1].transform_cfg.pivot_x = 0;
    layers[1].transform_cfg.pivot_y = 0;
    layers[1].transform_cfg.scale_x = scale_x;
    layers[1].transform_cfg.scale_y = scale_y;
    layers[1].transform_cfg.h_mirror = mirror_x ? 1 : 0;
#if POCKETJS_GPU_HAS_V_MIRROR
    layers[1].transform_cfg.v_mirror = mirror_y ? 1 : 0;
#endif
#if POCKETJS_GPU_HAS_L8
    if (texture->format == POCKETJS_GPU_NATIVE_L8)
    {
        layers[1].lookup_table = (uint8_t *)texture->palette;
        layers[1].lookup_table_size = 256;
    }
#endif

    memcpy(&output, &layers[0], sizeof(output));
    output.color_mode = EPIC_OUTPUT_RGB565;

    started = HAL_DBG_DWT_GetCycles();
    epic_begin();
    return epic_result(HAL_EPIC_BlendStartEx_IT(&g_epic, layers, 2, &output), started);
}

/* Copy an RGB565 rectangle between the target and a tightly packed tile
 * through one opaque input layer. */
static int epic_copy(uint16_t *from, uint32_t from_stride, uint16_t *to,
                     uint32_t to_stride, uint32_t width, uint32_t height)
{
    EPIC_LayerConfigTypeDef layer;
    EPIC_LayerConfigTypeDef output;
    uint32_t started;

    layer_rgb565(&layer, from, from_stride, width, height);
    layer_rgb565(&output, to, to_stride, width, height);
    output.color_mode = EPIC_OUTPUT_RGB565;

    started = HAL_DBG_DWT_GetCycles();
    epic_begin();
    return epic_result(HAL_EPIC_BlendStartEx_IT(&g_epic, &layer, 1, &output), started);
}

int pocketjs_gpu_epic_tile_out(const PocketjsGpuCmd *cmd)
{
    size_t tile_len = 0;
    uint16_t *tile = pocketjs_gpu_tile_base(cmd->tile_id, &tile_len);
    const PocketjsGpuRect *src = &cmd->clip;

    if (!g_ready || tile == NULL || !pocketjs_gpu_rect_in_target(src) || !addressable(src) ||
        (size_t)src->w * src->h > tile_len)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    return epic_copy(target_at(src->x, src->y), pocketjs_gpu_target()->width, tile, src->w,
                     src->w, src->h);
}

int pocketjs_gpu_epic_tile_in(const PocketjsGpuCmd *cmd)
{
    size_t tile_len = 0;
    uint16_t *tile = pocketjs_gpu_tile_base(cmd->tile_id, &tile_len);
    const PocketjsGpuRect *dst = &cmd->dst;

    if (!g_ready || tile == NULL || !pocketjs_gpu_rect_in_target(dst) || !addressable(dst) ||
        (size_t)dst->w * dst->h > tile_len)
    {
        return POCKETJS_GPU_EXEC_REJECT;
    }
    /* The CPU wrote the tile: clean it (no-op for SRAM) before EPIC reads. */
    mpu_dcache_clean(tile, (uint32_t)((size_t)dst->w * dst->h * sizeof(uint16_t)));
    return epic_copy(tile, dst->w, target_at(dst->x, dst->y), pocketjs_gpu_target()->width,
                     dst->w, dst->h);
}
