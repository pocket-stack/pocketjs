#include <windows.h>
#include <ddraw.h>

#include "wm6_framebuffer.h"

/*
 * The WM6 Professional SDK's legacy ddraw.h omits this public DirectDraw
 * capability spelling even though CreateSurface accepts its documented value.
 */
#ifndef DDSCAPS_OFFSCREENPLAIN
#define DDSCAPS_OFFSCREENPLAIN 0x00000040L
#endif

static LPDIRECTDRAW g_direct_draw;
static LPDIRECTDRAWSURFACE g_primary;
static LPDIRECTDRAWSURFACE g_offscreen;
static unsigned short *g_pixels;
static DWORD *g_gdi_pixels;
static BITMAPINFO g_bitmap_info;
static HWND g_window;
static int g_width;
static int g_height;
static int g_surface_reported;
static int g_directdraw_disabled;
static int g_gdi_reported;

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

static int resolve_surface_pixel_format(
    LPDIRECTDRAWSURFACE target,
    const DDSURFACEDESC *surface,
    DDPIXELFORMAT *format)
{
    HRESULT status;

    memset(format, 0, sizeof(*format));
    format->dwSize = sizeof(*format);
    status = target->lpVtbl->GetPixelFormat(target, format);
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

static void release_directdraw(void)
{
    if (g_offscreen) {
        g_offscreen->lpVtbl->Release(g_offscreen);
        g_offscreen = NULL;
    }
    if (g_primary) {
        g_primary->lpVtbl->Release(g_primary);
        g_primary = NULL;
    }
    if (g_direct_draw) {
        g_direct_draw->lpVtbl->Release(g_direct_draw);
        g_direct_draw = NULL;
    }
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
    g_gdi_pixels = (DWORD *)LocalAlloc(
        LMEM_FIXED, pixel_count * sizeof(DWORD));
    if (!g_pixels || !g_gdi_pixels) {
        wm6_framebuffer_close();
        return 0;
    }
    memset(&g_bitmap_info, 0, sizeof(g_bitmap_info));
    g_bitmap_info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    g_bitmap_info.bmiHeader.biWidth = logical_width;
    g_bitmap_info.bmiHeader.biHeight = logical_height;
    g_bitmap_info.bmiHeader.biPlanes = 1;
    g_bitmap_info.bmiHeader.biBitCount = 32;
    g_bitmap_info.bmiHeader.biCompression = BI_RGB;
    g_bitmap_info.bmiHeader.biSizeImage =
        pixel_count * sizeof(DWORD);
    g_window = window;
    g_width = logical_width;
    g_height = logical_height;
    g_surface_reported = 0;
    g_directdraw_disabled = 0;
    g_gdi_reported = 0;

    status = DirectDrawCreate(NULL, &g_direct_draw, NULL);
    if (status != DD_OK || !g_direct_draw) {
        g_directdraw_disabled = 1;
        OutputDebugString(
            L"PocketJS WM6: DirectDraw unavailable; using GDI DIB\r\n");
        release_directdraw();
        return 1;
    }
    status = g_direct_draw->lpVtbl->SetCooperativeLevel(
        g_direct_draw, window, DDSCL_NORMAL);
    if (status != DD_OK) {
        g_directdraw_disabled = 1;
        OutputDebugString(
            L"PocketJS WM6: DirectDraw cooperative level failed; "
            L"using GDI DIB\r\n");
        release_directdraw();
        return 1;
    }
    memset(&description, 0, sizeof(description));
    description.dwSize = sizeof(description);
    description.dwFlags = DDSD_CAPS;
    description.ddsCaps.dwCaps = DDSCAPS_PRIMARYSURFACE;
    status = g_direct_draw->lpVtbl->CreateSurface(
        g_direct_draw, &description, &g_primary, NULL);
    if (status != DD_OK || !g_primary) {
        g_directdraw_disabled = 1;
        OutputDebugString(
            L"PocketJS WM6: DirectDraw primary unavailable; "
            L"using GDI DIB\r\n");
        release_directdraw();
        return 1;
    }
    memset(&description, 0, sizeof(description));
    description.dwSize = sizeof(description);
    description.dwFlags = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;
    description.dwWidth = (DWORD)logical_width;
    description.dwHeight = (DWORD)logical_height;
    description.ddsCaps.dwCaps =
        DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY;
    status = g_direct_draw->lpVtbl->CreateSurface(
        g_direct_draw, &description, &g_offscreen, NULL);
    if (status != DD_OK || !g_offscreen) {
        /*
         * Some CE drivers choose the only lockable heap themselves and
         * reject an explicit SYSTEMMEMORY request.
         */
        if (g_offscreen) {
            g_offscreen->lpVtbl->Release(g_offscreen);
            g_offscreen = NULL;
        }
        description.ddsCaps.dwCaps = DDSCAPS_OFFSCREENPLAIN;
        status = g_direct_draw->lpVtbl->CreateSurface(
            g_direct_draw, &description, &g_offscreen, NULL);
    }
    if (status != DD_OK || !g_offscreen) {
        WCHAR receipt[128];

        wsprintfW(
            receipt,
            L"PocketJS WM6 DirectDraw: offscreen create failed "
            L"hr=%08lx\r\n",
            (DWORD)status);
        OutputDebugString(receipt);
        g_directdraw_disabled = 1;
        release_directdraw();
        return 1;
    }
    return 1;
}

void wm6_framebuffer_close(void)
{
    release_directdraw();
    if (g_pixels) {
        LocalFree(g_pixels);
        g_pixels = NULL;
    }
    if (g_gdi_pixels) {
        LocalFree(g_gdi_pixels);
        g_gdi_pixels = NULL;
    }
    memset(&g_bitmap_info, 0, sizeof(g_bitmap_info));
    g_window = NULL;
    g_width = 0;
    g_height = 0;
    g_surface_reported = 0;
    g_directdraw_disabled = 0;
    g_gdi_reported = 0;
}

int wm6_framebuffer_copy_argb(
    const unsigned char *pixels,
    unsigned int width,
    unsigned int height,
    unsigned int stride,
    unsigned int byte_length)
{
    unsigned int row;

    if (!pixels || !g_pixels || !g_gdi_pixels ||
        width != (unsigned int)g_width ||
        height != (unsigned int)g_height || stride < width * 4u ||
        height > byte_length / stride)
        return 0;
    for (row = 0; row < height; row++) {
        const unsigned char *source;
        unsigned short *destination;
        DWORD *gdi_destination;
        unsigned int column;

        source = pixels + row * stride;
        destination = g_pixels + row * width;
        gdi_destination =
            g_gdi_pixels + (height - row - 1u) * width;
        for (column = 0; column < width; column++) {
            /* PocketJS exposes little-endian ARGB32: B, G, R, A bytes. */
            destination[column] = rgb565(
                source[column * 4u + 2u],
                source[column * 4u + 1u],
                source[column * 4u]);
            gdi_destination[column] =
                ((DWORD)source[column * 4u + 2u] << 16) |
                ((DWORD)source[column * 4u + 1u] << 8) |
                (DWORD)source[column * 4u];
        }
    }
    return 1;
}

static int present_directdraw(void)
{
    DDSURFACEDESC offscreen;
    DDSURFACEDESC primary;
    DDPIXELFORMAT pixel_format;
    RECT source_rect;
    RECT destination_rect;
    HRESULT status;
    int destination_width;
    int destination_height;
    int primary_width;
    int primary_height;
    int bytes_per_pixel;
    int pitch;
    int y;

    if (!g_primary || !g_offscreen || !g_pixels ||
        g_width <= 0 || g_height <= 0)
        return 0;
    memset(&offscreen, 0, sizeof(offscreen));
    offscreen.dwSize = sizeof(offscreen);
    if (!g_surface_reported)
        OutputDebugString(
            L"PocketJS WM6 trace: DirectDraw offscreen lock begin\r\n");
    status = g_offscreen->lpVtbl->Lock(
        g_offscreen, NULL, &offscreen, 0, NULL);
    if (status == DDERR_SURFACELOST) {
        g_offscreen->lpVtbl->Restore(g_offscreen);
        status = g_offscreen->lpVtbl->Lock(
            g_offscreen, NULL, &offscreen, 0, NULL);
    }
    if (status != DD_OK || !offscreen.lpSurface) {
        WCHAR receipt[128];

        wsprintfW(
            receipt,
            L"PocketJS WM6 DirectDraw: offscreen lock failed "
            L"hr=%08lx\r\n",
            (DWORD)status);
        OutputDebugString(receipt);
        return 0;
    }
    if (!resolve_surface_pixel_format(
            g_offscreen, &offscreen, &pixel_format)) {
        g_offscreen->lpVtbl->Unlock(
            g_offscreen, offscreen.lpSurface);
        return 0;
    }
    if ((int)offscreen.dwWidth != g_width ||
        (int)offscreen.dwHeight != g_height) {
        g_offscreen->lpVtbl->Unlock(
            g_offscreen, offscreen.lpSurface);
        return 0;
    }
    bytes_per_pixel = (int)pixel_format.dwRGBBitCount / 8;
    if (bytes_per_pixel != 2 && bytes_per_pixel != 3 &&
        bytes_per_pixel != 4) {
        g_offscreen->lpVtbl->Unlock(
            g_offscreen, offscreen.lpSurface);
        return 0;
    }
    pitch = offscreen.lPitch < 0
                ? -offscreen.lPitch
                : offscreen.lPitch;
    if (g_width * bytes_per_pixel > pitch) {
        g_offscreen->lpVtbl->Unlock(
            g_offscreen, offscreen.lpSurface);
        return 0;
    }
    for (y = 0; y < g_height; y++) {
        unsigned char *destination;
        const unsigned short *source;
        int x;

        destination = (unsigned char *)offscreen.lpSurface +
                      y * offscreen.lPitch;
        source = &g_pixels[y * g_width];
        if (pixel_format.dwRGBBitCount == 16) {
            unsigned short *output;

            output = (unsigned short *)destination;
            for (x = 0; x < g_width; x++)
                output[x] = (unsigned short)convert_pixel(
                    source[x], &pixel_format);
        } else if (pixel_format.dwRGBBitCount == 32) {
            DWORD *output;

            output = (DWORD *)destination;
            for (x = 0; x < g_width; x++)
                output[x] = convert_pixel(
                    source[x], &pixel_format);
        } else {
            unsigned char *output;

            output = destination;
            for (x = 0; x < g_width; x++) {
                DWORD color;

                color = convert_pixel(source[x], &pixel_format);
                output[x * 3] = (unsigned char)color;
                output[x * 3 + 1] = (unsigned char)(color >> 8);
                output[x * 3 + 2] = (unsigned char)(color >> 16);
            }
        }
    }
    status = g_offscreen->lpVtbl->Unlock(
        g_offscreen, offscreen.lpSurface);
    if (status != DD_OK)
        return 0;

    memset(&primary, 0, sizeof(primary));
    primary.dwSize = sizeof(primary);
    status = g_primary->lpVtbl->GetSurfaceDesc(g_primary, &primary);
    if (status == DDERR_SURFACELOST) {
        g_primary->lpVtbl->Restore(g_primary);
        status = g_primary->lpVtbl->GetSurfaceDesc(
            g_primary, &primary);
    }
    primary_width = (int)primary.dwWidth;
    primary_height = (int)primary.dwHeight;
    if (status != DD_OK ||
        primary_width <= 0 || primary_height <= 0)
        return 0;
    if (primary_width * g_height <= primary_height * g_width) {
        destination_width = primary_width;
        destination_height = g_height * primary_width / g_width;
    } else {
        destination_height = primary_height;
        destination_width = g_width * primary_height / g_height;
    }
    destination_rect.left =
        (primary_width - destination_width) / 2;
    destination_rect.top =
        (primary_height - destination_height) / 2;
    destination_rect.right =
        destination_rect.left + destination_width;
    destination_rect.bottom =
        destination_rect.top + destination_height;
    source_rect.left = 0;
    source_rect.top = 0;
    source_rect.right = g_width;
    source_rect.bottom = g_height;

    status = g_primary->lpVtbl->Blt(
        g_primary,
        &destination_rect,
        g_offscreen,
        &source_rect,
        0,
        NULL);
    if (status == DDERR_SURFACELOST) {
        g_primary->lpVtbl->Restore(g_primary);
        status = g_primary->lpVtbl->Blt(
            g_primary,
            &destination_rect,
            g_offscreen,
            &source_rect,
            0,
            NULL);
    }
    if (status != DD_OK) {
        WCHAR receipt[128];

        wsprintfW(
            receipt,
            L"PocketJS WM6 DirectDraw: primary Blt failed "
            L"hr=%08lx\r\n",
            (DWORD)status);
        OutputDebugString(receipt);
        return 0;
    }
    if (!g_surface_reported) {
        WCHAR receipt[256];

        wsprintfW(
            receipt,
            L"PocketJS WM6 receipt: DirectDraw offscreen=%ldx%ld "
            L"pitch=%ld rgb=%lu masks=%08lx/%08lx/%08lx "
            L"primary=%ldx%ld\r\n",
            (LONG)offscreen.dwWidth,
            (LONG)offscreen.dwHeight,
            (LONG)offscreen.lPitch,
            pixel_format.dwRGBBitCount,
            pixel_format.dwRBitMask,
            pixel_format.dwGBitMask,
            pixel_format.dwBBitMask,
            (LONG)primary_width,
            (LONG)primary_height);
        OutputDebugString(receipt);
        g_surface_reported = 1;
    }
    return 1;
}

static int present_gdi(void)
{
    HDC dc;
    RECT client;
    int client_width;
    int client_height;
    int destination_width;
    int destination_height;
    int offset_x;
    int offset_y;
    int status;

    if (!g_window || !g_gdi_pixels ||
        g_width <= 0 || g_height <= 0)
        return 0;
    if (!GetClientRect(g_window, &client))
        return 0;
    client_width = client.right - client.left;
    client_height = client.bottom - client.top;
    if (client_width <= 0 || client_height <= 0)
        return 0;
    if (client_width * g_height <= client_height * g_width) {
        destination_width = client_width;
        destination_height =
            g_height * client_width / g_width;
    } else {
        destination_height = client_height;
        destination_width =
            g_width * client_height / g_height;
    }
    offset_x = (client_width - destination_width) / 2;
    offset_y = (client_height - destination_height) / 2;
    dc = GetDC(g_window);
    if (!dc)
        return 0;
    status = StretchDIBits(
        dc,
        offset_x,
        offset_y,
        destination_width,
        destination_height,
        0,
        0,
        g_width,
        g_height,
        g_gdi_pixels,
        &g_bitmap_info,
        DIB_RGB_COLORS,
        SRCCOPY);
    ReleaseDC(g_window, dc);
    if (!status) {
        WCHAR receipt[128];

        wsprintfW(
            receipt,
            L"PocketJS WM6 GDI: StretchDIBits failed error=%lu\r\n",
            GetLastError());
        OutputDebugString(receipt);
        return 0;
    }
    if (!g_gdi_reported) {
        WCHAR receipt[160];

        wsprintfW(
            receipt,
            L"PocketJS WM6 receipt: GDI DIB fallback=%ldx%ld "
            L"client=%ldx%ld\r\n",
            (LONG)g_width,
            (LONG)g_height,
            (LONG)client_width,
            (LONG)client_height);
        OutputDebugString(receipt);
        g_gdi_reported = 1;
    }
    return 1;
}

int wm6_framebuffer_present(void)
{
    if (!g_directdraw_disabled) {
        if (present_directdraw())
            return 1;
        g_directdraw_disabled = 1;
        release_directdraw();
        OutputDebugString(
            L"PocketJS WM6: DirectDraw presentation failed; "
            L"using GDI DIB\r\n");
    }
    return present_gdi();
}
