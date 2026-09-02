/*
 * Per-chip constants for the PocketJS GPU queue, derived from the SiFli SDK
 * feature gates (bf0_hal_epic.h) and the board configuration. These become
 * the executor's capabilities; the renderer never issues a command the chip
 * cannot run.
 */
#ifndef POCKETJS_GPU_CHIP_H
#define POCKETJS_GPU_CHIP_H

#include "rtconfig.h"

#include "bf0_hal.h"
#include "bf0_hal_epic.h"

#if defined(SF32LB58X)
#define POCKETJS_GPU_CHIP 58
#elif defined(SF32LB57X)
#define POCKETJS_GPU_CHIP 57
#elif defined(SF32LB56X)
#define POCKETJS_GPU_CHIP 56
#elif defined(SF32LB52X)
#define POCKETJS_GPU_CHIP 52
#elif defined(SF32LB55X)
#define POCKETJS_GPU_CHIP 55
#else
#error "pocketjs_gpu: unsupported SiFli chip"
#endif

/* Largest extent per axis a transaction may address after the HAL re-bases
 * every layer to its minimum corner: 1010 on 55x/56x/58x, 505 on 52x/57x. */
#define POCKETJS_GPU_COORD_MAX ((uint32_t)EPIC_COORDINATES_MAX)

/* A8 coverage layers with a fixed color (EPIC_SUPPORT_A8: everything after
 * 55x). */
#ifdef EPIC_SUPPORT_A8
#define POCKETJS_GPU_HAS_A8 1
#else
#define POCKETJS_GPU_HAS_A8 0
#endif

/* 8-bit indexed native textures with a hardware lookup table. */
#ifdef EPIC_SUPPORT_L8
#define POCKETJS_GPU_HAS_L8 1
#else
#define POCKETJS_GPU_HAS_L8 0
#endif

/* Vertical mirroring on the video layer exists on 52x/57x only. */
#if defined(SF32LB52X) || defined(SF32LB57X)
#define POCKETJS_GPU_HAS_V_MIRROR 1
#else
#define POCKETJS_GPU_HAS_V_MIRROR 0
#endif

/* VG Lite (V2D GPU) exists on 58x only and needs the SDK's USING_VGLITE. */
#if defined(SF32LB58X) && defined(USING_VGLITE) && defined(POCKETJS_GPU_VGLITE)
#define POCKETJS_GPU_HAS_VGLITE 1
#else
#define POCKETJS_GPU_HAS_VGLITE 0
#endif

#endif
