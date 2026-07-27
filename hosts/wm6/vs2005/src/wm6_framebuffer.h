#ifndef POCKETJS_WM6_FRAMEBUFFER_H
#define POCKETJS_WM6_FRAMEBUFFER_H

#include <windows.h>

int wm6_framebuffer_open(HWND window, int logical_width, int logical_height);
void wm6_framebuffer_close(void);
int wm6_framebuffer_copy_argb(
    const unsigned char *pixels,
    unsigned int width,
    unsigned int height,
    unsigned int stride,
    unsigned int byte_length);
int wm6_framebuffer_present(void);

#endif
