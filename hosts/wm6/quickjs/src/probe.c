#include <windows.h>
#include <string.h>

#include "quickjs.h"

typedef struct ProbeState {
    char text[128];
    int print_count;
} ProbeState;

static void copy_ascii(char *out, unsigned int capacity, const char *text)
{
    unsigned int index;

    if (capacity == 0)
        return;
    index = 0;
    while (text[index] != '\0' && index + 1 < capacity) {
        out[index] = text[index];
        index++;
    }
    out[index] = '\0';
}

static void ascii_to_wide(WCHAR *out, unsigned int capacity, const char *text)
{
    unsigned int index;

    if (capacity == 0)
        return;
    index = 0;
    while (text[index] != '\0' && index + 1 < capacity) {
        unsigned char ch = (unsigned char)text[index];
        out[index] = ch < 128 ? (WCHAR)ch : L'?';
        index++;
    }
    out[index] = L'\0';
}

static JSValue probe_print(JSContext *context, JSValueConst this_value,
                           int argument_count, JSValueConst *arguments)
{
    ProbeState *state;
    const char *text;

    (void)this_value;
    state = (ProbeState *)JS_GetContextOpaque(context);
    if (!state || argument_count < 1)
        return JS_UNDEFINED;
    text = JS_ToCString(context, arguments[0]);
    if (!text)
        return JS_EXCEPTION;
    copy_ascii(state->text, sizeof(state->text), text);
    state->print_count++;
    JS_FreeCString(context, text);
    return JS_UNDEFINED;
}

static int run_cycle(ProbeState *state)
{
    static const char source[] =
        "(() => {"
        " const values = [3, 5, 8, 13];"
        " const result = 'QuickJS ' + values.map(x => x * 2).join(',');"
        " return Promise.resolve().then(() => print(result));"
        "})()";
    JSRuntime *runtime;
    JSContext *context;
    JSContext *job_context;
    JSValue global;
    JSValue result;
    const char *text;
    int exit_code;

    runtime = JS_NewRuntime();
    if (!runtime)
        return 1;
    JS_SetMemoryLimit(runtime, 8u * 1024u * 1024u);
    JS_SetMaxStackSize(runtime, 256u * 1024u);
    context = JS_NewContext(runtime);
    if (!context) {
        JS_FreeRuntime(runtime);
        return 2;
    }
    JS_SetContextOpaque(context, state);
    global = JS_GetGlobalObject(context);
    if (JS_SetPropertyStr(context, global, "print",
                          JS_NewCFunction(context, probe_print, "print", 1)) < 0) {
        JS_FreeValue(context, global);
        JS_FreeContext(context);
        JS_FreeRuntime(runtime);
        return 3;
    }
    JS_FreeValue(context, global);

    result = JS_Eval(context, source, sizeof(source) - 1,
                     "wm6-probe.js", JS_EVAL_TYPE_GLOBAL);
    exit_code = 0;
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(context);
        text = JS_ToCString(context, exception);
        copy_ascii(state->text, sizeof(state->text),
                   text ? text : "JavaScript exception");
        if (text)
            JS_FreeCString(context, text);
        JS_FreeValue(context, exception);
        exit_code = 4;
    }
    JS_FreeValue(context, result);
    while (exit_code == 0 && JS_IsJobPending(runtime)) {
        job_context = NULL;
        if (JS_ExecutePendingJob(runtime, &job_context) < 0)
            exit_code = 5;
    }
    if (exit_code == 0 && state->print_count != 1)
        exit_code = 6;
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return exit_code;
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPWSTR command, int show)
{
    ProbeState state;
    WCHAR message[256];
    int cycle;
    int exit_code;

    (void)instance;
    (void)previous;
    (void)command;
    (void)show;

    exit_code = 0;
    for (cycle = 0; cycle < 100; cycle++) {
        state.text[0] = '\0';
        state.print_count = 0;
        exit_code = run_cycle(&state);
        if (exit_code != 0)
            break;
    }
    if (exit_code == 0) {
        /* Expected result: QuickJS 6,10,16,26 */
        ascii_to_wide(message, 256, state.text);
        MessageBox(NULL, message, L"QuickJS: 100 cycles passed", MB_OK);
    } else {
        ascii_to_wide(message, 256,
                      state.text[0] ? state.text : "QuickJS probe failed");
        MessageBox(NULL, message, L"PocketJS QuickJS failure", MB_OK);
    }
    return exit_code;
}
