#include <windows.h>
#include <ddraw.h>

#include "wm6_framebuffer.h"

static LPDIRECTDRAW g_direct_draw;
static LPDIRECTDRAWSURFACE g_primary;
static unsigned short *g_pixels;
static int g_width;
static int g_height;
static unsigned char *g_pak;
static unsigned int g_pak_size;

#define WM6_MAX_FONT_SLOTS 16
#define WM6_MAX_IMAGES 10
#define WM6_PAK_MAGIC 0x4b504344u
#define WM6_PAK_ENTRY_SIZE 24u
#define WM6_FONT_MAGIC 0x41464344u
#define WM6_FONT_HEADER_SIZE 16u
#define WM6_FONT_CMAP_SIZE 8u

typedef struct Wm6FontAtlas {
    const unsigned char *cmap;
    const unsigned char *bitmap;
    unsigned short glyph_count;
    unsigned char cell_width;
    unsigned char cell_height;
    unsigned char density;
} Wm6FontAtlas;

typedef struct Wm6Image {
    const unsigned char *pixels;
    unsigned short width;
    unsigned short height;
    unsigned char format;
} Wm6Image;

static Wm6FontAtlas g_fonts[WM6_MAX_FONT_SLOTS];
static Wm6Image g_images[WM6_MAX_IMAGES];

static unsigned short read_u16(const unsigned char *bytes)
{
    return (unsigned short)(bytes[0] | ((unsigned short)bytes[1] << 8));
}

static unsigned int read_u32(const unsigned char *bytes)
{
    return (unsigned int)bytes[0] |
           ((unsigned int)bytes[1] << 8) |
           ((unsigned int)bytes[2] << 16) |
           ((unsigned int)bytes[3] << 24);
}

static int range_valid(unsigned int offset, unsigned int length,
                       unsigned int total)
{
    return offset <= total && length <= total - offset;
}

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

static void blend_pixel(int x, int y, int red, int green, int blue,
                        unsigned int alpha)
{
    unsigned short destination;
    unsigned int inverse;
    int destination_red;
    int destination_green;
    int destination_blue;

    if (x < 0 || x >= g_width || y < 0 || y >= g_height ||
        alpha == 0)
        return;
    destination = g_pixels[y * g_width + x];
    destination_red = (int)(((destination >> 11) & 31u) * 255u / 31u);
    destination_green = (int)(((destination >> 5) & 63u) * 255u / 63u);
    destination_blue = (int)((destination & 31u) * 255u / 31u);
    inverse = 255u - alpha;
    red = (int)(((unsigned int)red * alpha +
                 (unsigned int)destination_red * inverse + 127u) / 255u);
    green = (int)(((unsigned int)green * alpha +
                   (unsigned int)destination_green * inverse + 127u) / 255u);
    blue = (int)(((unsigned int)blue * alpha +
                  (unsigned int)destination_blue * inverse + 127u) / 255u);
    g_pixels[y * g_width + x] = rgb565(red, green, blue);
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
    if (right > g_width)
        right = g_width;
    if (bottom > g_height)
        bottom = g_height;
    if (left >= right || top >= bottom)
        return;
    for (row = top; row < bottom; row++) {
        unsigned short *destination;

        destination = &g_pixels[row * g_width + left];
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

static int resolve_primary_pixel_format(const DDSURFACEDESC *surface,
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

static int parse_font_atlas(const unsigned char *blob, unsigned int length)
{
    Wm6FontAtlas *atlas;
    unsigned int glyph_count;
    unsigned int coverage_width;
    unsigned int coverage_height;
    unsigned int bitmap_offset;
    unsigned int bitmap_length;
    unsigned int slot;
    unsigned int density;

    if (length < WM6_FONT_HEADER_SIZE || read_u32(blob) != WM6_FONT_MAGIC)
        return 0;
    glyph_count = read_u16(blob + 6);
    slot = blob[12];
    density = blob[14];
    if (read_u16(blob + 4) != 3 || glyph_count == 0 ||
        slot >= WM6_MAX_FONT_SLOTS || blob[8] == 0 || blob[9] == 0 ||
        density == 0)
        return 0;
    if (glyph_count > (length - WM6_FONT_HEADER_SIZE) / WM6_FONT_CMAP_SIZE)
        return 0;
    bitmap_offset = WM6_FONT_HEADER_SIZE +
                    glyph_count * WM6_FONT_CMAP_SIZE;
    coverage_width = (unsigned int)blob[8] * density;
    coverage_height = (unsigned int)blob[9] * density;
    if (coverage_width == 0 || coverage_height == 0 ||
        glyph_count > (length - bitmap_offset) /
                      coverage_width / coverage_height)
        return 0;
    bitmap_length = glyph_count * coverage_width * coverage_height;
    if (!range_valid(bitmap_offset, bitmap_length, length))
        return 0;
    atlas = &g_fonts[slot];
    atlas->cmap = blob + WM6_FONT_HEADER_SIZE;
    atlas->bitmap = blob + bitmap_offset;
    atlas->glyph_count = (unsigned short)glyph_count;
    atlas->cell_width = blob[8];
    atlas->cell_height = blob[9];
    atlas->density = (unsigned char)density;
    return 1;
}

static int name_equals(const unsigned char *name, unsigned int length,
                       const char *expected)
{
    unsigned int index;

    index = 0;
    while (expected[index]) {
        if (index >= length || name[index] != (unsigned char)expected[index])
            return 0;
        index++;
    }
    return index == length;
}

static int image_handle(const unsigned char *name, unsigned int length)
{
    static const char *names[] = {
        "",
        "ui:img.logo.png",
        "ui:img.spinner-00.svg",
        "ui:img.spinner-01.svg",
        "ui:img.spinner-02.svg",
        "ui:img.spinner-03.svg",
        "ui:img.spinner-04.svg",
        "ui:img.spinner-05.svg",
        "ui:img.spinner-06.svg",
        "ui:img.spinner-07.svg"
    };
    int handle;

    for (handle = 1; handle < WM6_MAX_IMAGES; handle++) {
        if (name_equals(name, length, names[handle]))
            return handle;
    }
    return 0;
}

static int parse_image(int handle, const unsigned char *blob,
                       unsigned int length)
{
    Wm6Image *image;
    unsigned int width;
    unsigned int height;
    unsigned int required;

    if (handle <= 0 || handle >= WM6_MAX_IMAGES || length < 8)
        return 0;
    width = read_u16(blob);
    height = read_u16(blob + 2);
    if (width == 0 || height == 0 || blob[4] != 3 ||
        width > (length - 8) / 4 / height)
        return 0;
    required = width * height * 4;
    if (!range_valid(8, required, length))
        return 0;
    image = &g_images[handle];
    image->pixels = blob + 8;
    image->width = (unsigned short)width;
    image->height = (unsigned short)height;
    image->format = blob[4];
    return 1;
}

int wm6_framebuffer_load_pak(const WCHAR *path)
{
    HANDLE file;
    DWORD size;
    DWORD received;
    unsigned int entry_count;
    unsigned int directory_offset;
    unsigned int names_offset;
    unsigned int index;
    int font_count;

    if (g_pak) {
        LocalFree(g_pak);
        g_pak = NULL;
        g_pak_size = 0;
    }
    memset(g_fonts, 0, sizeof(g_fonts));
    memset(g_images, 0, sizeof(g_images));
    file = CreateFile(path, GENERIC_READ, FILE_SHARE_READ, NULL,
                      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE)
        return 0;
    size = GetFileSize(file, NULL);
    if (size == INVALID_FILE_SIZE || size < 32) {
        CloseHandle(file);
        return 0;
    }
    g_pak = (unsigned char *)LocalAlloc(LMEM_FIXED, size);
    if (!g_pak) {
        CloseHandle(file);
        return 0;
    }
    if (!ReadFile(file, g_pak, size, &received, NULL) || received != size) {
        CloseHandle(file);
        LocalFree(g_pak);
        g_pak = NULL;
        return 0;
    }
    CloseHandle(file);
    g_pak_size = (unsigned int)size;
    if (read_u32(g_pak) != WM6_PAK_MAGIC) {
        wm6_framebuffer_close();
        return 0;
    }
    entry_count = read_u32(g_pak + 8);
    directory_offset = read_u32(g_pak + 12);
    names_offset = read_u32(g_pak + 16);
    if (entry_count > g_pak_size / WM6_PAK_ENTRY_SIZE ||
        !range_valid(directory_offset, entry_count * WM6_PAK_ENTRY_SIZE,
                     g_pak_size)) {
        wm6_framebuffer_close();
        return 0;
    }
    font_count = 0;
    for (index = 0; index < entry_count; index++) {
        const unsigned char *entry;
        unsigned int blob_offset;
        unsigned int blob_length;
        unsigned int name_offset;
        unsigned int name_length;
        int handle;

        entry = g_pak + directory_offset + index * WM6_PAK_ENTRY_SIZE;
        blob_offset = read_u32(entry + 4);
        blob_length = read_u32(entry + 8);
        name_offset = read_u32(entry + 12);
        name_length = read_u16(entry + 16);
        if (!range_valid(blob_offset, blob_length, g_pak_size))
            continue;
        if (blob_length >= 4 &&
            read_u32(g_pak + blob_offset) == WM6_FONT_MAGIC &&
            parse_font_atlas(g_pak + blob_offset, blob_length))
            font_count++;
        if (!range_valid(names_offset, name_offset, g_pak_size) ||
            !range_valid(names_offset + name_offset, name_length, g_pak_size))
            continue;
        handle = image_handle(
            g_pak + names_offset + name_offset, name_length);
        if (handle)
            parse_image(handle, g_pak + blob_offset, blob_length);
    }
    if (font_count == 0) {
        wm6_framebuffer_close();
        return 0;
    }
    return 1;
}

static unsigned int next_codepoint(const unsigned char **cursor)
{
    const unsigned char *text;
    unsigned int codepoint;

    text = *cursor;
    if (text[0] < 0x80) {
        *cursor = text + 1;
        return text[0];
    }
    if ((text[0] & 0xe0) == 0xc0 &&
        (text[1] & 0xc0) == 0x80) {
        codepoint = ((unsigned int)(text[0] & 0x1f) << 6) |
                    (unsigned int)(text[1] & 0x3f);
        *cursor = text + 2;
        return codepoint;
    }
    if ((text[0] & 0xf0) == 0xe0 &&
        (text[1] & 0xc0) == 0x80 &&
        (text[2] & 0xc0) == 0x80) {
        codepoint = ((unsigned int)(text[0] & 0x0f) << 12) |
                    ((unsigned int)(text[1] & 0x3f) << 6) |
                    (unsigned int)(text[2] & 0x3f);
        *cursor = text + 3;
        return codepoint;
    }
    *cursor = text + 1;
    return (unsigned int)'?';
}

static const unsigned char *find_glyph(const Wm6FontAtlas *atlas,
                                       unsigned int codepoint)
{
    unsigned int left;
    unsigned int right;

    left = 0;
    right = atlas->glyph_count;
    while (left < right) {
        unsigned int middle;
        const unsigned char *entry;
        unsigned int candidate;

        middle = left + (right - left) / 2;
        entry = atlas->cmap + middle * WM6_FONT_CMAP_SIZE;
        candidate = read_u32(entry);
        if (candidate < codepoint)
            left = middle + 1;
        else
            right = middle;
    }
    if (left < atlas->glyph_count) {
        const unsigned char *entry;

        entry = atlas->cmap + left * WM6_FONT_CMAP_SIZE;
        if (read_u32(entry) == codepoint)
            return entry;
    }
    return atlas->cmap;
}

static unsigned int logical_coverage(const Wm6FontAtlas *atlas,
                                     unsigned int glyph, int x, int y)
{
    unsigned int density;
    unsigned int coverage_width;
    unsigned int coverage_height;
    unsigned int glyph_size;
    unsigned int sample_x;
    unsigned int sample_y;
    unsigned int sum;

    density = atlas->density;
    coverage_width = (unsigned int)atlas->cell_width * density;
    coverage_height = (unsigned int)atlas->cell_height * density;
    glyph_size = coverage_width * coverage_height;
    sum = 0;
    for (sample_y = 0; sample_y < density; sample_y++) {
        unsigned int row;

        row = glyph * glyph_size +
              ((unsigned int)y * density + sample_y) * coverage_width +
              (unsigned int)x * density;
        for (sample_x = 0; sample_x < density; sample_x++)
            sum += atlas->bitmap[row + sample_x];
    }
    return (sum + density * density / 2) / (density * density);
}

static int draw_text(int x, int y, int slot, int red, int green, int blue,
                     const char *value)
{
    const Wm6FontAtlas *atlas;
    const unsigned char *text;
    int pen_x;

    if (slot < 0 || slot >= WM6_MAX_FONT_SLOTS)
        return 0;
    atlas = &g_fonts[slot];
    if (!atlas->bitmap)
        return 0;
    text = (const unsigned char *)value;
    pen_x = x;
    while (*text && *text != '\n') {
        const unsigned char *glyph_entry;
        unsigned int codepoint;
        unsigned int glyph;
        int glyph_x;
        int row;
        int column;

        codepoint = next_codepoint(&text);
        glyph_entry = find_glyph(atlas, codepoint);
        glyph = read_u16(glyph_entry + 4);
        if (glyph >= atlas->glyph_count)
            glyph = 0;
        glyph_x = pen_x - glyph_entry[7];
        for (row = 0; row < atlas->cell_height; row++) {
            for (column = 0; column < atlas->cell_width; column++) {
                unsigned int coverage;

                coverage = logical_coverage(
                    atlas, glyph, column, row);
                if (coverage)
                    blend_pixel(glyph_x + column, y + row,
                                red, green, blue, coverage);
            }
        }
        pen_x += glyph_entry[6];
    }
    return 1;
}

static int draw_image(int x, int y, int width, int height, int handle)
{
    const Wm6Image *image;
    int destination_y;
    int destination_x;

    if (handle <= 0 || handle >= WM6_MAX_IMAGES ||
        width <= 0 || height <= 0)
        return 0;
    image = &g_images[handle];
    if (!image->pixels || image->format != 3)
        return 0;
    for (destination_y = 0; destination_y < height; destination_y++) {
        unsigned int source_y;

        source_y = (unsigned int)destination_y * image->height /
                   (unsigned int)height;
        for (destination_x = 0; destination_x < width; destination_x++) {
            unsigned int source_x;
            unsigned int offset;

            source_x = (unsigned int)destination_x * image->width /
                       (unsigned int)width;
            offset = (source_y * image->width + source_x) * 4u;
            blend_pixel(x + destination_x, y + destination_y,
                        image->pixels[offset],
                        image->pixels[offset + 1],
                        image->pixels[offset + 2],
                        image->pixels[offset + 3]);
        }
    }
    return 1;
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
    if (status != DD_OK || !g_direct_draw)
        return 0;
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
    if (g_pak) {
        LocalFree(g_pak);
        g_pak = NULL;
        g_pak_size = 0;
    }
    memset(g_fonts, 0, sizeof(g_fonts));
    memset(g_images, 0, sizeof(g_images));
}

int wm6_framebuffer_render(const char *draw_list)
{
    const char *line;
    int succeeded;

    if (!draw_list || !g_pixels || g_width <= 0 || g_height <= 0)
        return 0;
    fill_rect(0, 0, g_width, g_height, rgb565(0, 0, 0));
    succeeded = 1;
    line = draw_list;
    while (*line) {
        const char *cursor;
        int x;
        int y;
        int width;
        int height;
        int slot;
        int handle;
        int red;
        int green;
        int blue;

        cursor = line + 1;
        if (line[0] == 'B') {
            red = read_number(&cursor);
            green = read_number(&cursor);
            blue = read_number(&cursor);
            fill_rect(0, 0, g_width, g_height,
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
        } else if (line[0] == 'T') {
            x = read_number(&cursor);
            y = read_number(&cursor);
            slot = read_number(&cursor);
            red = read_number(&cursor);
            green = read_number(&cursor);
            blue = read_number(&cursor);
            if (*cursor == '|')
                cursor++;
            if (!draw_text(x, y, slot, red, green, blue, cursor))
                succeeded = 0;
        } else if (line[0] == 'I') {
            x = read_number(&cursor);
            y = read_number(&cursor);
            width = read_number(&cursor);
            height = read_number(&cursor);
            handle = read_number(&cursor);
            if (!draw_image(x, y, width, height, handle))
                succeeded = 0;
        }
        while (*line && *line != '\n')
            line++;
        if (*line == '\n')
            line++;
    }
    return succeeded;
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
        destination_height =
            g_height * surface_width / g_width;
    } else {
        destination_height = surface_height;
        destination_width =
            g_width * surface_height / g_height;
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
            unsigned short *pixels;

            pixels = (unsigned short *)destination + offset_x;
            for (x = 0; x < destination_width; x++) {
                int source_x;

                source_x = x * g_width / destination_width;
                pixels[x] = (unsigned short)convert_pixel(
                    source[source_x], &pixel_format);
            }
        } else if (pixel_format.dwRGBBitCount == 32) {
            DWORD *pixels;

            pixels = (DWORD *)destination + offset_x;
            for (x = 0; x < destination_width; x++) {
                int source_x;

                source_x = x * g_width / destination_width;
                pixels[x] = convert_pixel(
                    source[source_x], &pixel_format);
            }
        } else {
            unsigned char *pixels;

            pixels = destination + offset_x * 3;
            for (x = 0; x < destination_width; x++) {
                DWORD color;
                int source_x;

                source_x = x * g_width / destination_width;
                color = convert_pixel(
                    source[source_x], &pixel_format);
                pixels[x * 3] = (unsigned char)color;
                pixels[x * 3 + 1] = (unsigned char)(color >> 8);
                pixels[x * 3 + 2] = (unsigned char)(color >> 16);
            }
        }
    }
    g_primary->lpVtbl->Unlock(g_primary, surface.lpSurface);
    return 1;
}
