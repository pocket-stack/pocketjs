#ifndef POCKETJS_WM6_FRAMEBUFFER_H
#define POCKETJS_WM6_FRAMEBUFFER_H

#include <windows.h>

#define WM6_FB_WIDTH 480
#define WM6_FB_HEIGHT 272

int wm6_framebuffer_open(HWND window);
void wm6_framebuffer_close(void);
int wm6_framebuffer_render(const char *draw_list);
int wm6_framebuffer_present(void);

#endif
