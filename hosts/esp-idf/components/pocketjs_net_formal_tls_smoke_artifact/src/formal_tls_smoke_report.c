// SPDX-License-Identifier: MIT

#include "pocketjs/net/formal_tls_smoke_artifact.h"

#include <math.h>
#include <string.h>

#include "quickjs.h"

#define REPORT_ENUMERABLE_FIELDS 13U

static void free_descriptor(JSContext *context,
                            JSPropertyDescriptor *descriptor) {
  JS_FreeValue(context, descriptor->value);
  JS_FreeValue(context, descriptor->getter);
  JS_FreeValue(context, descriptor->setter);
}

static bool own_data_property(JSContext *context, JSValueConst object,
                              const char *name, JSValue *out_value) {
  *out_value = JS_UNDEFINED;
  if (!JS_IsObject(object) || JS_IsProxy(object)) {
    return false;
  }
  JSAtom atom = JS_NewAtom(context, name);
  if (atom == JS_ATOM_NULL) {
    return false;
  }
  JSPropertyDescriptor descriptor = {0};
  const int result = JS_GetOwnProperty(context, &descriptor, object, atom);
  JS_FreeAtom(context, atom);
  if (result != 1 || (descriptor.flags & JS_PROP_GETSET) != 0) {
    if (result == 1) {
      free_descriptor(context, &descriptor);
    }
    return false;
  }
  *out_value = descriptor.value;
  JS_FreeValue(context, descriptor.getter);
  JS_FreeValue(context, descriptor.setter);
  return true;
}

static bool read_u32(JSContext *context, JSValueConst object, const char *name,
                     uint32_t maximum, uint32_t *out_value) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value) ||
      !JS_IsNumber(value)) {
    JS_FreeValue(context, value);
    return false;
  }
  double number = 0.0;
  const bool valid = JS_ToFloat64(context, &number, value) == 0 &&
                     isfinite(number) && number >= 0.0 &&
                     number <= (double)maximum && number == floor(number);
  JS_FreeValue(context, value);
  if (!valid) {
    return false;
  }
  *out_value = (uint32_t)number;
  return true;
}

static bool read_bool(JSContext *context, JSValueConst object, const char *name,
                      bool *out_value) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value) || !JS_IsBool(value)) {
    JS_FreeValue(context, value);
    return false;
  }
  const int result = JS_ToBool(context, value);
  JS_FreeValue(context, value);
  if (result < 0) {
    return false;
  }
  *out_value = result != 0;
  return true;
}

static bool read_ascii(JSContext *context, JSValueConst object,
                       const char *name, char *out_value,
                       size_t output_capacity) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value) ||
      !JS_IsString(value)) {
    JS_FreeValue(context, value);
    return false;
  }
  size_t length = 0U;
  const char *text = JS_ToCStringLen2(context, &length, value, false);
  JS_FreeValue(context, value);
  if (text == NULL) {
    return false;
  }
  bool valid = length < output_capacity;
  for (size_t index = 0U; valid && index < length; ++index) {
    const unsigned char byte = (unsigned char)text[index];
    valid = byte >= 0x20U && byte <= 0x7eU;
  }
  if (valid) {
    memcpy(out_value, text, length);
    out_value[length] = '\0';
  }
  JS_FreeCString(context, text);
  return valid;
}

static bool read_phase(JSContext *context, JSValueConst report,
                       pocketjs_net_formal_tls_smoke_phase_t *out_phase) {
  char phase[16] = {0};
  if (!read_ascii(context, report, "phase", phase, sizeof(phase))) {
    return false;
  }
  if (strcmp(phase, "starting") == 0) {
    *out_phase = POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_STARTING;
  } else if (strcmp(phase, "health") == 0) {
    *out_phase = POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_HEALTH;
  } else if (strcmp(phase, "echo") == 0) {
    *out_phase = POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_ECHO;
  } else if (strcmp(phase, "passed") == 0) {
    *out_phase = POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_PASSED;
  } else if (strcmp(phase, "failed") == 0) {
    *out_phase = POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_FAILED;
  } else {
    return false;
  }
  return true;
}

static bool exact_enumerable_field_count(JSContext *context,
                                         JSValueConst report) {
  JSPropertyEnum *properties = NULL;
  uint32_t count = 0U;
  if (JS_GetOwnPropertyNames(context, &properties, &count, report,
                             JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
    return false;
  }
  for (uint32_t index = 0U; index < count; ++index) {
    JS_FreeAtom(context, properties[index].atom);
  }
  js_free(context, properties);
  return count == REPORT_ENUMERABLE_FIELDS;
}

static bool parse_report(JSContext *context, JSValueConst value,
                         pocketjs_net_formal_tls_smoke_report_t *out_report) {
  uint32_t version = 0U;
  uint32_t rounds_total = 0U;
  if (!JS_IsObject(value) || JS_IsProxy(value) ||
      !exact_enumerable_field_count(context, value) ||
      !read_u32(context, value, "version", 1U, &version) || version != 1U ||
      !read_u32(context, value, "checkpoint", UINT32_MAX,
                &out_report->checkpoint) ||
      !read_phase(context, value, &out_report->phase) ||
      !read_u32(context, value, "roundsTotal",
                POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS, &rounds_total) ||
      rounds_total != POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS ||
      !read_u32(context, value, "roundsStarted",
                POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS,
                &out_report->rounds_started) ||
      !read_u32(context, value, "roundsPassed",
                POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS,
                &out_report->rounds_passed) ||
      !read_u32(context, value, "requestsPassed",
                POCKETJS_NET_FORMAL_TLS_SMOKE_REQUESTS,
                &out_report->requests_passed) ||
      !read_u32(context, value, "frameCalls", UINT32_MAX,
                &out_report->frame_calls) ||
      !read_bool(context, value, "done", &out_report->done) ||
      !read_bool(context, value, "ok", &out_report->ok) ||
      !read_ascii(context, value, "errorName", out_report->error_name,
                  sizeof(out_report->error_name)) ||
      !read_ascii(context, value, "errorCode", out_report->error_code,
                  sizeof(out_report->error_code)) ||
      !read_ascii(context, value, "errorOperation", out_report->error_operation,
                  sizeof(out_report->error_operation))) {
    return false;
  }

  if (out_report->rounds_passed > out_report->rounds_started ||
      out_report->requests_passed < out_report->rounds_passed * 2U ||
      out_report->requests_passed > out_report->rounds_started * 2U) {
    return false;
  }
  if (out_report->done) {
    if (out_report->ok) {
      return out_report->phase == POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_PASSED &&
             out_report->rounds_started ==
                 POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS &&
             out_report->rounds_passed ==
                 POCKETJS_NET_FORMAL_TLS_SMOKE_ROUNDS &&
             out_report->requests_passed ==
                 POCKETJS_NET_FORMAL_TLS_SMOKE_REQUESTS &&
             out_report->error_name[0] == '\0' &&
             out_report->error_code[0] == '\0' &&
             out_report->error_operation[0] == '\0';
    }
    return out_report->phase == POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_FAILED;
  }
  return !out_report->ok &&
         out_report->phase != POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_PASSED &&
         out_report->phase != POCKETJS_NET_FORMAL_TLS_SMOKE_PHASE_FAILED;
}

esp_err_t pocketjs_net_formal_tls_smoke_read_report(
    pocketjs_esp_guest_t *guest,
    pocketjs_net_formal_tls_smoke_report_t *out_report) {
  if (guest == NULL || out_report == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  memset(out_report, 0, sizeof(*out_report));
  JSContext *context = pocketjs_esp_guest_context(guest);
  if (context == NULL) {
    return ESP_ERR_INVALID_STATE;
  }

  JSValue global = JS_GetGlobalObject(context);
  JSValue function = JS_UNDEFINED;
  JSValue result = JS_UNDEFINED;
  if (JS_IsException(global) ||
      !own_data_property(context, global,
                         pocketjs_net_formal_tls_smoke_report_global,
                         &function) ||
      !JS_IsFunction(context, function)) {
    JS_FreeValue(context, function);
    JS_FreeValue(context, global);
    if (JS_HasException(context)) {
      pocketjs_esp_guest_log_exception(guest, "formal_tls_smoke_report_lookup");
    }
    return ESP_ERR_INVALID_STATE;
  }

  const esp_err_t call_result = pocketjs_esp_guest_call_function(
      guest, "formal_tls_smoke_report", function, global, 0U, NULL, &result);
  JS_FreeValue(context, function);
  JS_FreeValue(context, global);
  if (call_result != ESP_OK) {
    JS_FreeValue(context, result);
    return call_result;
  }

  const bool valid = parse_report(context, result, out_report);
  JS_FreeValue(context, result);
  if (!valid) {
    memset(out_report, 0, sizeof(*out_report));
    if (JS_HasException(context)) {
      pocketjs_esp_guest_log_exception(guest, "formal_tls_smoke_report_parse");
    }
    return ESP_ERR_INVALID_RESPONSE;
  }
  return ESP_OK;
}

esp_err_t
pocketjs_net_formal_tls_smoke_cancel_active_request(pocketjs_esp_guest_t *guest,
                                                    bool *out_cancelled) {
  if (guest == NULL || out_cancelled == NULL) {
    return ESP_ERR_INVALID_ARG;
  }
  *out_cancelled = false;
  JSContext *context = pocketjs_esp_guest_context(guest);
  if (context == NULL) {
    return ESP_ERR_INVALID_STATE;
  }

  JSValue global = JS_GetGlobalObject(context);
  JSValue function = JS_UNDEFINED;
  JSValue result = JS_UNDEFINED;
  if (JS_IsException(global) ||
      !own_data_property(context, global,
                         pocketjs_net_formal_tls_smoke_cancel_global,
                         &function) ||
      !JS_IsFunction(context, function)) {
    JS_FreeValue(context, function);
    JS_FreeValue(context, global);
    if (JS_HasException(context)) {
      pocketjs_esp_guest_log_exception(guest, "formal_tls_smoke_cancel_lookup");
    }
    return ESP_ERR_INVALID_STATE;
  }

  const esp_err_t call_result = pocketjs_esp_guest_call_function(
      guest, "formal_tls_smoke_cancel", function, global, 0U, NULL, &result);
  JS_FreeValue(context, function);
  JS_FreeValue(context, global);
  if (call_result != ESP_OK) {
    JS_FreeValue(context, result);
    return call_result;
  }

  const int cancelled = JS_ToBool(context, result);
  JS_FreeValue(context, result);
  if (cancelled < 0) {
    if (JS_HasException(context)) {
      pocketjs_esp_guest_log_exception(guest, "formal_tls_smoke_cancel_result");
    }
    return ESP_ERR_INVALID_RESPONSE;
  }
  *out_cancelled = cancelled != 0;
  return ESP_OK;
}
