#ifndef POCKETJS_WM6_QUICKJS_ABI_H
#define POCKETJS_WM6_QUICKJS_ABI_H

#define WM6_QJS_ABI_VERSION 2u

#if defined(__cplusplus)
extern "C" {
#endif

typedef void *wm6_qjs_handle;

typedef unsigned int (__cdecl *wm6_qjs_abi_version_fn)(void);
typedef wm6_qjs_handle (__cdecl *wm6_qjs_create_fn)(
    unsigned int memory_limit,
    unsigned int stack_limit,
    unsigned int viewport_width,
    unsigned int viewport_height,
    char *error,
    unsigned int error_capacity);
typedef int (__cdecl *wm6_qjs_set_pak_fn)(
    wm6_qjs_handle handle,
    const unsigned char *data,
    unsigned int data_length,
    char *error,
    unsigned int error_capacity);
typedef int (__cdecl *wm6_qjs_eval_fn)(
    wm6_qjs_handle handle,
    const char *source,
    unsigned int source_length,
    char *output,
    unsigned int output_capacity);
typedef int (__cdecl *wm6_qjs_drain_jobs_fn)(
    wm6_qjs_handle handle,
    char *output,
    unsigned int output_capacity);
typedef const unsigned char *(__cdecl *wm6_qjs_frame_fn)(
    wm6_qjs_handle handle,
    unsigned int buttons,
    unsigned int *width,
    unsigned int *height,
    unsigned int *stride,
    unsigned int *byte_length);
typedef void (__cdecl *wm6_qjs_destroy_fn)(wm6_qjs_handle handle);

#if defined(__cplusplus)
}
#endif

#endif
