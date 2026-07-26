#include <windows.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "wm6_quickjs_abi.h"

typedef struct Wm6QuickJS {
    JSRuntime *runtime;
    JSContext *context;
    char printed[256];
} Wm6QuickJS;

static void copy_text(char *output, unsigned int capacity, const char *text)
{
    unsigned int index;

    if (!output || capacity == 0)
        return;
    index = 0;
    while (text && text[index] != '\0' && index + 1 < capacity) {
        output[index] = text[index];
        index++;
    }
    output[index] = '\0';
}

static void copy_exception(JSContext *context, char *output,
                           unsigned int capacity)
{
    JSValue exception;
    const char *text;

    exception = JS_GetException(context);
    text = JS_ToCString(context, exception);
    copy_text(output, capacity, text ? text : "JavaScript exception");
    if (text)
        JS_FreeCString(context, text);
    JS_FreeValue(context, exception);
}

static JSValue runtime_print(JSContext *context, JSValueConst this_value,
                             int argument_count, JSValueConst *arguments)
{
    Wm6QuickJS *host;
    const char *text;

    (void)this_value;
    host = (Wm6QuickJS *)JS_GetContextOpaque(context);
    if (!host || argument_count < 1)
        return JS_UNDEFINED;
    text = JS_ToCString(context, arguments[0]);
    if (!text)
        return JS_EXCEPTION;
    copy_text(host->printed, sizeof(host->printed), text);
    JS_FreeCString(context, text);
    return JS_UNDEFINED;
}

__declspec(dllexport) unsigned int __cdecl wm6_qjs_abi_version(void)
{
    return WM6_QJS_ABI_VERSION;
}

__declspec(dllexport) wm6_qjs_handle __cdecl wm6_qjs_create(
    unsigned int memory_limit,
    unsigned int stack_limit,
    char *error,
    unsigned int error_capacity)
{
    Wm6QuickJS *host;
    JSValue global;

    copy_text(error, error_capacity, "");
    host = (Wm6QuickJS *)malloc(sizeof(*host));
    if (!host) {
        copy_text(error, error_capacity, "host allocation failed");
        return NULL;
    }
    memset(host, 0, sizeof(*host));
    host->runtime = JS_NewRuntime();
    if (!host->runtime) {
        free(host);
        copy_text(error, error_capacity, "JS_NewRuntime failed");
        return NULL;
    }
    JS_SetMemoryLimit(host->runtime, memory_limit);
    JS_SetMaxStackSize(host->runtime, stack_limit);
    host->context = JS_NewContext(host->runtime);
    if (!host->context) {
        JS_FreeRuntime(host->runtime);
        free(host);
        copy_text(error, error_capacity, "JS_NewContext failed");
        return NULL;
    }
    JS_SetContextOpaque(host->context, host);
    global = JS_GetGlobalObject(host->context);
    if (JS_SetPropertyStr(
            host->context,
            global,
            "print",
            JS_NewCFunction(host->context, runtime_print, "print", 1)) < 0) {
        JS_FreeValue(host->context, global);
        JS_FreeContext(host->context);
        JS_FreeRuntime(host->runtime);
        free(host);
        copy_text(error, error_capacity, "registering print failed");
        return NULL;
    }
    JS_FreeValue(host->context, global);
    return (wm6_qjs_handle)host;
}

__declspec(dllexport) int __cdecl wm6_qjs_eval(
    wm6_qjs_handle opaque,
    const char *source,
    unsigned int source_length,
    char *output,
    unsigned int output_capacity)
{
    Wm6QuickJS *host;
    JSValue result;
    const char *text;

    host = (Wm6QuickJS *)opaque;
    if (!host || !source)
        return -1;
    host->printed[0] = '\0';
    copy_text(output, output_capacity, "");
    result = JS_Eval(host->context, source, source_length,
                     "pocketjs-wm6.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        copy_exception(host->context, output, output_capacity);
        JS_FreeValue(host->context, result);
        return -2;
    }
    text = JS_ToCString(host->context, result);
    copy_text(output, output_capacity, text ? text : "ok");
    if (text)
        JS_FreeCString(host->context, text);
    JS_FreeValue(host->context, result);
    return 0;
}

__declspec(dllexport) int __cdecl wm6_qjs_drain_jobs(
    wm6_qjs_handle opaque,
    char *output,
    unsigned int output_capacity)
{
    Wm6QuickJS *host;
    JSContext *job_context;
    int count;

    host = (Wm6QuickJS *)opaque;
    if (!host)
        return -1;
    count = 0;
    while (JS_IsJobPending(host->runtime)) {
        job_context = NULL;
        if (JS_ExecutePendingJob(host->runtime, &job_context) < 0) {
            copy_exception(job_context ? job_context : host->context,
                           output, output_capacity);
            return -2;
        }
        count++;
    }
    copy_text(output, output_capacity,
              host->printed[0] ? host->printed : "no print output");
    return count;
}

__declspec(dllexport) void __cdecl wm6_qjs_destroy(wm6_qjs_handle opaque)
{
    Wm6QuickJS *host;

    host = (Wm6QuickJS *)opaque;
    if (!host)
        return;
    JS_FreeContext(host->context);
    JS_FreeRuntime(host->runtime);
    free(host);
}

BOOL WINAPI DllMain(HANDLE module, DWORD reason, LPVOID reserved)
{
    (void)module;
    (void)reason;
    (void)reserved;
    return TRUE;
}
