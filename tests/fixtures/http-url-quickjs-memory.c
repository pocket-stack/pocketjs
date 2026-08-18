#include "quickjs.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef union Header {
  struct { size_t size; } allocation;
  long double alignment;
  void *pointer_alignment;
} Header;

typedef struct Tracker {
  size_t current;
  size_t peak;
  size_t maximum_single;
} Tracker;

static void tracker_add(Tracker *tracker, size_t size) {
  tracker->current += size;
  if (tracker->current > tracker->peak) tracker->peak = tracker->current;
  if (size > tracker->maximum_single) tracker->maximum_single = size;
}

static void *tracked_malloc(void *opaque, size_t size) {
  Tracker *tracker = opaque;
  Header *header = malloc(sizeof(*header) + size);
  if (!header) return NULL;
  header->allocation.size = size;
  tracker_add(tracker, size);
  return header + 1;
}

static void *tracked_calloc(void *opaque, size_t count, size_t size) {
  if (size != 0 && count > SIZE_MAX / size) return NULL;
  size_t total = count * size;
  void *pointer = tracked_malloc(opaque, total);
  if (pointer) memset(pointer, 0, total);
  return pointer;
}

static void tracked_free(void *opaque, void *pointer) {
  if (!pointer) return;
  Tracker *tracker = opaque;
  Header *header = ((Header *)pointer) - 1;
  tracker->current -= header->allocation.size;
  free(header);
}

static void *tracked_realloc(void *opaque, void *pointer, size_t size) {
  if (!pointer) return tracked_malloc(opaque, size);
  if (size == 0) {
    tracked_free(opaque, pointer);
    return NULL;
  }
  Tracker *tracker = opaque;
  Header *old_header = ((Header *)pointer) - 1;
  size_t old_size = old_header->allocation.size;
  Header *new_header = realloc(old_header, sizeof(*new_header) + size);
  if (!new_header) return NULL;
  new_header->allocation.size = size;
  tracker->current -= old_size;
  tracker_add(tracker, size);
  return new_header + 1;
}

static size_t tracked_usable_size(const void *pointer) {
  if (!pointer) return 0;
  return (((const Header *)pointer) - 1)->allocation.size;
}

static int report_exception(JSContext *context, JSValue value, const char *stage) {
  if (!JS_IsException(value)) return 0;
  JSValue exception = JS_GetException(context);
  const char *message = JS_ToCString(context, exception);
  fprintf(stderr, "%s: %s\n", stage, message ? message : "<exception>");
  JS_FreeCString(context, message);
  JS_FreeValue(context, exception);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  FILE *file = fopen(argv[1], "rb");
  if (!file) return 66;
  fseek(file, 0, SEEK_END);
  long length = ftell(file);
  rewind(file);
  char *source = malloc((size_t)length + 1);
  if (!source || fread(source, 1, (size_t)length, file) != (size_t)length) return 74;
  fclose(file);
  source[length] = '\0';

  Tracker tracker = {0};
  JSMallocFunctions functions = {
    .js_calloc = tracked_calloc,
    .js_malloc = tracked_malloc,
    .js_free = tracked_free,
    .js_realloc = tracked_realloc,
    .js_malloc_usable_size = tracked_usable_size,
  };
  JSRuntime *runtime = JS_NewRuntime2(&functions, &tracker);
  JSContext *context = JS_NewContext(runtime);
  size_t empty_runtime = tracker.current;
  JSValue loaded = JS_Eval(
    context,
    source,
    (size_t)length,
    argv[1],
    JS_EVAL_TYPE_GLOBAL
  );
  free(source);
  if (report_exception(context, loaded, "load")) return 1;
  JS_FreeValue(context, loaded);
  JSValue global = JS_GetGlobalObject(context);
  JSValue probe = JS_GetPropertyStr(context, global, "__pocketJsHttpUrlHeapProbe");
  if (!JS_IsFunction(context, probe)) {
    fprintf(stderr, "probe: global function is missing\n");
    return 1;
  }
  JS_RunGC(runtime);
  size_t module_retained = tracker.current;
  size_t load_peak = tracker.peak;
  JSValue warmup = JS_Call(context, probe, JS_UNDEFINED, 0, NULL);
  if (report_exception(context, warmup, "warmup")) return 1;
  JS_FreeValue(context, warmup);
  JS_RunGC(runtime);
  size_t retained = tracker.current;
  tracker.peak = tracker.current;
  tracker.maximum_single = 0;

  JSValue result = JS_Call(context, probe, JS_UNDEFINED, 0, NULL);
  if (report_exception(context, result, "probe")) return 1;
  int32_t checksum = 0;
  if (JS_ToInt32(context, &checksum, result) < 0) return 1;
  JS_FreeValue(context, result);
  size_t operation_peak = tracker.peak;
  size_t after_operation = tracker.current;
  JS_RunGC(runtime);
  size_t after_gc = tracker.current;
  JSMemoryUsage usage;
  JS_ComputeMemoryUsage(runtime, &usage);
  printf("checksum=%d\n", checksum);
  printf("empty_runtime_bytes=%zu\n", empty_runtime);
  printf("module_retained_bytes=%zu\n", module_retained - empty_runtime);
  printf("module_load_peak_delta_bytes=%zu\n", load_peak - empty_runtime);
  printf("warmup_retained_delta_bytes=%zu\n", retained - module_retained);
  printf("operation_peak_delta_bytes=%zu\n", operation_peak - retained);
  printf("operation_retained_before_gc_bytes=%zu\n", after_operation - retained);
  printf("operation_retained_after_gc_bytes=%zu\n", after_gc - retained);
  printf("operation_max_single_allocation_bytes=%zu\n", tracker.maximum_single);
  printf("quickjs_memory_used_bytes=%lld\n", (long long)usage.memory_used_size);
  JS_FreeValue(context, probe);
  JS_FreeValue(context, global);
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
  return tracker.current == 0 ? 0 : 2;
}
