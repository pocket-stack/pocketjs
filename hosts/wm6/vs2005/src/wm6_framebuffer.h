#ifndef POCKETJS_WM6_FRAMEBUFFER_H
#define POCKETJS_WM6_FRAMEBUFFER_H

#include <windows.h>

int wm6_framebuffer_open(HWND window, int logical_width, int logical_height);
int wm6_framebuffer_load_pak(const WCHAR *path);
void wm6_framebuffer_close(void);
int wm6_framebuffer_render(const char *draw_list);
int wm6_framebuffer_present(void);

#endif
