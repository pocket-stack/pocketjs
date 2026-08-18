// SPDX-License-Identifier: MIT

#pragma once

#include <stdint.h>

typedef struct JSContext JSContext;
typedef uint64_t JSValue;
typedef JSValue JSValueConst;

#define JS_UNDEFINED UINT64_C(0)

static inline int JS_IsUndefined(JSValueConst value) {
  return value == JS_UNDEFINED;
}

static inline JSValue JS_DupValue(JSContext *context, JSValueConst value) {
  (void)context;
  return value;
}

static inline void JS_FreeValue(JSContext *context, JSValue value) {
  (void)context;
  (void)value;
}
