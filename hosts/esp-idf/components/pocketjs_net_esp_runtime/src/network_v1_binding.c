// SPDX-License-Identifier: MIT

#include "runtime_internal.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "runtime_contract.h"

#define POCKETJS_NET_ESP_RUNTIME_MAX_LIMIT_OVERRIDES 32U
#define POCKETJS_NET_ESP_RUNTIME_MAX_LIMIT_NAME_BYTES 64U
#define POCKETJS_NET_ESP_RUNTIME_MAX_OPERATION_LABEL_BYTES 64U
#define POCKETJS_NET_ESP_RUNTIME_MAX_CAUSE_CODE_BYTES 64U

static void binding_state_release(void *opaque) {
  pocketjs_net_esp_runtime_binding_state_t *state = opaque;
  if (state == NULL || state->references == 0U) {
    return;
  }
  --state->references;
  if (state->references == 0U) {
    free(state);
  }
}

static void set_error(pocketjs_net_esp_runtime_error_t *error,
                      pocketjs_network_v1_error_category_t category,
                      pocketjs_network_v1_error_code_t code,
                      const char *operation, bool temporary) {
  *error = (pocketjs_net_esp_runtime_error_t){
      .category = category,
      .code = code,
      .operation = operation,
      .temporary = temporary,
  };
}

static JSValue binding_type_error(JSContext *context, const char *detail) {
  return JS_ThrowTypeError(context, "PocketJS ESP network ABI: %s", detail);
}

static bool set_property(JSContext *context, JSValueConst object,
                         const char *name, JSValue value) {
  if (JS_IsException(value)) {
    return false;
  }
  return JS_SetPropertyStr(context, object, name, value) >= 0;
}

static bool set_array_property(JSContext *context, JSValueConst array,
                               uint32_t index, JSValue value) {
  if (JS_IsException(value)) {
    return false;
  }
  return JS_SetPropertyUint32(context, array, index, value) >= 0;
}

static bool freeze(JSContext *context, JSValueConst value) {
  return JS_FreezeObject(context, value) >= 0;
}

static void free_descriptor(JSContext *context,
                            JSPropertyDescriptor *descriptor) {
  JS_FreeValue(context, descriptor->value);
  JS_FreeValue(context, descriptor->getter);
  JS_FreeValue(context, descriptor->setter);
}

/* -1 is malformed/exception, 0 is absent, and 1 is an own data property. */
static int own_data_property_status(JSContext *context, JSValueConst object,
                                    const char *name, JSValue *out_value) {
  *out_value = JS_UNDEFINED;
  if (!JS_IsObject(object) || JS_IsProxy(object)) {
    return -1;
  }
  JSAtom atom = JS_NewAtom(context, name);
  if (atom == JS_ATOM_NULL) {
    return -1;
  }
  JSPropertyDescriptor descriptor = {0};
  int result = JS_GetOwnProperty(context, &descriptor, object, atom);
  JS_FreeAtom(context, atom);
  if (result <= 0) {
    return result;
  }
  if ((descriptor.flags & JS_PROP_GETSET) != 0) {
    free_descriptor(context, &descriptor);
    return -1;
  }
  *out_value = descriptor.value;
  JS_FreeValue(context, descriptor.getter);
  JS_FreeValue(context, descriptor.setter);
  return 1;
}

static bool own_data_property(JSContext *context, JSValueConst object,
                              const char *name, JSValue *out_value) {
  return own_data_property_status(context, object, name, out_value) == 1;
}

static bool read_u64(JSContext *context, JSValueConst value, uint64_t maximum,
                     uint64_t *out_value) {
  if (!JS_IsNumber(value)) {
    return false;
  }
  double number = 0.0;
  if (JS_ToFloat64(context, &number, value) < 0 || !isfinite(number) ||
      number < 0.0 || number > (double)maximum) {
    return false;
  }
  const uint64_t integer = (uint64_t)number;
  if ((double)integer != number) {
    return false;
  }
  *out_value = integer;
  return true;
}

static bool read_u32(JSContext *context, JSValueConst value, uint32_t maximum,
                     uint32_t *out_value) {
  uint64_t result = 0U;
  if (!read_u64(context, value, maximum, &result)) {
    return false;
  }
  *out_value = (uint32_t)result;
  return true;
}

static bool read_u16(JSContext *context, JSValueConst value, uint16_t maximum,
                     uint16_t *out_value) {
  uint32_t result = 0U;
  if (!read_u32(context, value, maximum, &result)) {
    return false;
  }
  *out_value = (uint16_t)result;
  return true;
}

static bool object_u32(JSContext *context, JSValueConst object,
                       const char *name, uint32_t maximum,
                       uint32_t *out_value) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value)) {
    return false;
  }
  const bool result = read_u32(context, value, maximum, out_value);
  JS_FreeValue(context, value);
  return result;
}

static bool object_u16(JSContext *context, JSValueConst object,
                       const char *name, uint16_t maximum,
                       uint16_t *out_value) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value)) {
    return false;
  }
  const bool result = read_u16(context, value, maximum, out_value);
  JS_FreeValue(context, value);
  return result;
}

static bool object_u64(JSContext *context, JSValueConst object,
                       const char *name, uint64_t maximum,
                       uint64_t *out_value) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value)) {
    return false;
  }
  const bool result = read_u64(context, value, maximum, out_value);
  JS_FreeValue(context, value);
  return result;
}

static bool object_bool(JSContext *context, JSValueConst object,
                        const char *name, bool *out_value) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value) || !JS_IsBool(value)) {
    JS_FreeValue(context, value);
    return false;
  }
  *out_value = JS_ToBool(context, value) != 0;
  JS_FreeValue(context, value);
  return true;
}

static bool read_latin1(JSContext *context, JSValueConst value,
                        uint8_t *destination, size_t capacity,
                        size_t *out_length, bool ascii_only, bool allow_empty) {
  if (!JS_IsString(value)) {
    return false;
  }
  size_t length = 0U;
  const uint16_t *characters = JS_ToCStringLenUTF16(context, &length, value);
  if (characters == NULL) {
    return false;
  }
  bool valid = length <= capacity && (allow_empty || length != 0U);
  for (size_t index = 0U; valid && index < length; ++index) {
    if (characters[index] > (ascii_only ? 0x7fU : 0xffU)) {
      valid = false;
    } else {
      destination[index] = (uint8_t)characters[index];
    }
  }
  JS_FreeCStringUTF16(context, characters);
  if (valid) {
    *out_length = length;
  }
  return valid;
}

static bool object_latin1(JSContext *context, JSValueConst object,
                          const char *name, uint8_t *destination,
                          size_t capacity, size_t *out_length, bool ascii_only,
                          bool allow_empty) {
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, object, name, &value)) {
    return false;
  }
  const bool result = read_latin1(context, value, destination, capacity,
                                  out_length, ascii_only, allow_empty);
  JS_FreeValue(context, value);
  return result;
}

static bool array_length(JSContext *context, JSValueConst array,
                         uint32_t maximum, uint32_t *out_length) {
  if (!JS_IsArray(array) || JS_IsProxy(array)) {
    return false;
  }
  JSValue value = JS_UNDEFINED;
  if (!own_data_property(context, array, "length", &value)) {
    return false;
  }
  const bool result = read_u32(context, value, maximum, out_length);
  JS_FreeValue(context, value);
  return result;
}

static bool array_item(JSContext *context, JSValueConst array, uint32_t index,
                       JSValue *out_value) {
  *out_value = JS_UNDEFINED;
  JSAtom atom = JS_NewAtomUInt32(context, index);
  if (atom == JS_ATOM_NULL) {
    return false;
  }
  JSPropertyDescriptor descriptor = {0};
  int result = JS_GetOwnProperty(context, &descriptor, array, atom);
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

static bool parse_handle(JSContext *context, JSValueConst value,
                         pocketjs_network_v1_handle_t *out_handle) {
  return object_u32(context, value, "id", UINT32_MAX, &out_handle->id) &&
         object_u32(context, value, "generation", UINT32_MAX,
                    &out_handle->generation) &&
         ((out_handle->id == 0U && out_handle->generation == 0U) ||
          (out_handle->id != 0U && out_handle->generation != 0U));
}

static bool
parse_identity(JSContext *context, JSValueConst command,
               pocketjs_network_v1_command_identity_t *out_identity) {
  JSValue identity = JS_UNDEFINED;
  JSValue resource = JS_UNDEFINED;
  JSValue operation = JS_UNDEFINED;
  JSValue body = JS_UNDEFINED;
  bool valid = own_data_property(context, command, "identity", &identity) &&
               object_u32(context, identity, "runtimeGeneration", UINT32_MAX,
                          &out_identity->runtime_generation) &&
               own_data_property(context, identity, "resource", &resource) &&
               parse_handle(context, resource, &out_identity->resource) &&
               own_data_property(context, identity, "operation", &operation) &&
               parse_handle(context, operation, &out_identity->operation) &&
               own_data_property(context, identity, "body", &body) &&
               parse_handle(context, body, &out_identity->body) &&
               object_u64(context, identity, "commandSequence",
                          POCKETJS_NETWORK_V1_SEQUENCE_MAX,
                          &out_identity->command_sequence);
  JS_FreeValue(context, body);
  JS_FreeValue(context, operation);
  JS_FreeValue(context, resource);
  JS_FreeValue(context, identity);
  return valid;
}

static bool typed_array_window(JSContext *context, JSValueConst value,
                               uint8_t **out_bytes, size_t *out_length) {
  if (JS_IsProxy(value) ||
      JS_GetTypedArrayType(value) != JS_TYPED_ARRAY_UINT8) {
    return false;
  }
  size_t offset = 0U;
  size_t length = 0U;
  size_t bytes_per_element = 0U;
  JSValue buffer = JS_GetTypedArrayBuffer(context, value, &offset, &length,
                                          &bytes_per_element);
  if (JS_IsException(buffer)) {
    return false;
  }
  size_t buffer_length = 0U;
  uint8_t *base = JS_GetArrayBuffer(context, &buffer_length, buffer);
  const bool valid = !JS_HasException(context) && bytes_per_element == 1U &&
                     offset <= buffer_length &&
                     length <= buffer_length - offset;
  if (valid) {
    *out_bytes = base == NULL ? NULL : base + offset;
    *out_length = length;
  }
  JS_FreeValue(context, buffer);
  return valid;
}

static JSValue new_latin1_string(JSContext *context,
                                 pocketjs_net_esp_runtime_t *runtime,
                                 const uint8_t *bytes, size_t length) {
  if (length == 0U) {
    return JS_NewStringLen(context, "", 0U);
  }
  if (length > POCKETJS_NET_HTTP_CLIENT_CORE_MAX_RESPONSE_HEADER_BYTES ||
      runtime == NULL) {
    return JS_ThrowRangeError(context, "ByteString exceeds native bound");
  }
  for (size_t index = 0U; index < length; ++index) {
    runtime->latin1_scratch[index] = bytes[index];
  }
  return JS_NewStringUTF16(context, runtime->latin1_scratch, length);
}

static JSValue new_handle(JSContext *context,
                          pocketjs_network_v1_handle_t handle) {
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(context, object, "id", JS_NewUint32(context, handle.id)) ||
      !set_property(context, object, "generation",
                    JS_NewUint32(context, handle.generation)) ||
      !freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue new_identity(JSContext *context,
                            pocketjs_net_esp_runtime_t *runtime,
                            pocketjs_net_esp_runtime_slot_t *slot,
                            pocketjs_network_v1_handle_t body,
                            uint64_t sequence) {
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(context, object, "runtimeGeneration",
                    JS_NewUint32(context, runtime->runtime_generation)) ||
      !set_property(
          context, object, "resource",
          new_handle(context, (pocketjs_network_v1_handle_t){1U, 1U})) ||
      !set_property(context, object, "operation",
                    new_handle(context, slot->operation)) ||
      !set_property(context, object, "body", new_handle(context, body)) ||
      !set_property(context, object, "sequence",
                    JS_NewInt64(context, (int64_t)sequence)) ||
      !freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue new_error(JSContext *context,
                         const pocketjs_net_esp_runtime_error_t *error) {
  if (error == NULL || error->operation == NULL || error->code == 0U ||
      error->category == 0U) {
    return binding_type_error(context, "native error metadata is incomplete");
  }
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(context, object, "category",
                    JS_NewUint32(context, error->category)) ||
      !set_property(context, object, "code",
                    JS_NewUint32(context, error->code)) ||
      !set_property(context, object, "operation",
                    JS_NewString(context, error->operation)) ||
      !set_property(context, object, "temporary",
                    JS_NewBool(context, error->temporary))) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  if (error->has_cause_code) {
    char cause[32];
    int count =
        snprintf(cause, sizeof(cause), "native-%ld", (long)error->cause_code);
    if (count <= 0 || (size_t)count >= sizeof(cause) ||
        !set_property(context, object, "causeCode",
                      JS_NewStringLen(context, cause, (size_t)count))) {
      JS_FreeValue(context, object);
      return JS_EXCEPTION;
    }
  }
  if (!freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue
new_dispatch_result(JSContext *context, bool accepted,
                    const pocketjs_net_esp_runtime_error_t *error) {
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(
          context, object, "status",
          JS_NewUint32(context, accepted
                                    ? POCKETJS_NETWORK_V1_DISPATCH_ACCEPTED
                                    : POCKETJS_NETWORK_V1_DISPATCH_REFUSED)) ||
      (!accepted &&
       !set_property(context, object, "error", new_error(context, error))) ||
      !freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue new_sync_result(JSContext *context, bool completed,
                               const pocketjs_net_esp_runtime_error_t *error) {
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(
          context, object, "status",
          JS_NewUint32(context, completed
                                    ? POCKETJS_NETWORK_V1_DISPATCH_COMPLETED
                                    : POCKETJS_NETWORK_V1_DISPATCH_REFUSED)) ||
      (!completed &&
       !set_property(context, object, "error", new_error(context, error))) ||
      !freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static pocketjs_net_esp_runtime_t *binding_runtime(JSContext *context,
                                                   void *opaque) {
  pocketjs_net_esp_runtime_binding_state_t *state = opaque;
  pocketjs_net_esp_runtime_t *runtime = state == NULL ? NULL : state->runtime;
  if (runtime == NULL || !pocketjs_net_esp_runtime_is_owner(runtime) ||
      runtime->context != context || runtime->binding_call_active) {
    binding_type_error(context, "stale, foreign, or reentrant binding call");
    return NULL;
  }
  return runtime;
}

static bool parse_headers(JSContext *context, JSValueConst metadata,
                          pocketjs_net_esp_runtime_http_command_t *command) {
  JSValue headers = JS_UNDEFINED;
  if (!own_data_property(context, metadata, "headers", &headers)) {
    return false;
  }
  uint32_t count = 0U;
  if (!array_length(context, headers,
                    POCKETJS_NET_HTTP_CLIENT_CORE_MAX_REQUEST_HEADERS,
                    &count)) {
    JS_FreeValue(context, headers);
    return false;
  }
  command->header_count = count;
  command->header_bytes_used = 0U;
  bool valid = true;
  for (uint32_t index = 0U; valid && index < count; ++index) {
    JSValue entry = JS_UNDEFINED;
    JSValue name = JS_UNDEFINED;
    JSValue value = JS_UNDEFINED;
    size_t name_length = 0U;
    size_t value_length = 0U;
    valid = array_item(context, headers, index, &entry) &&
            own_data_property(context, entry, "name", &name) &&
            own_data_property(context, entry, "value", &value);
    const size_t remaining =
        sizeof(command->header_bytes) - command->header_bytes_used;
    if (valid) {
      valid = read_latin1(context, name,
                          command->header_bytes + command->header_bytes_used,
                          remaining, &name_length, true, false);
    }
    if (valid) {
      const size_t value_remaining = remaining - name_length;
      valid = read_latin1(context, value,
                          command->header_bytes + command->header_bytes_used +
                              name_length,
                          value_remaining, &value_length, false, true);
    }
    if (valid) {
      command->headers[index] = (pocketjs_net_http_client_header_t){
          .name = {.data = command->header_bytes + command->header_bytes_used,
                   .length = name_length},
          .value =
              {
                  .data = command->header_bytes + command->header_bytes_used +
                          name_length,
                  .length = value_length,
              },
      };
      command->header_bytes_used += name_length + value_length;
    }
    JS_FreeValue(context, value);
    JS_FreeValue(context, name);
    JS_FreeValue(context, entry);
  }
  JS_FreeValue(context, headers);
  return valid;
}

static bool parse_timeouts(JSContext *context, JSValueConst metadata,
                           pocketjs_net_esp_runtime_http_command_t *command) {
  JSValue timeouts = JS_UNDEFINED;
  bool valid = own_data_property(context, metadata, "timeouts", &timeouts);
  static const char *const names[] = {"connectMs", "headersMs", "idleMs",
                                      "totalMs"};
  for (size_t index = 0U; valid && index < 4U; ++index) {
    uint32_t value = 0U;
    valid = object_u32(context, timeouts, names[index], UINT32_MAX, &value);
    command->has_timeout_overrides |= valid && value != 0U;
  }
  JS_FreeValue(context, timeouts);
  return valid;
}

static bool limit_name_valid(const uint8_t *name, size_t length) {
  if (name == NULL || length == 0U) {
    return false;
  }
  const bool first_alpha =
      (name[0] >= 'A' && name[0] <= 'Z') || (name[0] >= 'a' && name[0] <= 'z');
  if (!first_alpha) {
    return false;
  }
  for (size_t index = 1U; index < length; ++index) {
    const uint8_t byte = name[index];
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
          (byte >= '0' && byte <= '9') || byte == '.' || byte == '_' ||
          byte == '-')) {
      return false;
    }
  }
  return true;
}

static bool parse_limits(JSContext *context, JSValueConst metadata,
                         pocketjs_net_esp_runtime_http_command_t *command) {
  JSValue limits = JS_UNDEFINED;
  uint32_t length = 0U;
  bool valid =
      own_data_property(context, metadata, "limits", &limits) &&
      array_length(context, limits,
                   POCKETJS_NET_ESP_RUNTIME_MAX_LIMIT_OVERRIDES, &length);
  uint8_t previous_name[POCKETJS_NET_ESP_RUNTIME_MAX_LIMIT_NAME_BYTES];
  size_t previous_length = 0U;
  for (uint32_t index = 0U; valid && index < length; ++index) {
    JSValue entry = JS_UNDEFINED;
    uint8_t name[POCKETJS_NET_ESP_RUNTIME_MAX_LIMIT_NAME_BYTES];
    size_t name_length = 0U;
    uint32_t value = 0U;
    valid = array_item(context, limits, index, &entry) &&
            object_latin1(context, entry, "name", name, sizeof(name),
                          &name_length, true, false) &&
            limit_name_valid(name, name_length) &&
            object_u32(context, entry, "value", UINT32_MAX, &value) &&
            value != 0U &&
            (index == 0U ||
             memcmp(previous_name, name,
                    previous_length < name_length ? previous_length
                                                  : name_length) < 0 ||
             (memcmp(previous_name, name,
                     previous_length < name_length ? previous_length
                                                   : name_length) == 0 &&
              previous_length < name_length));
    if (valid) {
      memcpy(previous_name, name, name_length);
      previous_length = name_length;
    }
    JS_FreeValue(context, entry);
  }
  command->has_limit_overrides = valid && length != 0U;
  JS_FreeValue(context, limits);
  return valid;
}

static bool
parse_base_tls_metadata(JSContext *context, JSValueConst tls,
                        pocketjs_net_esp_runtime_http_command_t *command) {
  if (JS_IsNull(tls)) {
    command->tls_present = false;
    return true;
  }
  JSValue alpn = JS_UNDEFINED;
  uint32_t alpn_count = 0U;
  uint16_t minimum_version = 0U;
  uint16_t maximum_version = 0U;
  uint16_t client_certificate = 0U;
  uint16_t verification = 0U;
  uint16_t revocation = 0U;
  uint32_t custom_ca_bytes = 0U;
  bool valid =
      object_latin1(context, tls, "serverName", command->tls_server_name,
                    sizeof(command->tls_server_name),
                    &command->tls_server_name_length, true, true) &&
      object_u16(context, tls, "minVersion", UINT16_MAX, &minimum_version) &&
      object_u16(context, tls, "maxVersion", UINT16_MAX, &maximum_version) &&
      own_data_property(context, tls, "alpn", &alpn) &&
      array_length(context, alpn, 8U, &alpn_count) &&
      object_latin1(context, tls, "credential", command->tls_credential,
                    sizeof(command->tls_credential),
                    &command->tls_credential_length, true, true) &&
      object_u16(context, tls, "clientCertificate", UINT16_MAX,
                 &client_certificate) &&
      object_u16(context, tls, "verification", UINT16_MAX, &verification) &&
      object_u16(context, tls, "revocation", UINT16_MAX, &revocation) &&
      object_u32(context, tls, "customCaBytes", UINT32_MAX, &custom_ca_bytes);
  JS_FreeValue(context, alpn);
  if (!valid) {
    return false;
  }
  command->tls_present = true;
  command->tls_policy = (pocketjs_net_http_client_tls_policy_t){
      .server_name = {.data = command->tls_server_name,
                      .length = command->tls_server_name_length},
      .minimum_version =
          minimum_version == POCKETJS_NETWORK_V1_TLS_VERSION_V1_2
              ? POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2
          : minimum_version == POCKETJS_NETWORK_V1_TLS_VERSION_V1_3
              ? POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_3
              : 0,
      .maximum_version =
          maximum_version == POCKETJS_NETWORK_V1_TLS_VERSION_V1_2
              ? POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_2
          : maximum_version == POCKETJS_NETWORK_V1_TLS_VERSION_V1_3
              ? POCKETJS_NET_HTTP_CLIENT_TLS_VERSION_1_3
              : 0,
      .alpn_count = alpn_count,
      .credential = {.data = command->tls_credential,
                     .length = command->tls_credential_length},
      .client_certificate =
          client_certificate == POCKETJS_NETWORK_V1_CLIENT_CERTIFICATE_NONE
              ? POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_NONE
          : client_certificate ==
                  POCKETJS_NETWORK_V1_CLIENT_CERTIFICATE_OPTIONAL
              ? POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_OPTIONAL
          : client_certificate ==
                  POCKETJS_NETWORK_V1_CLIENT_CERTIFICATE_REQUIRED
              ? POCKETJS_NET_HTTP_CLIENT_TLS_CLIENT_CERTIFICATE_REQUIRED
              : 0,
      .verification =
          verification == POCKETJS_NETWORK_V1_TLS_VERIFICATION_FULL
              ? POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_FULL
          : verification ==
                  POCKETJS_NETWORK_V1_TLS_VERIFICATION_DEVELOPMENT_INSECURE
              ? POCKETJS_NET_HTTP_CLIENT_TLS_VERIFICATION_DEVELOPMENT_INSECURE
              : 0,
      .revocation =
          revocation == POCKETJS_NETWORK_V1_TLS_REVOCATION_HOST_DEFAULT
              ? POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_HOST_DEFAULT
          : revocation == POCKETJS_NETWORK_V1_TLS_REVOCATION_REQUIRED
              ? POCKETJS_NET_HTTP_CLIENT_TLS_REVOCATION_REQUIRED
              : 0,
      .custom_ca_bytes = custom_ca_bytes,
  };
  return true;
}

static bool url_has_https_scheme(const uint8_t *url, size_t length) {
  static const char scheme[] = "https:";
  if (url == NULL || length < sizeof(scheme) - 1U) {
    return false;
  }
  for (size_t index = 0U; index < sizeof(scheme) - 1U; ++index) {
    uint8_t byte = url[index];
    if (byte >= 'A' && byte <= 'Z') {
      byte = (uint8_t)(byte + ('a' - 'A'));
    }
    if (byte != (uint8_t)scheme[index]) {
      return false;
    }
  }
  return true;
}

static bool
parse_http_command(JSContext *context, JSValueConst command_value,
                   pocketjs_net_esp_runtime_http_command_t *command) {
  JSValue metadata = JS_UNDEFINED;
  JSValue tls = JS_UNDEFINED;
  memset(command, 0, sizeof(*command));
  bool valid =
      own_data_property(context, command_value, "metadata", &metadata) &&
      object_latin1(context, metadata, "url", command->url,
                    sizeof(command->url), &command->url_length, true, false) &&
      object_latin1(context, metadata, "method", command->method,
                    sizeof(command->method), &command->method_length, true,
                    false) &&
      parse_headers(context, metadata, command) &&
      object_bool(context, metadata, "hasBody", &command->has_body) &&
      object_u16(context, metadata, "redirect", UINT16_MAX,
                 &command->redirect_mode) &&
      object_u16(context, metadata, "maxRedirects",
                 POCKETJS_NET_ESP_RUNTIME_MAX_REDIRECTS,
                 &command->max_redirects) &&
      parse_timeouts(context, metadata, command) &&
      parse_limits(context, metadata, command) &&
      object_bool(context, metadata, "ref", &command->ref) &&
      own_data_property(context, metadata, "tls", &tls) &&
      parse_base_tls_metadata(context, tls, command);
  if (valid) {
    command->tls_requested =
        command->tls_present ||
        url_has_https_scheme(command->url, command->url_length);
    valid =
        command->redirect_mode == POCKETJS_NETWORK_V1_HTTP_REDIRECT_FOLLOW ||
        command->redirect_mode == POCKETJS_NETWORK_V1_HTTP_REDIRECT_MANUAL ||
        command->redirect_mode == POCKETJS_NETWORK_V1_HTTP_REDIRECT_ERROR;
  }
  JS_FreeValue(context, tls);
  JS_FreeValue(context, metadata);
  return valid;
}

static bool parse_optional_input(JSContext *context, JSValueConst command,
                                 bool *out_present) {
  JSValue input = JS_UNDEFINED;
  const int status =
      own_data_property_status(context, command, "input", &input);
  if (status < 0) {
    return false;
  }
  if (status == 0) {
    *out_present = false;
    return true;
  }
  *out_present = !JS_IsUndefined(input);
  JS_FreeValue(context, input);
  return true;
}

static bool known_error_code(uint16_t code) {
  switch (code) {
  case POCKETJS_NETWORK_V1_ERROR_ABORTED:
  case POCKETJS_NETWORK_V1_ERROR_TIMED_OUT:
  case POCKETJS_NETWORK_V1_ERROR_CLOSED:
  case POCKETJS_NETWORK_V1_ERROR_INVALID_STATE:
  case POCKETJS_NETWORK_V1_ERROR_BUSY:
  case POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT:
  case POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED:
  case POCKETJS_NETWORK_V1_ERROR_PERMISSION_DENIED:
  case POCKETJS_NETWORK_V1_ERROR_DNS_NOT_FOUND:
  case POCKETJS_NETWORK_V1_ERROR_DNS_TEMPORARY_FAILURE:
  case POCKETJS_NETWORK_V1_ERROR_DNS_REFUSED:
  case POCKETJS_NETWORK_V1_ERROR_CONNECTION_REFUSED:
  case POCKETJS_NETWORK_V1_ERROR_CONNECTION_RESET:
  case POCKETJS_NETWORK_V1_ERROR_NETWORK_UNREACHABLE:
  case POCKETJS_NETWORK_V1_ERROR_ADDRESS_IN_USE:
  case POCKETJS_NETWORK_V1_ERROR_BROKEN_PIPE:
  case POCKETJS_NETWORK_V1_ERROR_TLS_CERTIFICATE_INVALID:
  case POCKETJS_NETWORK_V1_ERROR_TLS_HOSTNAME_MISMATCH:
  case POCKETJS_NETWORK_V1_ERROR_TLS_HANDSHAKE_FAILED:
  case POCKETJS_NETWORK_V1_ERROR_TLS_VERSION_UNSUPPORTED:
  case POCKETJS_NETWORK_V1_ERROR_TLS_ALERT:
  case POCKETJS_NETWORK_V1_ERROR_HTTP_PROTOCOL_ERROR:
  case POCKETJS_NETWORK_V1_ERROR_WEBSOCKET_PROTOCOL_ERROR:
  case POCKETJS_NETWORK_V1_ERROR_MQTT_UNACCEPTABLE_PROTOCOL_VERSION:
  case POCKETJS_NETWORK_V1_ERROR_MQTT_IDENTIFIER_REJECTED:
  case POCKETJS_NETWORK_V1_ERROR_MQTT_SERVER_UNAVAILABLE:
  case POCKETJS_NETWORK_V1_ERROR_MQTT_BAD_CREDENTIALS:
  case POCKETJS_NETWORK_V1_ERROR_MQTT_NOT_AUTHORIZED:
  case POCKETJS_NETWORK_V1_ERROR_MQTT_PROTOCOL_ERROR:
  case POCKETJS_NETWORK_V1_ERROR_MESSAGE_TOO_LARGE:
  case POCKETJS_NETWORK_V1_ERROR_SYSTEM_ERROR:
    return true;
  default:
    return false;
  }
}

static bool optional_latin1_property(JSContext *context, JSValueConst object,
                                     const char *name, uint8_t *buffer,
                                     size_t capacity) {
  JSValue value = JS_UNDEFINED;
  const int status = own_data_property_status(context, object, name, &value);
  if (status <= 0) {
    return status == 0;
  }
  size_t length = 0U;
  const bool valid =
      read_latin1(context, value, buffer, capacity, &length, false, true);
  JS_FreeValue(context, value);
  return valid;
}

static bool optional_u32_property(JSContext *context, JSValueConst object,
                                  const char *name, uint32_t minimum,
                                  uint32_t maximum) {
  JSValue value = JS_UNDEFINED;
  const int status = own_data_property_status(context, object, name, &value);
  if (status <= 0) {
    return status == 0;
  }
  uint32_t parsed = 0U;
  const bool valid =
      read_u32(context, value, maximum, &parsed) && parsed >= minimum;
  JS_FreeValue(context, value);
  return valid;
}

static bool parse_body_error_cause(JSContext *context, JSValueConst command,
                                   int32_t *out_cause_code) {
  JSValue error = JS_UNDEFINED;
  uint16_t category = 0U;
  uint16_t code = 0U;
  bool temporary = false;
  uint8_t operation[POCKETJS_NET_ESP_RUNTIME_MAX_OPERATION_LABEL_BYTES];
  size_t operation_length = 0U;
  uint8_t address[POCKETJS_NET_HTTP_CLIENT_CORE_MAX_HOST_BYTES];
  uint8_t cause[POCKETJS_NET_ESP_RUNTIME_MAX_CAUSE_CODE_BYTES];
  const bool valid =
      own_data_property(context, command, "error", &error) &&
      object_u16(context, error, "category",
                 POCKETJS_NETWORK_V1_ERROR_CATEGORY_PROTOCOL, &category) &&
      category >= POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME &&
      object_u16(context, error, "code", INT16_MAX, &code) &&
      known_error_code(code) &&
      object_latin1(context, error, "operation", operation, sizeof(operation),
                    &operation_length, false, false) &&
      object_bool(context, error, "temporary", &temporary) &&
      optional_latin1_property(context, error, "address", address,
                               sizeof(address)) &&
      optional_u32_property(context, error, "port", 1U, UINT16_MAX) &&
      optional_latin1_property(context, error, "causeCode", cause,
                               sizeof(cause)) &&
      optional_u32_property(context, error, "reasonCode", 0U, UINT32_MAX);
  (void)temporary;
  JS_FreeValue(context, error);
  if (valid) {
    *out_cause_code = (int32_t)code;
  }
  return valid;
}

static JSValue binding_dispatch(JSContext *context, JSValueConst this_value,
                                int argument_count, JSValueConst *arguments,
                                int magic, void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  if (argument_count != 1 || !JS_IsObject(arguments[0])) {
    return binding_type_error(context, "dispatch requires one command object");
  }
  runtime->binding_call_active = true;
  uint16_t opcode = 0U;
  pocketjs_network_v1_command_identity_t identity = {0};
  pocketjs_net_esp_runtime_error_t error = {0};
  bool accepted =
      object_u16(context, arguments[0], "opcode", UINT16_MAX, &opcode) &&
      parse_identity(context, arguments[0], &identity);
  if (!accepted) {
    runtime->binding_call_active = false;
    return binding_type_error(context,
                              "command is not an accessor-free ABI value");
  }

  switch (opcode) {
  case POCKETJS_NETWORK_V1_COMMAND_HTTP_REQUEST_START: {
    if (!parse_http_command(context, arguments[0], &runtime->command_scratch) ||
        !parse_optional_input(
            context, arguments[0],
            &runtime->command_scratch.borrowed_input_present)) {
      runtime->binding_call_active = false;
      return binding_type_error(
          context, "HTTP metadata is malformed or exceeds a bound");
    }
    accepted = pocketjs_net_esp_runtime_start_http(
        runtime, &identity, &runtime->command_scratch, &error);
    break;
  }
  case POCKETJS_NETWORK_V1_COMMAND_OPERATION_CANCEL:
    accepted = pocketjs_net_esp_runtime_cancel(runtime, &identity, &error);
    break;
  case POCKETJS_NETWORK_V1_COMMAND_BODY_PULL: {
    uint32_t maximum = 0U;
    accepted =
        object_u32(context, arguments[0], "maxBytes", UINT32_MAX, &maximum) &&
        pocketjs_net_esp_runtime_grant_body_credit(runtime, &identity, maximum,
                                                   &error);
    break;
  }
  case POCKETJS_NETWORK_V1_COMMAND_BODY_CHUNK: {
    JSValue input = JS_UNDEFINED;
    JSValue bytes_value = JS_UNDEFINED;
    uint16_t kind = 0U;
    uint8_t *bytes = NULL;
    size_t length = 0U;
    accepted = own_data_property(context, arguments[0], "input", &input) &&
               object_u16(context, input, "kind", UINT16_MAX, &kind) &&
               kind == POCKETJS_NETWORK_V1_BORROWED_INPUT_BODY_CHUNK &&
               own_data_property(context, input, "bytes", &bytes_value) &&
               typed_array_window(context, bytes_value, &bytes, &length) &&
               pocketjs_net_esp_runtime_submit_body_chunk(
                   runtime, &identity, bytes, length, &error);
    JS_FreeValue(context, bytes_value);
    JS_FreeValue(context, input);
    break;
  }
  case POCKETJS_NETWORK_V1_COMMAND_BODY_END:
    accepted =
        pocketjs_net_esp_runtime_submit_body_end(runtime, &identity, &error);
    break;
  case POCKETJS_NETWORK_V1_COMMAND_BODY_ERROR: {
    int32_t cause_code = 0;
    if (!parse_body_error_cause(context, arguments[0], &cause_code)) {
      runtime->binding_call_active = false;
      return binding_type_error(context, "BODY_ERROR metadata is malformed");
    }
    accepted = pocketjs_net_esp_runtime_submit_body_error(runtime, &identity,
                                                          cause_code, &error);
    break;
  }
  case POCKETJS_NETWORK_V1_COMMAND_BODY_CANCEL:
    accepted = pocketjs_net_esp_runtime_cancel_body(runtime, &identity, &error);
    break;
  default:
    if (pocketjs_net_esp_runtime_validate_identity(runtime, &identity, true,
                                                   &error)) {
      set_error(&error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
                POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED, "network.dispatch",
                false);
    }
    accepted = false;
    break;
  }
  runtime->binding_call_active = false;
  if (!accepted && error.code == 0U) {
    set_error(&error, POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME,
              POCKETJS_NETWORK_V1_ERROR_INVALID_STATE, "network.dispatch",
              false);
  }
  return new_dispatch_result(context, accepted, &error);
}

static pocketjs_net_esp_runtime_error_t
core_error(const pocketjs_net_esp_runtime_slot_t *slot) {
  const pocketjs_net_http_client_error_t code = slot->event.detail.error.code;
  pocketjs_net_esp_runtime_error_t error = {
      .operation = slot->headers_delivered ? "http.body.read" : "http.fetch",
      .temporary = false,
      .cause_code = slot->event.detail.error.cause_code,
      .has_cause_code = slot->event.detail.error.cause_code != 0,
  };
  switch (code) {
  case POCKETJS_NET_HTTP_CLIENT_ERROR_ABORTED:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_ABORTED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TIMED_OUT:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_TIMED_OUT;
    error.temporary = true;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_PERMISSION_DENIED:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_PERMISSION_DENIED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_DNS:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RESOLVER;
    error.code = POCKETJS_NETWORK_V1_ERROR_DNS_TEMPORARY_FAILURE;
    error.temporary = true;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_CONNECT:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TRANSPORT;
    error.code = POCKETJS_NETWORK_V1_ERROR_CONNECTION_REFUSED;
    error.temporary = true;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_IO:
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TRANSPORT:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TRANSPORT;
    error.code = POCKETJS_NETWORK_V1_ERROR_CONNECTION_RESET;
    error.temporary = true;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_RESOURCE_LIMIT:
  case POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_LIMIT:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_RESOURCE_LIMIT;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_UNSUPPORTED:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_UNSUPPORTED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT_BODY_NOT_REPLAYABLE:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_INVALID_STATE;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_PROTOCOL:
  case POCKETJS_NET_HTTP_CLIENT_ERROR_REQUEST_BODY:
  case POCKETJS_NET_HTTP_CLIENT_ERROR_REDIRECT:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_PROTOCOL;
    error.code = POCKETJS_NETWORK_V1_ERROR_HTTP_PROTOCOL_ERROR;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_CERTIFICATE_INVALID:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS;
    error.code = POCKETJS_NETWORK_V1_ERROR_TLS_CERTIFICATE_INVALID;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HOSTNAME_MISMATCH:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS;
    error.code = POCKETJS_NETWORK_V1_ERROR_TLS_HOSTNAME_MISMATCH;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_HANDSHAKE_FAILED:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS;
    error.code = POCKETJS_NETWORK_V1_ERROR_TLS_HANDSHAKE_FAILED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_VERSION_UNSUPPORTED:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS;
    error.code = POCKETJS_NETWORK_V1_ERROR_TLS_VERSION_UNSUPPORTED;
    break;
  case POCKETJS_NET_HTTP_CLIENT_ERROR_TLS_ALERT:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_TLS;
    error.code = POCKETJS_NETWORK_V1_ERROR_TLS_ALERT;
    break;
  default:
    error.category = POCKETJS_NETWORK_V1_ERROR_CATEGORY_RUNTIME;
    error.code = POCKETJS_NETWORK_V1_ERROR_SYSTEM_ERROR;
    break;
  }
  return error;
}

static JSValue new_headers(JSContext *context,
                           pocketjs_net_esp_runtime_t *runtime,
                           const pocketjs_net_http_client_header_t *headers,
                           size_t count) {
  JSValue array = JS_NewArray(context);
  if (JS_IsException(array)) {
    return array;
  }
  for (size_t index = 0U; index < count; ++index) {
    JSValue entry = JS_NewObject(context);
    if (JS_IsException(entry) ||
        !set_property(context, entry, "name",
                      new_latin1_string(context, runtime,
                                        headers[index].name.data,
                                        headers[index].name.length)) ||
        !set_property(context, entry, "value",
                      new_latin1_string(context, runtime,
                                        headers[index].value.data,
                                        headers[index].value.length)) ||
        !freeze(context, entry) ||
        !set_array_property(context, array, (uint32_t)index,
                            JS_DupValue(context, entry))) {
      JS_FreeValue(context, entry);
      JS_FreeValue(context, array);
      return JS_EXCEPTION;
    }
    JS_FreeValue(context, entry);
  }
  if (!freeze(context, array)) {
    JS_FreeValue(context, array);
    return JS_EXCEPTION;
  }
  return array;
}

static JSValue new_response_metadata(JSContext *context,
                                     pocketjs_net_esp_runtime_t *runtime,
                                     pocketjs_net_esp_runtime_slot_t *slot) {
  const pocketjs_net_http_client_event_t *event = &slot->event;
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(
          context, object, "status",
          JS_NewUint32(context, event->detail.response.status_code)) ||
      !set_property(
          context, object, "statusText",
          new_latin1_string(context, runtime,
                            event->detail.response.status_text.data,
                            event->detail.response.status_text.length)) ||
      !set_property(context, object, "headers",
                    new_headers(context, runtime,
                                event->detail.response.headers,
                                event->detail.response.header_count)) ||
      !set_property(context, object, "url",
                    JS_NewStringLen(
                        context, (const char *)event->detail.response.url.data,
                        event->detail.response.url.length)) ||
      !set_property(context, object, "redirected",
                    JS_NewBool(context, event->detail.response.redirected)) ||
      !set_property(
          context, object, "bufferedBodyBytes",
          JS_NewInt64(
              context,
              (int64_t)runtime->limits.buffered_body_bytes.default_value)) ||
      !freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue new_completion(JSContext *context,
                              pocketjs_net_esp_runtime_t *runtime,
                              pocketjs_net_esp_runtime_slot_t *slot,
                              uint64_t sequence) {
  uint16_t event_code = 0U;
  pocketjs_network_v1_handle_t body = {0U, 0U};
  switch (slot->event.type) {
  case POCKETJS_NET_HTTP_CLIENT_EVENT_REQUEST_BODY_PULL:
    event_code = POCKETJS_NETWORK_V1_EVENT_BODY_PULL;
    body = slot->request_body;
    break;
  case POCKETJS_NET_HTTP_CLIENT_EVENT_RESPONSE_HEADERS:
    event_code = POCKETJS_NETWORK_V1_EVENT_HTTP_RESPONSE_HEADERS;
    body = slot->response_body;
    break;
  case POCKETJS_NET_HTTP_CLIENT_EVENT_BODY:
    event_code = POCKETJS_NETWORK_V1_EVENT_BODY_CHUNK;
    body = slot->response_body;
    break;
  case POCKETJS_NET_HTTP_CLIENT_EVENT_COMPLETE:
    event_code = POCKETJS_NETWORK_V1_EVENT_BODY_END;
    body = slot->response_body;
    break;
  case POCKETJS_NET_HTTP_CLIENT_EVENT_ERROR:
    event_code = slot->headers_delivered
                     ? POCKETJS_NETWORK_V1_EVENT_BODY_ERROR
                     : POCKETJS_NETWORK_V1_EVENT_HTTP_REQUEST_ERROR;
    body = slot->headers_delivered ? slot->response_body : slot->request_body;
    break;
  default:
    return binding_type_error(context, "Core produced an unknown event");
  }
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(context, object, "eventCode",
                    JS_NewUint32(context, event_code)) ||
      !set_property(context, object, "identity",
                    new_identity(context, runtime, slot, body, sequence))) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  if (event_code == POCKETJS_NETWORK_V1_EVENT_BODY_PULL) {
    if (!set_property(
            context, object, "maxBytes",
            JS_NewUint32(context, (uint32_t)slot->event.detail.request_body_pull
                                      .maximum_bytes))) {
      JS_FreeValue(context, object);
      return JS_EXCEPTION;
    }
  } else if (event_code == POCKETJS_NETWORK_V1_EVENT_HTTP_RESPONSE_HEADERS) {
    if (!set_property(context, object, "metadata",
                      new_response_metadata(context, runtime, slot))) {
      JS_FreeValue(context, object);
      return JS_EXCEPTION;
    }
  } else if (event_code == POCKETJS_NETWORK_V1_EVENT_BODY_CHUNK) {
    JSValue payload = JS_NewObject(context);
    if (JS_IsException(payload) ||
        !set_property(context, payload, "runtimeGeneration",
                      JS_NewUint32(context, runtime->runtime_generation)) ||
        !set_property(context, payload, "lease",
                      new_handle(context, slot->lease)) ||
        !set_property(context, payload, "byteLength",
                      JS_NewUint32(context, slot->lease_byte_length)) ||
        !freeze(context, payload) ||
        !set_property(context, object, "payload",
                      JS_DupValue(context, payload))) {
      JS_FreeValue(context, payload);
      JS_FreeValue(context, object);
      return JS_EXCEPTION;
    }
    JS_FreeValue(context, payload);
  } else if (event_code == POCKETJS_NETWORK_V1_EVENT_HTTP_REQUEST_ERROR ||
             event_code == POCKETJS_NETWORK_V1_EVENT_BODY_ERROR) {
    const pocketjs_net_esp_runtime_error_t error = core_error(slot);
    if (!set_property(context, object, "error", new_error(context, &error))) {
      JS_FreeValue(context, object);
      return JS_EXCEPTION;
    }
  }
  if (!freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue new_poll_empty(JSContext *context, uint16_t status) {
  JSValue object = JS_NewObject(context);
  if (JS_IsException(object) ||
      !set_property(context, object, "status", JS_NewUint32(context, status)) ||
      !set_property(context, object, "payloadBytesDelivered",
                    JS_NewUint32(context, 0U)) ||
      !freeze(context, object)) {
    JS_FreeValue(context, object);
    return JS_EXCEPTION;
  }
  return object;
}

static JSValue binding_next_completion(JSContext *context,
                                       JSValueConst this_value,
                                       int argument_count,
                                       JSValueConst *arguments, int magic,
                                       void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  if (argument_count != 1) {
    return binding_type_error(context,
                              "nextCompletion requires one poll request");
  }
  uint32_t generation = 0U;
  uint32_t budget = 0U;
  if (!object_u32(context, arguments[0], "runtimeGeneration", UINT32_MAX,
                  &generation) ||
      !object_u32(context, arguments[0], "maxPayloadBytes", UINT32_MAX,
                  &budget) ||
      generation != runtime->runtime_generation) {
    return binding_type_error(context, "completion poll is stale or malformed");
  }
  if (!runtime->service_call_active || !runtime->dispatcher_call_active) {
    return binding_type_error(context,
                              "completion poll is outside its service turn");
  }
  if (runtime->turn_events_remaining == 0U || budget == 0U ||
      runtime->turn_payload_remaining == 0U) {
    const int ready = pocketjs_net_esp_runtime_completion_readiness(runtime);
    if (ready < 0) {
      return binding_type_error(context, "native readiness probe failed");
    }
    runtime->turn_last_poll_status =
        ready != 0 ? POCKETJS_NETWORK_V1_COMPLETION_POLL_BUDGET_EXHAUSTED
                   : POCKETJS_NETWORK_V1_COMPLETION_POLL_DRAINED;
    return new_poll_empty(context, runtime->turn_last_poll_status);
  }
  runtime->binding_call_active = true;
  pocketjs_net_esp_runtime_slot_t *slot = NULL;
  const bool ready = pocketjs_net_esp_runtime_peek_event(runtime, &slot);
  if (!ready || slot == NULL) {
    runtime->binding_call_active = false;
    const int pending = pocketjs_net_esp_runtime_completion_readiness(runtime);
    if (pending < 0 || runtime->poison_flags != 0U) {
      return binding_type_error(context, "native event queue is poisoned");
    }
    runtime->turn_last_poll_status =
        pending != 0 ? POCKETJS_NETWORK_V1_COMPLETION_POLL_BUDGET_EXHAUSTED
                     : POCKETJS_NETWORK_V1_COMPLETION_POLL_DRAINED;
    return new_poll_empty(context, runtime->turn_last_poll_status);
  }
  const uint32_t payload =
      slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY
          ? slot->lease_byte_length
          : 0U;
  if (budget == 0U || payload > budget ||
      payload > runtime->turn_payload_remaining) {
    runtime->binding_call_active = false;
    runtime->turn_last_poll_status =
        POCKETJS_NETWORK_V1_COMPLETION_POLL_BUDGET_EXHAUSTED;
    return new_poll_empty(context,
                          POCKETJS_NETWORK_V1_COMPLETION_POLL_BUDGET_EXHAUSTED);
  }
  if (runtime->completion_sequence >= POCKETJS_NETWORK_V1_SEQUENCE_MAX) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_SEQUENCE);
    runtime->binding_call_active = false;
    return binding_type_error(context, "completion sequence is exhausted");
  }
  const uint64_t completion_sequence = runtime->completion_sequence + 1U;
  JSValue completion =
      new_completion(context, runtime, slot, completion_sequence);
  if (JS_IsException(completion)) {
    runtime->binding_call_active = false;
    return completion;
  }
  JSValue result = JS_NewObject(context);
  if (JS_IsException(result) ||
      !set_property(
          context, result, "status",
          JS_NewUint32(context, POCKETJS_NETWORK_V1_COMPLETION_POLL_ITEM)) ||
      !set_property(context, result, "completion",
                    JS_DupValue(context, completion)) ||
      !set_property(context, result, "payloadBytesDelivered",
                    JS_NewUint32(context, payload)) ||
      !freeze(context, result)) {
    JS_FreeValue(context, completion);
    JS_FreeValue(context, result);
    runtime->binding_call_active = false;
    return JS_EXCEPTION;
  }
  JS_FreeValue(context, completion);
  if (slot->event.type != POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
      !pocketjs_net_esp_runtime_retire_nonlease_event(runtime, slot)) {
    JS_FreeValue(context, result);
    runtime->binding_call_active = false;
    return binding_type_error(context, "Core event retirement failed");
  }
  runtime->completion_sequence = completion_sequence;
  --runtime->turn_events_remaining;
  runtime->turn_payload_remaining -= payload;
  ++runtime->turn_events_observed;
  runtime->turn_payload_observed += payload;
  runtime->turn_last_sequence_observed = completion_sequence;
  runtime->turn_last_poll_status = POCKETJS_NETWORK_V1_COMPLETION_POLL_ITEM;
  if (slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY) {
    slot->lease_descriptor_delivered = true;
  }
  ++runtime->completions_delivered;
  runtime->binding_call_active = false;
  return result;
}

static bool
parse_lease_command(JSContext *context, JSValueConst command,
                    uint16_t expected_opcode,
                    pocketjs_network_v1_command_identity_t *out_identity,
                    pocketjs_network_v1_handle_t *out_lease) {
  uint16_t opcode = 0U;
  JSValue lease = JS_UNDEFINED;
  const bool valid =
      object_u16(context, command, "opcode", UINT16_MAX, &opcode) &&
      opcode == expected_opcode &&
      parse_identity(context, command, out_identity) &&
      own_data_property(context, command, "lease", &lease) &&
      parse_handle(context, lease, out_lease);
  JS_FreeValue(context, lease);
  return valid;
}

static JSValue binding_lease_take(JSContext *context, JSValueConst this_value,
                                  int argument_count, JSValueConst *arguments,
                                  int magic, void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  if (!runtime->service_call_active || !runtime->dispatcher_call_active) {
    return binding_type_error(context, "leaseTake is outside its service turn");
  }
  pocketjs_network_v1_command_identity_t identity = {0};
  pocketjs_network_v1_handle_t lease = {0};
  uint32_t byte_length = 0U;
  if (argument_count != 1 ||
      !parse_lease_command(context, arguments[0],
                           POCKETJS_NETWORK_V1_COMMAND_BUFFER_LEASE_TAKE,
                           &identity, &lease) ||
      !object_u32(context, arguments[0], "byteLength", UINT32_MAX,
                  &byte_length)) {
    return binding_type_error(context, "leaseTake command is malformed");
  }
  runtime->binding_call_active = true;
  pocketjs_net_esp_runtime_error_t error = {0};
  uint32_t taken_length = 0U;
  const bool completed = pocketjs_net_esp_runtime_lease_take(
      runtime, &identity, lease, byte_length, &taken_length, &error);
  runtime->binding_call_active = false;
  if (!completed) {
    return new_sync_result(context, false, &error);
  }
  JSValue result = JS_NewObject(context);
  if (JS_IsException(result) ||
      !set_property(
          context, result, "status",
          JS_NewUint32(context, POCKETJS_NETWORK_V1_DISPATCH_COMPLETED)) ||
      !set_property(context, result, "byteLength",
                    JS_NewUint32(context, taken_length)) ||
      !freeze(context, result)) {
    JS_FreeValue(context, result);
    return JS_EXCEPTION;
  }
  return result;
}

static JSValue binding_lease_read_into(JSContext *context,
                                       JSValueConst this_value,
                                       int argument_count,
                                       JSValueConst *arguments, int magic,
                                       void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  if (!runtime->service_call_active || !runtime->dispatcher_call_active) {
    return binding_type_error(context,
                              "leaseReadInto is outside its service turn");
  }
  pocketjs_network_v1_command_identity_t identity = {0};
  pocketjs_network_v1_handle_t lease = {0};
  uint32_t offset = 0U;
  uint32_t maximum = 0U;
  uint8_t *destination = NULL;
  size_t destination_length = 0U;
  if (argument_count != 2 ||
      !parse_lease_command(context, arguments[0],
                           POCKETJS_NETWORK_V1_COMMAND_BUFFER_LEASE_READ_INTO,
                           &identity, &lease) ||
      !object_u32(context, arguments[0], "offset", UINT32_MAX, &offset) ||
      !object_u32(context, arguments[0], "maxBytes", UINT32_MAX, &maximum) ||
      !typed_array_window(context, arguments[1], &destination,
                          &destination_length)) {
    return binding_type_error(context, "leaseReadInto command is malformed");
  }
  runtime->binding_call_active = true;
  pocketjs_net_esp_runtime_error_t error = {0};
  uint32_t copied = 0U;
  const bool completed = pocketjs_net_esp_runtime_lease_read(
      runtime, &identity, lease, offset, maximum, destination,
      destination_length, &copied, &error);
  runtime->binding_call_active = false;
  if (!completed) {
    return new_sync_result(context, false, &error);
  }
  JSValue result = JS_NewObject(context);
  if (JS_IsException(result) ||
      !set_property(
          context, result, "status",
          JS_NewUint32(context, POCKETJS_NETWORK_V1_DISPATCH_COMPLETED)) ||
      !set_property(context, result, "bytesCopied",
                    JS_NewUint32(context, copied)) ||
      !freeze(context, result)) {
    JS_FreeValue(context, result);
    return JS_EXCEPTION;
  }
  return result;
}

static JSValue binding_lease_release(JSContext *context,
                                     JSValueConst this_value,
                                     int argument_count,
                                     JSValueConst *arguments, int magic,
                                     void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  if (!runtime->service_call_active || !runtime->dispatcher_call_active) {
    return binding_type_error(context,
                              "leaseRelease is outside its service turn");
  }
  pocketjs_network_v1_command_identity_t identity = {0};
  pocketjs_network_v1_handle_t lease = {0};
  if (argument_count != 1 ||
      !parse_lease_command(context, arguments[0],
                           POCKETJS_NETWORK_V1_COMMAND_BUFFER_LEASE_RELEASE,
                           &identity, &lease)) {
    return binding_type_error(context, "leaseRelease command is malformed");
  }
  runtime->binding_call_active = true;
  pocketjs_net_esp_runtime_error_t error = {0};
  const bool completed =
      pocketjs_net_esp_runtime_lease_release(runtime, &identity, lease, &error);
  runtime->binding_call_active = false;
  return new_sync_result(context, completed, &error);
}

static JSValue new_limit_entry(JSContext *context, const char *name,
                               pocketjs_net_esp_runtime_limit_range_t value) {
  JSValue entry = JS_NewObject(context);
  if (JS_IsException(entry) ||
      !set_property(context, entry, "name", JS_NewString(context, name)) ||
      !set_property(context, entry, "default",
                    JS_NewInt64(context, (int64_t)value.default_value)) ||
      !set_property(context, entry, "hard",
                    JS_NewInt64(context, (int64_t)value.hard)) ||
      !set_property(context, entry, "minimum",
                    JS_NewInt64(context, (int64_t)value.minimum)) ||
      !freeze(context, entry)) {
    JS_FreeValue(context, entry);
    return JS_EXCEPTION;
  }
  return entry;
}

static bool set_feature_projection(JSContext *context, JSValueConst array,
                                   const pocketjs_net_esp_runtime_t *runtime) {
  for (uint32_t index = 0U; index < runtime->feature_count; ++index) {
    if (!set_array_property(
            context, array, index,
            JS_NewUint32(context, runtime->feature_ids[index]))) {
      return false;
    }
  }
  return true;
}

static JSValue binding_get_limits(JSContext *context, JSValueConst this_value,
                                  int argument_count, JSValueConst *arguments,
                                  int magic, void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  uint32_t generation = 0U;
  uint16_t protocol = 0U;
  uint16_t role = 0U;
  if (argument_count != 1 ||
      !object_u32(context, arguments[0], "runtimeGeneration", UINT32_MAX,
                  &generation) ||
      !object_u16(context, arguments[0], "protocol", UINT16_MAX, &protocol) ||
      !object_u16(context, arguments[0], "role", UINT16_MAX, &role) ||
      generation != runtime->runtime_generation ||
      (protocol != POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_ANY &&
       protocol != POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_HTTP &&
       protocol != POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_WEBSOCKET &&
       protocol != POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_MQTT &&
       protocol != POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_TCP &&
       protocol != POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_UDP) ||
      (role != POCKETJS_NETWORK_V1_LIMIT_ROLE_ANY &&
       role != POCKETJS_NETWORK_V1_LIMIT_ROLE_CLIENT &&
       role != POCKETJS_NETWORK_V1_LIMIT_ROLE_SERVER)) {
    return binding_type_error(context, "limits query is stale or malformed");
  }
  const bool included = (protocol == POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_ANY ||
                         protocol == POCKETJS_NETWORK_V1_LIMIT_PROTOCOL_HTTP) &&
                        (role == POCKETJS_NETWORK_V1_LIMIT_ROLE_ANY ||
                         role == POCKETJS_NETWORK_V1_LIMIT_ROLE_CLIENT);
  JSValue values = JS_NewArray(context);
  JSValue features = JS_NewArray(context);
  if (JS_IsException(values) || JS_IsException(features)) {
    JS_FreeValue(context, features);
    JS_FreeValue(context, values);
    return JS_EXCEPTION;
  }
  if (included) {
    static const char *const names[] = {
        "http.bufferedBodyBytes",    "http.headerBytes",
        "http.maxBodyChunkBytes",    "http.maxOperations",
        "runtime.nativeBufferBytes",
    };
    const pocketjs_net_esp_runtime_limit_range_t limits[] = {
        runtime->limits.buffered_body_bytes,  runtime->limits.header_bytes,
        runtime->limits.max_body_chunk_bytes, runtime->limits.max_operations,
        runtime->limits.native_buffer_bytes,
    };
    for (uint32_t index = 0U; index < 5U; ++index) {
      JSValue entry = new_limit_entry(context, names[index], limits[index]);
      if (JS_IsException(entry) ||
          !set_array_property(context, values, index,
                              JS_DupValue(context, entry))) {
        JS_FreeValue(context, entry);
        JS_FreeValue(context, features);
        JS_FreeValue(context, values);
        return JS_EXCEPTION;
      }
      JS_FreeValue(context, entry);
    }
    if (!set_feature_projection(context, features, runtime)) {
      JS_FreeValue(context, features);
      JS_FreeValue(context, values);
      return JS_EXCEPTION;
    }
  }
  if (!freeze(context, values) || !freeze(context, features)) {
    JS_FreeValue(context, features);
    JS_FreeValue(context, values);
    return JS_EXCEPTION;
  }
  JSValue snapshot = JS_NewObject(context);
  if (JS_IsException(snapshot) ||
      !set_property(context, snapshot, "runtimeGeneration",
                    JS_NewUint32(context, generation)) ||
      !set_property(context, snapshot, "protocol",
                    JS_NewUint32(context, protocol)) ||
      !set_property(context, snapshot, "role", JS_NewUint32(context, role)) ||
      !set_property(context, snapshot, "values",
                    JS_DupValue(context, values)) ||
      !set_property(context, snapshot, "featureIds",
                    JS_DupValue(context, features)) ||
      !freeze(context, snapshot)) {
    JS_FreeValue(context, features);
    JS_FreeValue(context, values);
    JS_FreeValue(context, snapshot);
    return JS_EXCEPTION;
  }
  JS_FreeValue(context, features);
  JS_FreeValue(context, values);
  return snapshot;
}

static JSValue binding_register_dispatcher(JSContext *context,
                                           JSValueConst this_value,
                                           int argument_count,
                                           JSValueConst *arguments, int magic,
                                           void *opaque) {
  (void)this_value;
  (void)magic;
  pocketjs_net_esp_runtime_t *runtime = binding_runtime(context, opaque);
  if (runtime == NULL) {
    return JS_EXCEPTION;
  }
  if (argument_count != 1 || !JS_IsFunction(context, arguments[0]) ||
      runtime->dispatcher_registered ||
      runtime->phase != POCKETJS_NET_ESP_RUNTIME_PHASE_RUNNING) {
    return binding_type_error(context,
                              "service dispatcher registration is invalid");
  }
  runtime->dispatcher = JS_DupValue(context, arguments[0]);
  runtime->dispatcher_registered = true;
  return JS_UNDEFINED;
}

static bool add_closure(JSContext *context, JSValueConst table,
                        const char *name, int length, JSCClosure *function,
                        pocketjs_net_esp_runtime_binding_state_t *state) {
  /*
   * A NULL function name leaves no fallible atom allocation after QuickJS has
   * attached the opaque finalizer. The table property still has the ABI name.
   */
  JSValue closure = JS_NewCClosure(context, function, NULL,
                                   binding_state_release, length, 0, state);
  if (JS_IsException(closure)) {
    return false;
  }
  /* A returned closure already owns the opaque finalizer, even if an internal
   * property allocation left a pending exception. Balance that ownership before
   * observing the constructor's pending-exception boundary. */
  ++state->references;
  if (JS_HasException(context)) {
    JS_FreeValue(context, closure);
    return false;
  }
  const bool installed =
      set_property(context, table, name, JS_DupValue(context, closure));
  JS_FreeValue(context, closure);
  return installed;
}

esp_err_t
pocketjs_net_esp_runtime_create_binding(pocketjs_net_esp_runtime_t *runtime) {
  pocketjs_net_esp_runtime_binding_state_t *state = calloc(1U, sizeof(*state));
  if (state == NULL) {
    return ESP_ERR_NO_MEM;
  }
  state->runtime = runtime;
  state->references = 1U;
  JSContext *context = runtime->context;
  if (JS_HasException(context)) {
    pocketjs_esp_guest_log_exception(runtime->guest,
                                     "network_binding_create_entry");
    binding_state_release(state);
    return ESP_FAIL;
  }
  JSValue feature_ids = JS_NewArray(context);
  JSValue plan_hash = JS_NewUint8ArrayCopy(context, runtime->plan_hash,
                                           sizeof(runtime->plan_hash));
  JSValue handshake = JS_NewObject(context);
  JSValue table = JS_NewObject(context);
  if (JS_IsException(feature_ids) || JS_IsException(plan_hash) ||
      JS_IsException(handshake) || JS_IsException(table) ||
      !set_feature_projection(context, feature_ids, runtime) ||
      !freeze(context, feature_ids) ||
      !set_property(context, handshake, "abiMajor",
                    JS_NewUint32(context, POCKETJS_NETWORK_V1_ABI_MAJOR)) ||
      !set_property(context, handshake, "abiMinor",
                    JS_NewUint32(context, POCKETJS_NETWORK_V1_ABI_MINOR)) ||
      !set_property(context, handshake, "runtimeGeneration",
                    JS_NewUint32(context, runtime->runtime_generation)) ||
      !set_property(context, handshake, "planHash",
                    JS_DupValue(context, plan_hash)) ||
      !set_property(context, handshake, "featureIds",
                    JS_DupValue(context, feature_ids)) ||
      !freeze(context, handshake) ||
      !set_property(context, table, "handshake",
                    JS_DupValue(context, handshake)) ||
      !add_closure(context, table, "getLimits", 1, binding_get_limits, state) ||
      !add_closure(context, table, "dispatch", 1, binding_dispatch, state) ||
      !add_closure(context, table, "nextCompletion", 1, binding_next_completion,
                   state) ||
      !add_closure(context, table, "leaseTake", 1, binding_lease_take, state) ||
      !add_closure(context, table, "leaseReadInto", 2, binding_lease_read_into,
                   state) ||
      !add_closure(context, table, "leaseRelease", 1, binding_lease_release,
                   state) ||
      !add_closure(context, table, "registerServiceDispatcher", 1,
                   binding_register_dispatcher, state) ||
      !freeze(context, table) || JS_HasException(context)) {
    JS_FreeValue(context, table);
    JS_FreeValue(context, handshake);
    JS_FreeValue(context, plan_hash);
    JS_FreeValue(context, feature_ids);
    binding_state_release(state);
    if (JS_HasException(context)) {
      pocketjs_esp_guest_log_exception(runtime->guest,
                                       "network_binding_create");
    }
    return ESP_FAIL;
  }
  JS_FreeValue(context, handshake);
  JS_FreeValue(context, plan_hash);
  JS_FreeValue(context, feature_ids);
  runtime->binding_state = state;
  runtime->binding = table;
  return ESP_OK;
}

void pocketjs_net_esp_runtime_revoke_binding(
    pocketjs_net_esp_runtime_t *runtime) {
  pocketjs_net_esp_runtime_binding_state_t *state = runtime->binding_state;
  if (state != NULL) {
    state->runtime = NULL;
  }
  JS_FreeValue(runtime->context, runtime->dispatcher);
  runtime->dispatcher = JS_UNDEFINED;
  runtime->dispatcher_registered = false;
  JS_FreeValue(runtime->context, runtime->binding);
  runtime->binding = JS_UNDEFINED;
  runtime->binding_state = NULL;
  binding_state_release(state);
}

static bool
turn_has_outstanding_lease(const pocketjs_net_esp_runtime_t *runtime) {
  for (size_t index = 0U; index < runtime->max_operations; ++index) {
    const pocketjs_net_esp_runtime_slot_t *slot = &runtime->slots[index];
    if (slot->event_pending &&
        slot->event.type == POCKETJS_NET_HTTP_CLIENT_EVENT_BODY &&
        slot->lease_descriptor_delivered) {
      return true;
    }
  }
  return false;
}

esp_err_t pocketjs_net_esp_runtime_call_dispatcher(
    pocketjs_net_esp_runtime_t *runtime,
    pocketjs_network_v1_service_turn_kind_t kind, uint32_t max_events,
    uint32_t max_payload_bytes,
    pocketjs_net_esp_runtime_service_result_t *out_result) {
  if (!runtime->dispatcher_registered) {
    *out_result = (pocketjs_net_esp_runtime_service_result_t){
        .status = POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED,
    };
    return ESP_OK;
  }
  if (!pocketjs_net_esp_runtime_next_sequence(&runtime->service_turn)) {
    pocketjs_net_esp_runtime_poison(runtime,
                                    POCKETJS_NET_ESP_RUNTIME_POISON_SEQUENCE);
    return ESP_ERR_INVALID_STATE;
  }
  runtime->turn_events_remaining = max_events;
  runtime->turn_payload_remaining = max_payload_bytes;
  runtime->turn_events_observed = 0U;
  runtime->turn_payload_observed = 0U;
  runtime->turn_last_sequence_observed = 0U;
  runtime->turn_last_poll_status = 0U;
  JSContext *context = runtime->context;
  JSValue request = JS_NewObject(context);
  if (JS_IsException(request) ||
      !set_property(context, request, "runtimeGeneration",
                    JS_NewUint32(context, runtime->runtime_generation)) ||
      !set_property(context, request, "turnId",
                    JS_NewInt64(context, (int64_t)runtime->service_turn)) ||
      !set_property(context, request, "kind", JS_NewUint32(context, kind)) ||
      !set_property(context, request, "maxEvents",
                    JS_NewUint32(context, max_events)) ||
      !set_property(context, request, "maxPayloadBytes",
                    JS_NewUint32(context, max_payload_bytes)) ||
      !freeze(context, request)) {
    JS_FreeValue(context, request);
    return ESP_ERR_NO_MEM;
  }
  JSValue result = JS_UNDEFINED;
  runtime->dispatcher_call_active = true;
  esp_err_t call_result = pocketjs_esp_guest_call_function(
      runtime->guest, "network_service_dispatcher", runtime->dispatcher,
      runtime->binding, 1U, &request, &result);
  runtime->dispatcher_call_active = false;
  JS_FreeValue(context, request);
  if (call_result != ESP_OK) {
    /* The Guest contract returns undefined on failure; freeing is also safe if
     * a hostile implementation transferred an owned value before failing. */
    JS_FreeValue(context, result);
    return call_result;
  }
  if (turn_has_outstanding_lease(runtime)) {
    JS_FreeValue(context, result);
    return ESP_ERR_INVALID_RESPONSE;
  }
  uint16_t status = 0U;
  uint32_t events = 0U;
  uint32_t payload = 0U;
  uint64_t last_sequence = 0U;
  const bool valid =
      object_u16(context, result, "status", UINT16_MAX, &status) &&
      object_u32(context, result, "eventsDelivered", UINT32_MAX, &events) &&
      object_u32(context, result, "payloadBytesDelivered", UINT32_MAX,
                 &payload) &&
      object_u64(context, result, "lastSequence",
                 POCKETJS_NETWORK_V1_SEQUENCE_MAX, &last_sequence) &&
      (status == POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED ||
       status == POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY) &&
      events == runtime->turn_events_observed &&
      payload == runtime->turn_payload_observed &&
      last_sequence == runtime->turn_last_sequence_observed &&
      ((status == POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_DRAINED &&
        runtime->turn_last_poll_status ==
            POCKETJS_NETWORK_V1_COMPLETION_POLL_DRAINED) ||
       (status == POCKETJS_NETWORK_V1_SERVICE_TURN_STATUS_MORE_READY &&
        (runtime->turn_last_poll_status ==
             POCKETJS_NETWORK_V1_COMPLETION_POLL_BUDGET_EXHAUSTED ||
         (runtime->turn_last_poll_status ==
              POCKETJS_NETWORK_V1_COMPLETION_POLL_ITEM &&
          runtime->turn_events_remaining == 0U))));
  JS_FreeValue(context, result);
  if (!valid) {
    return ESP_ERR_INVALID_RESPONSE;
  }
  *out_result = (pocketjs_net_esp_runtime_service_result_t){
      .status = status,
      .events_delivered = events,
      .payload_bytes_delivered = payload,
      .last_sequence = last_sequence,
  };
  return ESP_OK;
}
