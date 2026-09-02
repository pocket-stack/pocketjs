/*
 * The embedded guest catalog: every PocketJS bundle linked into the
 * firmware. `tools/sifli.ts assets` generates the table from a project's
 * pocket-sifli.json together with the assembly that embeds the files.
 */
#ifndef POCKETJS_CATALOG_H
#define POCKETJS_CATALOG_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C"
{
#endif

typedef struct
{
    const char *output; /* PocketJS output name, e.g. "hero-main" */
    const char *title;
    const uint8_t *js_start;
    const uint8_t *js_end;
    const uint8_t *pak_start;
    const uint8_t *pak_end;
    const uint8_t *epic_start; /* NULL without a native texture pak */
    const uint8_t *epic_end;
} PocketjsGuest;

typedef struct
{
    const PocketjsGuest *guests;
    size_t count;
    size_t launcher; /* index mounted at boot and on return */
} PocketjsCatalog;

const PocketjsGuest *pocketjs_catalog_find(const PocketjsCatalog *catalog,
                                           const char *output, size_t output_len);
size_t pocketjs_guest_js_size(const PocketjsGuest *guest);
size_t pocketjs_guest_pak_size(const PocketjsGuest *guest);
size_t pocketjs_guest_epic_size(const PocketjsGuest *guest);

#ifdef __cplusplus
}
#endif

#endif
