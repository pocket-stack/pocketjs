#ifndef POCKETJS_3DS_GFX_H
#define POCKETJS_3DS_GFX_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The PICA200 DrawList backend. gfx_init builds the shader, the attribute
 * layout and the linear-memory vertex arena once; gfx_render walks one frame's
 * word stream and issues the citro3d draws for it.
 *
 * gfx_render must run between C3D_FrameDrawOn/C3D_SetViewport and
 * C3D_FrameEnd: it writes into the vertex arena that the previous frame's
 * draws read, and C3D_FrameBegin(C3D_FRAME_SYNCDRAW) is what guarantees those
 * are finished.
 */
bool gfx_init(uint32_t logical_width, uint32_t logical_height);
void gfx_render(const uint32_t *words, size_t length);
void gfx_shutdown(void);

/* Vertices dropped because the frame overflowed the arena, cumulative. Zero
 * on every frame a real app draws; non-zero means geometry is missing. */
uint32_t gfx_dropped_vertices(void);

/* The batch and vertex counts of the most recently built frame. */
uint32_t gfx_frame_commands(void);
uint32_t gfx_frame_vertices(void);

#endif
