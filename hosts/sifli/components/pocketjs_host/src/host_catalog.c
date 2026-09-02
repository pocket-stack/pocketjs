#include <string.h>

#include "pocketjs_catalog.h"

static size_t span(const uint8_t *start, const uint8_t *end)
{
    if (start == NULL || end == NULL || (uintptr_t)end < (uintptr_t)start)
    {
        return 0;
    }
    return (size_t)((uintptr_t)end - (uintptr_t)start);
}

const PocketjsGuest *pocketjs_catalog_find(const PocketjsCatalog *catalog, const char *output,
                                           size_t output_len)
{
    size_t index;
    if (catalog == NULL || output == NULL || output_len == 0)
    {
        return NULL;
    }
    for (index = 0; index < catalog->count; ++index)
    {
        const PocketjsGuest *guest = &catalog->guests[index];
        if (strlen(guest->output) == output_len &&
            memcmp(guest->output, output, output_len) == 0)
        {
            return guest;
        }
    }
    return NULL;
}

size_t pocketjs_guest_js_size(const PocketjsGuest *guest)
{
    return guest == NULL ? 0 : span(guest->js_start, guest->js_end);
}

size_t pocketjs_guest_pak_size(const PocketjsGuest *guest)
{
    return guest == NULL ? 0 : span(guest->pak_start, guest->pak_end);
}

size_t pocketjs_guest_epic_size(const PocketjsGuest *guest)
{
    return guest == NULL ? 0 : span(guest->epic_start, guest->epic_end);
}
