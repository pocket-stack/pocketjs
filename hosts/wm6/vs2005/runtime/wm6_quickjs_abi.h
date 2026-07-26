#ifndef POCKETJS_WM6_QUICKJS_ABI_H
#define POCKETJS_WM6_QUICKJS_ABI_H

#define WM6_QJS_ABI_VERSION 1u

#if defined(__cplusplus)
extern "C" {
#endif

typedef void *wm6_qjs_handle;

typedef unsigned int (__cdecl *wm6_qjs_abi_version_fn)(void);
typedef wm6_qjs_handle (__cdecl *wm6_qjs_create_fn)(
    unsigned int memory_limit,
    unsigned int stack_limit,
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
typedef void (__cdecl *wm6_qjs_destroy_fn)(wm6_qjs_handle handle);

#if defined(__cplusplus)
}
#endif

#endif
