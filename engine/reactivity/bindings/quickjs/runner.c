#define _POSIX_C_SOURCE 200809L
#include "quickjs.h"
#include "reactivity.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
typedef struct {
    JSContext *ctx;
    RxGraph *graph;
    size_t calls, callbacks, callback_bytes;
} Host;
typedef struct {
    Host *host;
    JSValue fn;
    int observer;
} Callback;
static JSClassID handle_class;
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1e6;
}
static JSValue to_js(JSContext *ctx, RxValue v) {
    return v.kind == 0   ? JS_UNDEFINED
           : v.kind == 2 ? JS_NewBool(ctx, v.number != 0)
                         : JS_NewFloat64(ctx, v.number);
}
static int from_js(JSContext *ctx, JSValueConst v, RxValue *out, int undefined) {
    *out = (RxValue){0};
    if (undefined && JS_IsUndefined(v))
        return 0;
    if (JS_IsBool(v)) {
        out->kind = 2;
        out->number = JS_ToBool(ctx, v);
        return 0;
    }
    if (JS_IsNumber(v)) {
        out->kind = 1;
        return JS_ToFloat64(ctx, &out->number, v);
    }
    JS_ThrowTypeError(ctx, "Solid API subset accepts only numbers/booleans");
    return -1;
}
static int compute(void *data, RxValue previous, RxValue *out) {
    Callback *c = data;
    JSContext *ctx = c->host->ctx;
    int observer = c->observer;
    JSValue fn = JS_DupValue(ctx, c->fn);
    c->host->callbacks++;
    JSValue arg = to_js(ctx, previous);
    JSValue value = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
    JS_FreeValue(ctx, arg);
    JS_FreeValue(ctx, fn);
    int error = JS_IsException(value) ? -1 : from_js(ctx, value, out, observer);
    JS_FreeValue(ctx, value);
    return error;
}
static void drop(void *data) {
    Callback *c = data;
    JS_FreeValue(c->host->ctx, c->fn);
    c->host->callback_bytes -= sizeof(*c);
    free(c);
}
static JSValue handle(JSContext *ctx, RxNode *n) {
    JSValue obj = JS_NewObjectClass(ctx, handle_class);
    if (!JS_IsException(obj))
        JS_SetOpaque(obj, n);
    return obj;
}
static JSValue access(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int magic,
                      JSValue *data) {
    (void)self;
    Host *h = JS_GetContextOpaque(ctx);
    h->calls++;
    RxNode *n = JS_GetOpaque2(ctx, data[0], handle_class);
    if (!n)
        return JS_EXCEPTION;
    if (magic == 2) {
        rx_dispose(h->graph, n);
        return JS_UNDEFINED;
    }
    RxValue v;
    if (magic == 0) {
        if (rx_read(h->graph, n, &v)) {
            if (!JS_HasException(ctx))
                JS_ThrowTypeError(ctx, "cyclic dependency");
            return JS_EXCEPTION;
        }
        return to_js(ctx, v);
    }
    JSValue value = argc ? JS_DupValue(ctx, argv[0]) : JS_UNDEFINED;
    if (JS_IsFunction(ctx, value)) {
        /* Setter updater reads are untracked. */
        RxNode *listener = rx_listener(h->graph, NULL);
        if (rx_read(h->graph, n, &v)) {
            rx_listener(h->graph, listener);
            JS_FreeValue(ctx, value);
            return JS_EXCEPTION;
        }
        JSValue arg = to_js(ctx, v);
        h->callbacks++;
        JSValue result = JS_Call(ctx, value, JS_UNDEFINED, 1, &arg);
        rx_listener(h->graph, listener);
        JS_FreeValue(ctx, arg);
        JS_FreeValue(ctx, value);
        value = result;
    }
    if (JS_IsException(value) || from_js(ctx, value, &v, 0)) {
        JS_FreeValue(ctx, value);
        return JS_EXCEPTION;
    }
    if (rx_write(h->graph, n, v)) {
        JS_FreeValue(ctx, value);
        if (!JS_HasException(ctx))
            JS_ThrowTypeError(ctx, "reentrant writes/cycles are outside the subset");
        return JS_EXCEPTION;
    }
    return value;
}
static JSValue accessor(JSContext *ctx, JSValue obj, int magic) {
    return JS_NewCFunctionData(ctx, access, magic == 1 ? 1 : 0, magic, 1, &obj);
}
static JSValue create(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv, int kind) {
    (void)self;
    Host *h = JS_GetContextOpaque(ctx);
    h->calls++;
    if (argc > (kind == 0 ? 1 : kind == 3 ? 1 : 2))
        return JS_ThrowTypeError(ctx, "options are outside the subset");
    RxValue initial = {0};
    Callback *c = NULL;
    if (kind == 0) {
        if (from_js(ctx, argc ? argv[0] : JS_UNDEFINED, &initial, 0))
            return JS_EXCEPTION;
    } else {
        if (!argc || !JS_IsFunction(ctx, argv[0]))
            return JS_ThrowTypeError(ctx, "callback required");
        if (kind != 3) {
            if (argc > 1 && from_js(ctx, argv[1], &initial, 1))
                return JS_EXCEPTION;
            c = malloc(sizeof(*c));
            if (!c)
                return JS_ThrowOutOfMemory(ctx);
            *c = (Callback){h, JS_DupValue(ctx, argv[0]), kind == 2};
            h->callback_bytes += sizeof(*c);
        }
    }
    RxNode *n = rx_node(h->graph, kind, initial, c ? compute : NULL, c ? drop : NULL, c);
    JSValue obj = handle(ctx, n);
    if (JS_IsException(obj)) {
        rx_dispose(h->graph, n);
        return obj;
    }
    JSValue result;
    if (kind == 0) {
        result = JS_NewArray(ctx);
        JS_SetPropertyUint32(ctx, result, 0, accessor(ctx, obj, 0));
        JS_SetPropertyUint32(ctx, result, 1, accessor(ctx, obj, 1));
    } else if (kind == 3) {
        RxNode *owner = rx_owner(h->graph, n), *listener = rx_listener(h->graph, NULL);
        JSValue dispose = accessor(ctx, obj, 2);
        h->callbacks++;
        result = JS_Call(ctx, argv[0], JS_UNDEFINED, 1, &dispose);
        JS_FreeValue(ctx, dispose);
        rx_owner(h->graph, owner);
        rx_listener(h->graph, listener);
        if (!JS_IsException(result) && (int)JS_PromiseState(ctx, result) >= 0) {
            JS_FreeValue(ctx, result);
            result = JS_ThrowTypeError(ctx, "async roots are outside the subset");
        }
        if (JS_IsException(result))
            rx_dispose(h->graph, n);
    } else {
        if (rx_update(h->graph, n)) {
            rx_dispose(h->graph, n);
            result = JS_EXCEPTION;
        } else
            result = kind == 1 ? accessor(ctx, obj, 0) : JS_UNDEFINED;
    }
    JS_FreeValue(ctx, obj);
    return result;
}
static JSValue metrics(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    (void)argc;
    (void)argv;
    Host *h = JS_GetContextOpaque(ctx);
    JSMemoryUsage m;
    JS_ComputeMemoryUsage(JS_GetRuntime(ctx), &m);
    JSValue obj = JS_NewObject(ctx);
#define METRIC(name, value) JS_SetPropertyStr(ctx, obj, name, JS_NewFloat64(ctx, (double)(value)))
    METRIC("jsBytes", m.malloc_size);
    METRIC("nativeBytes", rx_bytes(h->graph) + h->callback_bytes);
    METRIC("jsToNative", h->calls);
    METRIC("nativeToJs", h->callbacks);
    METRIC("liveNodes", rx_live(h->graph));
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage) == 0) {
#ifdef __APPLE__
        METRIC("peakRssBytes", usage.ru_maxrss);
#else
        METRIC("peakRssBytes", usage.ru_maxrss * 1024.0);
#endif
    }
#undef METRIC
    return obj;
}
static JSValue clock_ms(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    (void)argc;
    (void)argv;
    return JS_NewFloat64(ctx, now());
}
static JSValue print(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    for (int i = 0; i < argc; ++i) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (!s)
            return JS_EXCEPTION;
        printf("%s%s", i ? " " : "", s);
        JS_FreeCString(ctx, s);
    }
    putchar('\n');
    return JS_UNDEFINED;
}
int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: reactivity-runner bundle.js\n");
        return 2;
    }
    FILE *f = fopen(argv[1], "rb");
    if (!f) {
        perror(argv[1]);
        return 2;
    }
    if (fseek(f, 0, SEEK_END))
        return 2;
    long size = ftell(f);
    if (size < 0 || fseek(f, 0, SEEK_SET))
        return 2;
    char *source = malloc((size_t)size + 1);
    if (!source)
        return 2;
    if (fread(source, 1, (size_t)size, f) != (size_t)size)
        return 2;
    fclose(f);
    source[size] = 0;
    JSRuntime *rt = JS_NewRuntime();
    if (!rt)
        return 2;
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        return 2;
    }
    Host host = {.ctx = ctx, .graph = rx_graph_new()};
    JS_SetContextOpaque(ctx, &host);
    JS_NewClassID(&handle_class);
    JSClassDef def = {.class_name = "ReactiveHandle"};
    JS_NewClass(rt, handle_class, &def);
    JSValue global = JS_GetGlobalObject(ctx), api = JS_NewObject(ctx);
    const char *names[] = {"createSignal", "createMemo", "createComputed", "createRoot"};
    for (int i = 0; i < 4; ++i)
        JS_SetPropertyStr(
            ctx, api, names[i],
            JS_NewCFunctionMagic(ctx, create, names[i], 1, JS_CFUNC_generic_magic, i));
    JS_SetPropertyStr(ctx, global, "nativeReactivity", api);
    JS_SetPropertyStr(ctx, global, "metrics", JS_NewCFunction(ctx, metrics, "metrics", 0));
    JS_SetPropertyStr(ctx, global, "clockMs", JS_NewCFunction(ctx, clock_ms, "clockMs", 0));
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, print, "print", 1));
    JS_FreeValue(ctx, global);
    JSValue result = JS_Eval(ctx, source, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
    int failed = JS_IsException(result);
    if (failed) {
        JSValue error = JS_GetException(ctx), stack = JS_GetPropertyStr(ctx, error, "stack");
        const char *s = JS_ToCString(ctx, error), *t = JS_ToCString(ctx, stack);
        fprintf(stderr, "%s\n%s\n", s ? s : "exception", t ? t : "");
        JS_FreeCString(ctx, s);
        JS_FreeCString(ctx, t);
        JS_FreeValue(ctx, stack);
        JS_FreeValue(ctx, error);
    }
    JS_FreeValue(ctx, result);
    free(source);
    rx_graph_free(host.graph);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return failed;
}
