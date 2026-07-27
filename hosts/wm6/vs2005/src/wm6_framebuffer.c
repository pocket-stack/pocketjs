#define COBJMACROS
#include <windows.h>
#include <ddraw.h>

#include "wm6_framebuffer.h"

static LPDIRECTDRAW g_direct_draw;
static LPDIRECTDRAWSURFACE g_primary;
static unsigned short g_pixels[WM6_FB_WIDTH * WM6_FB_HEIGHT];

static int read_number(const char **cursor)
{
    int value;

    if (**cursor == '|')
        (*cursor)++;
    value = 0;
    while (**cursor >= '0' && **cursor <= '9') {
        value = value * 10 + (**cursor - '0');
        (*cursor)++;
    }
    return value;
}

static unsigned short rgb565(int red, int green, int blue)
{
    return (unsigned short)(((red & 0xf8) << 8) |
                            ((green & 0xfc) << 3) |
                            (blue >> 3));
}

static void fill_rect(int x, int y, int width, int height,
                      unsigned short color)
{
    int left;
    int top;
    int right;
    int bottom;
    int row;
    int column;

    left = x < 0 ? 0 : x;
    top = y < 0 ? 0 : y;
    right = x + width;
    bottom = y + height;
    if (right > WM6_FB_WIDTH)
        right = WM6_FB_WIDTH;
    if (bottom > WM6_FB_HEIGHT)
        bottom = WM6_FB_HEIGHT;
    if (left >= right || top >= bottom)
        return;
    for (row = top; row < bottom; row++) {
        unsigned short *destination;

        destination = &g_pixels[row * WM6_FB_WIDTH + left];
        for (column = left; column < right; column++)
            *destination++ = color;
    }
}

static DWORD pack_component(unsigned int value, DWORD mask)
{
    DWORD shifted;
    DWORD maximum;
    int shift;

    if (!mask)
        return 0;
    shift = 0;
    shifted = mask;
    while ((shifted & 1u) == 0) {
        shifted >>= 1;
        shift++;
    }
    maximum = shifted;
    return (((DWORD)value * maximum + 127u) / 255u) << shift;
}

static DWORD convert_pixel(unsigned short source, const DDPIXELFORMAT *format)
{
    unsigned int red;
    unsigned int green;
    unsigned int blue;

    red = ((source >> 11) & 31u) * 255u / 31u;
    green = ((source >> 5) & 63u) * 255u / 63u;
    blue = (source & 31u) * 255u / 31u;
    return pack_component(red, format->dwRBitMask) |
           pack_component(green, format->dwGBitMask) |
           pack_component(blue, format->dwBBitMask);
}

int wm6_framebuffer_open(HWND window)
{
    DDSURFACEDESC description;
    HRESULT status;

    wm6_framebuffer_close();
    status = DirectDrawCreate(NULL, &g_direct_draw, NULL);
    if (status != DD_OK || !g_direct_draw)
        return 0;
    status = IDirectDraw_SetCooperativeLevel(
        g_direct_draw, window, DDSCL_NORMAL);
    if (status != DD_OK) {
        wm6_framebuffer_close();
        return 0;
    }
    memset(&description, 0, sizeof(description));
    description.dwSize = sizeof(description);
    description.dwFlags = DDSD_CAPS;
    description.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    status = IDirectDraw_CreateSurface(
        g_direct_draw, &description, &g_primary, NULL);
    if (status != DD_OK || !g_primary) {
        wm6_framebuffer_close();
        return 0;
    }
    return 1;
}

void wm6_framebuffer_close(void)
{
    if (g_primary) {
        IDirectDrawSurface_Release(g_primary);
        g_primary = NULL;
    }
    if (g_direct_draw) {
        IDirectDraw_Release(g_direct_draw);
        g_direct_draw = NULL;
    }
}

int wm6_framebuffer_render(const char *draw_list)
{
    const char *line;

    if (!draw_list)
        return 0;
    fill_rect(0, 0, WM6_FB_WIDTH, WM6_FB_HEIGHT, rgb565(0, 0, 0));
    line = draw_list;
    while (*line) {
        const char *cursor;
        int x;
        int y;
        int width;
        int height;
        int red;
        int green;
        int blue;

        cursor = line + 1;
        if (line[0] == 'B') {
            red = read_number(&cursor);
            green = read_number(&cursor);
            blue = read_number(&cursor);
            fill_rect(0, 0, WM6_FB_WIDTH, WM6_FB_HEIGHT,
                      rgb565(red, green, blue));
        } else if (line[0] == 'R') {
            x = read_number(&cursor);
            y = read_number(&cursor);
            width = read_number(&cursor);
            height = read_number(&cursor);
            red = read_number(&cursor);
            green = read_number(&cursor);
            blue = read_number(&cursor);
            fill_rect(x, y, width, height, rgb565(red, green, blue));
        }
        while (*line && *line != '\n')
            line++;
        if (*line == '\n')
            line++;
    }
    return 1;
}

int wm6_framebuffer_present(void)
{
    DDSURFACEDESC surface;
    HRESULT status;
    int offset_x;
    int offset_y;
    int copy_width;
    int copy_height;
    int source_x;
    int source_y;
    int y;

    if (!g_primary)
        return 0;
    memset(&surface, 0, sizeof(surface));
    surface.dwSize = sizeof(surface);
    status = IDirectDrawSurface_Lock(
        g_primary, NULL, &surface, DDLOCK_WAIT, NULL);
    if (status == DDERR_SURFACELOST) {
        IDirectDrawSurface_Restore(g_primary);
        status = IDirectDrawSurface_Lock(
            g_primary, NULL, &surface, DDLOCK_WAIT, NULL);
    }
    if (status != DD_OK || !surface.lpSurface)
        return 0;

    offset_x = ((int)surface.dwWidth - WM6_FB_WIDTH) / 2;
    offset_y = ((int)surface.dwHeight - WM6_FB_HEIGHT) / 2;
    source_x = offset_x < 0 ? -offset_x : 0;
    source_y = offset_y < 0 ? -offset_y : 0;
    copy_width = WM6_FB_WIDTH - source_x;
    copy_height = WM6_FB_HEIGHT - source_y;
    if (offset_x < 0)
        offset_x = 0;
    if (offset_y < 0)
        offset_y = 0;
    if (copy_width > (int)surface.dwWidth - offset_x)
        copy_width = (int)surface.dwWidth - offset_x;
    if (copy_height > (int)surface.dwHeight - offset_y)
        copy_height = (int)surface.dwHeight - offset_y;

    for (y = 0; y < copy_height; y++) {
        unsigned char *destination;
        const unsigned short *source;
        int x;

        destination = (unsigned char *)surface.lpSurface +
                      (offset_y + y) * surface.lPitch;
        source = &g_pixels[(source_y + y) * WM6_FB_WIDTH + source_x];
        if (surface.ddpfPixelFormat.dwRGBBitCount == 16) {
            unsigned short *pixels;

            pixels = (unsigned short *)destination + offset_x;
            for (x = 0; x < copy_width; x++)
                pixels[x] = (unsigned short)convert_pixel(
                    source[x], &surface.ddpfPixelFormat);
        } else if (surface.ddpfPixelFormat.dwRGBBitCount == 32) {
            DWORD *pixels;

            pixels = (DWORD *)destination + offset_x;
            for (x = 0; x < copy_width; x++)
                pixels[x] = convert_pixel(source[x], &surface.ddpfPixelFormat);
        } else if (surface.ddpfPixelFormat.dwRGBBitCount == 24) {
            unsigned char *pixels;

            pixels = destination + offset_x * 3;
            for (x = 0; x < copy_width; x++) {
                DWORD color;

                color = convert_pixel(source[x], &surface.ddpfPixelFormat);
                pixels[x * 3] = (unsigned char)color;
                pixels[x * 3 + 1] = (unsigned char)(color >> 8);
                pixels[x * 3 + 2] = (unsigned char)(color >> 16);
            }
        } else {
            IDirectDrawSurface_Unlock(g_primary, surface.lpSurface);
            return 0;
        }
    }
    IDirectDrawSurface_Unlock(g_primary, surface.lpSurface);
    return 1;
}
