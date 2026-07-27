#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <windows.h>

#include "wm6_quickjs_abi.h"

unsigned int wm6_qjs_abi_version(void);
wm6_qjs_handle wm6_qjs_create(
    unsigned int memory_limit,
    unsigned int stack_limit,
    unsigned int viewport_width,
    unsigned int viewport_height,
    char *error,
    unsigned int error_capacity);
int wm6_qjs_set_pak(
    wm6_qjs_handle handle,
    const unsigned char *data,
    unsigned int data_length,
    char *error,
    unsigned int error_capacity);
int wm6_qjs_eval(
    wm6_qjs_handle handle,
    const char *source,
    unsigned int source_length,
    char *output,
    unsigned int output_capacity);
int wm6_qjs_drain_jobs(
    wm6_qjs_handle handle,
    char *output,
    unsigned int output_capacity);
const unsigned char *wm6_qjs_frame(
    wm6_qjs_handle handle,
    unsigned int buttons,
    const unsigned int *touches,
    unsigned int touch_count,
    unsigned int *width,
    unsigned int *height,
    unsigned int *stride,
    unsigned int *byte_length,
    char *error,
    unsigned int error_capacity);
void wm6_qjs_destroy(wm6_qjs_handle handle);

static unsigned char *read_file(const char *path, unsigned int *length)
{
    FILE *file;
    long raw_length;
    unsigned char *bytes;

    *length = 0;
    file = fopen(path, "rb");
    if (!file)
        return NULL;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return NULL;
    }
    raw_length = ftell(file);
    if (raw_length < 0 || (unsigned long)raw_length > 0xffffffffUL ||
        fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return NULL;
    }
    bytes = (unsigned char *)malloc(
        raw_length > 0 ? (size_t)raw_length : 1u);
    if (!bytes ||
        fread(bytes, 1, (size_t)raw_length, file) !=
            (size_t)raw_length) {
        free(bytes);
        fclose(file);
        return NULL;
    }
    fclose(file);
    *length = (unsigned int)raw_length;
    return bytes;
}

static uint64_t hash_bytes(const unsigned char *bytes, unsigned int length)
{
    uint64_t hash;
    unsigned int index;

    hash = UINT64_C(0xcbf29ce484222325);
    for (index = 0; index < length; index++) {
        hash ^= bytes[index];
        hash *= UINT64_C(0x100000001b3);
    }
    return hash;
}

static int fail(
    const char *step,
    const char *detail,
    wm6_qjs_handle runtime,
    unsigned char *bundle,
    unsigned char *pak)
{
    fprintf(stderr, "%s failed: %s\n", step, detail ? detail : "");
    if (runtime)
        wm6_qjs_destroy(runtime);
    free(bundle);
    free(pak);
    return 1;
}

int main(int argument_count, char **arguments)
{
    unsigned char *bundle;
    unsigned char *pak;
    unsigned int bundle_length;
    unsigned int pak_length;
    wm6_qjs_handle runtime;
    char message[512];
    const unsigned char *pixels;
    unsigned int width;
    unsigned int height;
    unsigned int stride;
    unsigned int byte_length;
    unsigned int touch;
    unsigned int index;
    unsigned int nonzero_alpha;
    unsigned int changed_pixels;
    uint64_t hash;

    if (argument_count != 3) {
        fprintf(stderr, "usage: runtime_smoke BUNDLE PAK\n");
        return 2;
    }
    if (wm6_qjs_abi_version() != WM6_QJS_ABI_VERSION) {
        fprintf(stderr, "unexpected WM6 runtime ABI\n");
        return 1;
    }
    bundle = read_file(arguments[1], &bundle_length);
    pak = read_file(arguments[2], &pak_length);
    if (!bundle || !pak)
        return fail("reading Hero assets", "", NULL, bundle, pak);

    runtime = wm6_qjs_create(
        8u * 1024u * 1024u,
        256u * 1024u,
        640u,
        480u,
        message,
        sizeof(message));
    if (!runtime)
        return fail("runtime creation", message, NULL, bundle, pak);
    if (wm6_qjs_set_pak(
            runtime, pak, pak_length, message, sizeof(message)) != 0)
        return fail("PAK installation", message, runtime, bundle, pak);
    if (wm6_qjs_eval(
            runtime,
            (const char *)bundle,
            bundle_length,
            message,
            sizeof(message)) != 0)
        return fail("Hero evaluation", message, runtime, bundle, pak);
    if (wm6_qjs_drain_jobs(runtime, message, sizeof(message)) < 0)
        return fail("initial job drain", message, runtime, bundle, pak);

    touch = 0x80000000u | (240u << 10) | 320u;
    pixels = wm6_qjs_frame(
        runtime,
        0,
        &touch,
        1,
        &width,
        &height,
        &stride,
        &byte_length,
        message,
        sizeof(message));
    if (!pixels)
        return fail("first frame", message, runtime, bundle, pak);
    if (width != 640u || height != 480u || stride != 2560u ||
        byte_length != 1228800u)
        return fail(
            "frame geometry", "expected 640x480 ARGB32", runtime, bundle, pak);

    nonzero_alpha = 0;
    changed_pixels = 0;
    for (index = 3; index < byte_length; index += 4) {
        if (pixels[index] != 0) {
            nonzero_alpha++;
        }
        if (pixels[index - 3] != pixels[0] ||
            pixels[index - 2] != pixels[1] ||
            pixels[index - 1] != pixels[2])
            changed_pixels++;
        if (nonzero_alpha >= 16 && changed_pixels >= 16)
            break;
    }
    if (nonzero_alpha < 16)
        return fail(
            "frame contents", "framebuffer is transparent", runtime, bundle, pak);
    if (changed_pixels < 16)
        return fail(
            "frame contents", "framebuffer is a flat color", runtime, bundle, pak);
    hash = hash_bytes(pixels, byte_length);

    wm6_qjs_destroy(runtime);
    free(bundle);
    free(pak);
    printf(
        "WM6 native runtime smoke passed: %ux%u stride=%u bytes=%u "
        "fnv1a=%08x%08x\n",
        width,
        height,
        stride,
        byte_length,
        (unsigned int)(hash >> 32),
        (unsigned int)hash);
    return 0;
}
