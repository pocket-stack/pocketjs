#ifndef POCKETJS_3DS_MEDIA_H
#define POCKETJS_3DS_MEDIA_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <citro3d.h>
bool media_start(void);
void media_stop(void);
bool media_open(const char *host, unsigned port, const char *token);
bool media_open_local(const char *key, unsigned position_ms);
bool media_caption_snapshot(char *out, size_t capacity);
void media_close(void);
void media_paused(bool paused);
void media_volume(float volume);
int32_t media_texture_handle(void);
void media_forget_guest(void);
void media_snapshot(char *out, size_t capacity);
/* GPU-idle UI frame boundary; at most one fixed-size GPU transfer. */
void media_present(void);
C3D_Tex *media_texture(int32_t handle);
#endif
