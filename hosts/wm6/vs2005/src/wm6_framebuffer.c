#include <windows.h>
#include <ddraw.h>

#include "wm6_framebuffer.h"

static LPDIRECTDRAW g_direct_draw;
static LPDIRECTDRAWSURFACE g_primary;
static unsigned short *g_pixels;
static int g_width;
static int g_height;

static unsigned short rgb565(
    unsigned int red,
    unsigned int green,
    unsigned int blue)
{
    return (unsigned short)(((red & 0xf8u) << 8) |
                            ((green & 0xfcu) << 3) |
                            (blue >> 3));
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

static DWORD convert_pixel(
    unsigned short source,
    const DDPIXELFORMAT *format)
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

static int resolve_primary_pixel_format(
    const DDSURFACEDESC *surface,
    DDPIXELFORMAT *format)
{
    HRESULT status;

    memset(format, 0, sizeof(*format));
    format->dwSize = sizeof(*format);
    status = g_primary->lpVtbl->GetPixelFormat(g_primary, format);
    if (status != DD_OK || format->dwRGBBitCount == 0)
        *format = surface->ddpfPixelFormat;
    if (format->dwRGBBitCount == 16 &&
        (!format->dwRBitMask || !format->dwGBitMask ||
         !format->dwBBitMask)) {
        format->dwRBitMask = 0xf800u;
        format->dwGBitMask = 0x07e0u;
        format->dwBBitMask = 0x001fu;
    } else if ((format->dwRGBBitCount == 24 ||
                format->dwRGBBitCount == 32) &&
               (!format->dwRBitMask || !format->dwGBitMask ||
                !format->dwBBitMask)) {
        format->dwRBitMask = 0x00ff0000u;
        format->dwGBitMask = 0x0000ff00u;
        format->dwBBitMask = 0x000000ffu;
    }
    return (format->dwRGBBitCount == 16 ||
            format->dwRGBBitCount == 24 ||
            format->dwRGBBitCount == 32) &&
           format->dwRBitMask && format->dwGBitMask &&
           format->dwBBitMask;
}

int wm6_framebuffer_open(HWND window, int logical_width, int logical_height)
{
    DDSURFACEDESC description;
    HRESULT status;
    unsigned int pixel_count;

    wm6_framebuffer_close();
    if (logical_width <= 0 || logical_height <= 0 ||
        logical_width > 2048 || logical_height > 2048)
        return 0;
    pixel_count = (unsigned int)logical_width *
                  (unsigned int)logical_height;
    g_pixels = (unsigned short *)LocalAlloc(
        LMEM_FIXED, pixel_count * sizeof(unsigned short));
    if (!g_pixels)
        return 0;
    g_width = logical_width;
    g_height = logical_height;

    status = DirectDrawCreate(NULL, &g_direct_draw, NULL);
    if (status != DD_OK || !g_direct_draw) {
        wm6_framebuffer_close();
        return 0;
    }
    status = g_direct_draw->lpVtbl->SetCooperativeLevel(
        g_direct_draw, window, DDSCL_NORMAL);
    if (status != DD_OK) {
        wm6_framebuffer_close();
        return 0;
    }
    memset(&description, 0, sizeof(description));
    description.dwSize = sizeof(description);
    description.dwFlags = DDSD_CAPS;
    description.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    status = g_direct_draw->lpVtbl->CreateSurface(
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
        g_primary->lpVtbl->Release(g_primary);
        g_primary = NULL;
    }
    if (g_direct_draw) {
        g_direct_draw->lpVtbl->Release(g_direct_draw);
        g_direct_draw = NULL;
    }
    if (g_pixels) {
        LocalFree(g_pixels);
        g_pixels = NULL;
    }
    g_width = 0;
    g_height = 0;
}

int wm6_framebuffer_copy_argb(
    const unsigned char *pixels,
    unsigned int width,
    unsigned int height,
    unsigned int stride,
    unsigned int byte_length)
{
    unsigned int row;

    if (!pixels || !g_pixels || width != (unsigned int)g_width ||
        height != (unsigned int)g_height || stride < width * 4u ||
        height > byte_length / stride)
        return 0;
    for (row = 0; row < height; row++) {
        const unsigned char *source;
        unsigned short *destination;
        unsigned int column;

        source = pixels + row * stride;
        destination = g_pixels + row * width;
        for (column = 0; column < width; column++) {
            /* PocketJS exposes little-endian ARGB32: B, G, R, A bytes. */
            destination[column] = rgb565(
                source[column * 4u + 2u],
                source[column * 4u + 1u],
                source[column * 4u]);
        }
    }
    return 1;
}

int wm6_framebuffer_present(void)
{
    DDSURFACEDESC surface;
    DDPIXELFORMAT pixel_format;
    HRESULT status;
    int offset_x;
    int offset_y;
    int destination_width;
    int destination_height;
    int surface_width;
    int surface_height;
    int bytes_per_pixel;
    int pitch;
    int y;

    if (!g_primary || !g_pixels || g_width <= 0 || g_height <= 0)
        return 0;
    memset(&surface, 0, sizeof(surface));
    surface.dwSize = sizeof(surface);
    status = g_primary->lpVtbl->Lock(
        g_primary, NULL, &surface, 0, NULL);
    if (status == DDERR_SURFACELOST) {
        g_primary->lpVtbl->Restore(g_primary);
        status = g_primary->lpVtbl->Lock(
            g_primary, NULL, &surface, 0, NULL);
    }
    if (status != DD_OK || !surface.lpSurface)
        return 0;
    if (!resolve_primary_pixel_format(&surface, &pixel_format)) {
        g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
        return 0;
    }

    surface_width = (int)surface.dwWidth;
    surface_height = (int)surface.dwHeight;
    if (surface_width <= 0 || surface_height <= 0) {
        g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
        return 0;
    }
    if (surface_width * g_height <= surface_height * g_width) {
        destination_width = surface_width;
        destination_height = g_height * surface_width / g_width;
    } else {
        destination_height = surface_height;
        destination_width = g_width * surface_height / g_height;
    }
    if (destination_width <= 0 || destination_height <= 0) {
        g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
        return 0;
    }
    offset_x = (surface_width - destination_width) / 2;
    offset_y = (surface_height - destination_height) / 2;
    bytes_per_pixel = (int)pixel_format.dwRGBBitCount / 8;
    if (bytes_per_pixel != 2 && bytes_per_pixel != 3 &&
        bytes_per_pixel != 4) {
        g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
        return 0;
    }
    pitch = surface.lPitch < 0 ? -surface.lPitch : surface.lPitch;
    if (surface_width * bytes_per_pixel > pitch) {
        g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
        return 0;
    }
    for (y = 0; y < surface_height; y++)
        memset((unsigned char *)surface.lpSurface + y * surface.lPitch,
               0, surface_width * bytes_per_pixel);

    for (y = 0; y < destination_height; y++) {
        unsigned char *destination;
        const unsigned short *source;
        int source_y;
        int x;

        source_y = y * g_height / destination_height;
        destination = (unsigned char *)surface.lpSurface +
                      (offset_y + y) * surface.lPitch;
        source = &g_pixels[source_y * g_width];
        if (pixel_format.dwRGBBitCount == 16) {
            unsigned short *output;

            output = (unsigned short *)destination + offset_x;
            for (x = 0; x < destination_width; x++) {
                int source_x;

                source_x = x * g_width / destination_width;
                output[x] = (unsigned short)convert_pixel(
                    source[source_x], &pixel_format);
            }
        } else if (pixel_format.dwRGBBitCount == 32) {
            DWORD *output;

            output = (DWORD *)destination + offset_x;
            for (x = 0; x < destination_width; x++) {
                int source_x;

                source_x = x * g_width / destination_width;
                output[x] = convert_pixel(
                    source[source_x], &pixel_format);
            }
        } else {
            unsigned char *output;

            output = destination + offset_x * 3;
            for (x = 0; x < destination_width; x++) {
                DWORD color;
                int source_x;

                source_x = x * g_width / destination_width;
                color = convert_pixel(source[source_x], &pixel_format);
                output[x * 3] = (unsigned char)color;
                output[x * 3 + 1] = (unsigned char)(color >> 8);
                output[x * 3 + 2] = (unsigned char)(color >> 16);
            }
        }
    }
    g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
    return 1;
}
