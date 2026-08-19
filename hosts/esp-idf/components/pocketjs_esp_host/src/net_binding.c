/* `globalThis.net` / `ws` / `httpd` on QuickJS-ng: each op takes the runtime
 * lock, forwards to the portable core and marshals the result. Buffers are
 * borrowed for the duration of the synchronous call only; the core copies
 * everything it keeps. */
#include "host_internal.h"

#include <string.h>

/* The host pointer travels in the function's magic-less opaque: QuickJS-ng
 * C functions get no closure, so keep the active host in the runtime opaque. */
static pocketjs_esp_host_t *host_of(JSContext *ctx) {
  return JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
}

/* --- argument helpers ------------------------------------------------------- */

static bool arg_i32(JSContext *ctx, JSValueConst v, int32_t *out) {
  return JS_ToInt32(ctx, out, v) == 0;
}

/** Borrow an ArrayBuffer (or null/undefined → NULL with len 0). Returns false
 * and throws on any other type. */
static bool arg_buffer(JSContext *ctx, JSValueConst v, uint8_t **ptr, size_t *len) {
  if (JS_IsNull(v) || JS_IsUndefined(v)) {
    *ptr = NULL;
    *len = 0;
    return true;
  }
  size_t size = 0;
  uint8_t *p = JS_GetArrayBuffer(ctx, &size, v);
  /* NULL means "not an ArrayBuffer" or "detached": QuickJS left the TypeError
   * pending. Zero-length buffers still yield a non-NULL data pointer. */
  if (!p) return false;
  *ptr = p;
  *len = size;
  return true;
}

/** Slice into a borrowed ArrayBuffer at [offset, offset+length). */
static bool arg_window(JSContext *ctx, JSValueConst buf, JSValueConst off, JSValueConst len, uint8_t **ptr, size_t *out_len) {
  size_t size = 0;
  uint8_t *p = JS_GetArrayBuffer(ctx, &size, buf);
  if (!p) {
    JS_FreeValue(ctx, JS_GetException(ctx)); /* replaced by the caller's RangeError */
    return false;
  }
  int32_t o, l;
  if (!arg_i32(ctx, off, &o) || !arg_i32(ctx, len, &l) || o < 0 || l < 0) return false;
  if ((size_t)o > size || (size_t)l > size - (size_t)o) return false;
  *ptr = p + o;
  *out_len = (size_t)l;
  return true;
}

#define WITH_HOST(name)                                    \
  pocketjs_esp_host_t *host = host_of(ctx);                \
  (void)this_val;                                          \
  if (!host || !host->net) return JS_ThrowTypeError(ctx, name ": network runtime unavailable")

#define LOCKED(expr)                     \
  do {                                   \
    pocketjs_host_net_lock(host);        \
    expr;                                \
    pocketjs_host_net_unlock(host);      \
    host->net_dirty = true;              \
  } while (0)

/* --- net ---------------------------------------------------------------------- */

static JSValue net_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("net.start");
  if (argc < 1) return JS_ThrowTypeError(ctx, "net.start(meta, body)");
  const char *meta = JS_ToCString(ctx, argv[0]);
  if (!meta) return JS_EXCEPTION;
  uint8_t *body = NULL;
  size_t body_len = 0;
  if (argc >= 2 && !arg_buffer(ctx, argv[1], &body, &body_len)) {
    JS_FreeCString(ctx, meta);
    return JS_EXCEPTION;
  }
  int handle;
  LOCKED(handle = pnet_http_start(host->net, meta, body, body_len));
  JS_FreeCString(ctx, meta);
  return JS_NewInt32(ctx, handle);
}

static JSValue net_cancel(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("net.cancel");
  int32_t handle;
  if (argc < 1 || !arg_i32(ctx, argv[0], &handle)) return JS_UNDEFINED;
  LOCKED(pnet_http_cancel(host->net, handle));
  return JS_UNDEFINED;
}

static JSValue net_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("net.poll");
  (void)argc;
  (void)argv;
  size_t len = 0;
  pocketjs_host_net_lock(host);
  /* Two-phase poll: the batch leaves the core only once the guest holds its
   * copy. If QuickJS cannot allocate the string the events stay visible and
   * are rendered again next tick instead of vanishing. */
  const char *batch = pnet_http_poll_render(host->net, &len);
  JSValue out = batch ? JS_NewStringLen(ctx, batch, len) : JS_UNDEFINED;
  if (batch && !JS_IsException(out)) pnet_http_poll_consume(host->net);
  pocketjs_host_net_unlock(host);
  return out;
}

static JSValue net_last_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("net.lastError");
  (void)argc;
  (void)argv;
  pocketjs_host_net_lock(host);
  JSValue out = JS_NewString(ctx, pnet_http_last_error(host->net));
  pocketjs_host_net_unlock(host);
  return out;
}

static JSValue net_read_into(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("net.readInto");
  int32_t handle;
  uint8_t *ptr;
  size_t len;
  if (argc < 4 || !arg_i32(ctx, argv[0], &handle) || !arg_window(ctx, argv[1], argv[2], argv[3], &ptr, &len)) {
    return JS_ThrowRangeError(ctx, "net.readInto(handle, buffer, offset, length)");
  }
  int n;
  LOCKED(n = pnet_http_read_into(host->net, handle, ptr, len));
  return JS_NewInt32(ctx, n);
}

static JSValue net_limits(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("net.limits");
  (void)argc;
  (void)argv;
  return JS_NewString(ctx, pnet_http_limits(host->net));
}

/* --- ws ----------------------------------------------------------------------- */

static JSValue ws_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.connect");
  if (argc < 1) return JS_ThrowTypeError(ctx, "ws.connect(meta)");
  const char *meta = JS_ToCString(ctx, argv[0]);
  if (!meta) return JS_EXCEPTION;
  int handle;
  LOCKED(handle = pnet_ws_connect(host->net, meta));
  JS_FreeCString(ctx, meta);
  return JS_NewInt32(ctx, handle);
}

static JSValue ws_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.send");
  int32_t handle, opcode;
  if (argc < 3 || !arg_i32(ctx, argv[0], &handle) || !arg_i32(ctx, argv[1], &opcode)) {
    return JS_ThrowTypeError(ctx, "ws.send(handle, opcode, payload)");
  }
  const uint8_t *payload = NULL;
  size_t len = 0;
  const char *text = NULL;
  if (JS_IsString(argv[2])) {
    text = JS_ToCStringLen(ctx, &len, argv[2]);
    if (!text) return JS_EXCEPTION;
    payload = (const uint8_t *)text;
  } else {
    uint8_t *p;
    if (!arg_buffer(ctx, argv[2], &p, &len)) return JS_EXCEPTION;
    payload = p;
  }
  int rc;
  LOCKED(rc = pnet_ws_send(host->net, handle, opcode, payload, len));
  if (text) JS_FreeCString(ctx, text);
  return JS_NewInt32(ctx, rc);
}

static JSValue ws_receive_into(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.receiveInto");
  int32_t handle;
  uint8_t *ptr;
  size_t len;
  if (argc < 4 || !arg_i32(ctx, argv[0], &handle) || !arg_window(ctx, argv[1], argv[2], argv[3], &ptr, &len)) {
    return JS_ThrowRangeError(ctx, "ws.receiveInto(handle, buffer, offset, length)");
  }
  int n;
  LOCKED(n = pnet_ws_receive_into(host->net, handle, ptr, len));
  return JS_NewInt32(ctx, n);
}

static JSValue ws_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.close");
  int32_t handle, code = 0;
  if (argc < 1 || !arg_i32(ctx, argv[0], &handle)) return JS_NewInt32(ctx, -1);
  if (argc >= 2 && !JS_IsUndefined(argv[1]) && !arg_i32(ctx, argv[1], &code)) return JS_NewInt32(ctx, -3);
  const char *reason = NULL;
  size_t reason_len = 0;
  if (argc >= 3 && !JS_IsUndefined(argv[2])) {
    reason = JS_ToCStringLen(ctx, &reason_len, argv[2]);
    if (!reason) return JS_EXCEPTION;
  }
  int rc;
  LOCKED(rc = pnet_ws_close(host->net, handle, code, reason, reason_len));
  if (reason) JS_FreeCString(ctx, reason);
  return JS_NewInt32(ctx, rc);
}

static JSValue ws_terminate(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.terminate");
  int32_t handle;
  if (argc < 1 || !arg_i32(ctx, argv[0], &handle)) return JS_UNDEFINED;
  LOCKED(pnet_ws_terminate(host->net, handle));
  return JS_UNDEFINED;
}

static JSValue ws_buffered_amount(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.bufferedAmount");
  int32_t handle;
  if (argc < 1 || !arg_i32(ctx, argv[0], &handle)) return JS_NewInt32(ctx, -1);
  int n;
  pocketjs_host_net_lock(host);
  n = pnet_ws_buffered_amount(host->net, handle);
  pocketjs_host_net_unlock(host);
  return JS_NewInt32(ctx, n);
}

static JSValue ws_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.poll");
  (void)argc;
  (void)argv;
  size_t len = 0;
  pocketjs_host_net_lock(host);
  /* Two-phase poll: the batch leaves the core only once the guest holds its
   * copy. If QuickJS cannot allocate the string the events stay visible and
   * are rendered again next tick instead of vanishing. */
  const char *batch = pnet_ws_poll_render(host->net, &len);
  JSValue out = batch ? JS_NewStringLen(ctx, batch, len) : JS_UNDEFINED;
  if (batch && !JS_IsException(out)) pnet_ws_poll_consume(host->net);
  pocketjs_host_net_unlock(host);
  return out;
}

static JSValue ws_last_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.lastError");
  (void)argc;
  (void)argv;
  pocketjs_host_net_lock(host);
  JSValue out = JS_NewString(ctx, pnet_ws_last_error(host->net));
  pocketjs_host_net_unlock(host);
  return out;
}

static JSValue ws_limits(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("ws.limits");
  (void)argc;
  (void)argv;
  return JS_NewString(ctx, pnet_ws_limits(host->net));
}

/* --- httpd -------------------------------------------------------------------- */

static JSValue httpd_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.listen");
  if (argc < 1) return JS_ThrowTypeError(ctx, "httpd.listen(meta)");
  const char *meta = JS_ToCString(ctx, argv[0]);
  if (!meta) return JS_EXCEPTION;
  int handle;
  LOCKED(handle = pnet_httpd_listen(host->net, meta));
  JS_FreeCString(ctx, meta);
  return JS_NewInt32(ctx, handle);
}

static JSValue httpd_stop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.stop");
  int32_t handle, timeout = 0;
  if (argc < 1 || !arg_i32(ctx, argv[0], &handle)) return JS_NewInt32(ctx, -1);
  bool graceful = argc >= 2 ? JS_ToBool(ctx, argv[1]) : true;
  if (argc >= 3) arg_i32(ctx, argv[2], &timeout);
  int rc;
  LOCKED(rc = pnet_httpd_stop(host->net, handle, graceful, timeout > 0 ? (uint32_t)timeout : 0));
  return JS_NewInt32(ctx, rc);
}

static JSValue httpd_respond(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.respond");
  int32_t req;
  if (argc < 2 || !arg_i32(ctx, argv[0], &req)) return JS_ThrowTypeError(ctx, "httpd.respond(req, meta, body)");
  const char *meta = JS_ToCString(ctx, argv[1]);
  if (!meta) return JS_EXCEPTION;
  uint8_t *body = NULL;
  size_t body_len = 0;
  if (argc >= 3 && !arg_buffer(ctx, argv[2], &body, &body_len)) {
    JS_FreeCString(ctx, meta);
    return JS_EXCEPTION;
  }
  int rc;
  LOCKED(rc = pnet_httpd_respond(host->net, req, meta, body, body_len));
  JS_FreeCString(ctx, meta);
  return JS_NewInt32(ctx, rc);
}

static JSValue httpd_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.write");
  int32_t req;
  uint8_t *chunk;
  size_t len;
  if (argc < 2 || !arg_i32(ctx, argv[0], &req) || !arg_buffer(ctx, argv[1], &chunk, &len)) {
    return JS_ThrowTypeError(ctx, "httpd.write(req, chunk)");
  }
  int rc;
  LOCKED(rc = pnet_httpd_write(host->net, req, chunk, len));
  return JS_NewInt32(ctx, rc);
}

static JSValue httpd_end_body(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.endBody");
  int32_t req;
  if (argc < 1 || !arg_i32(ctx, argv[0], &req)) return JS_NewInt32(ctx, -1);
  int rc;
  LOCKED(rc = pnet_httpd_end_body(host->net, req));
  return JS_NewInt32(ctx, rc);
}

static JSValue httpd_read_into(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.readInto");
  int32_t req;
  uint8_t *ptr;
  size_t len;
  if (argc < 4 || !arg_i32(ctx, argv[0], &req) || !arg_window(ctx, argv[1], argv[2], argv[3], &ptr, &len)) {
    return JS_ThrowRangeError(ctx, "httpd.readInto(req, buffer, offset, length)");
  }
  int n;
  LOCKED(n = pnet_httpd_read_into(host->net, req, ptr, len));
  return JS_NewInt32(ctx, n);
}

static JSValue httpd_abort(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.abort");
  int32_t req;
  if (argc < 1 || !arg_i32(ctx, argv[0], &req)) return JS_UNDEFINED;
  LOCKED(pnet_httpd_abort(host->net, req));
  return JS_UNDEFINED;
}

static JSValue httpd_poll(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.poll");
  (void)argc;
  (void)argv;
  size_t len = 0;
  pocketjs_host_net_lock(host);
  /* Two-phase poll: the batch leaves the core only once the guest holds its
   * copy. If QuickJS cannot allocate the string the events stay visible and
   * are rendered again next tick instead of vanishing. */
  const char *batch = pnet_httpd_poll_render(host->net, &len);
  JSValue out = batch ? JS_NewStringLen(ctx, batch, len) : JS_UNDEFINED;
  if (batch && !JS_IsException(out)) pnet_httpd_poll_consume(host->net);
  pocketjs_host_net_unlock(host);
  return out;
}

static JSValue httpd_last_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.lastError");
  (void)argc;
  (void)argv;
  pocketjs_host_net_lock(host);
  JSValue out = JS_NewString(ctx, pnet_httpd_last_error(host->net));
  pocketjs_host_net_unlock(host);
  return out;
}

static JSValue httpd_limits(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  WITH_HOST("httpd.limits");
  (void)argc;
  (void)argv;
  return JS_NewString(ctx, pnet_httpd_limits(host->net));
}

/* --- mount -------------------------------------------------------------------- */

typedef struct op_entry {
  const char *name;
  JSCFunction *fn;
  int length;
} op_entry;

static void mount_namespace(JSContext *ctx, JSValueConst global, const char *name, const op_entry *ops, size_t count) {
  JSValue ns = JS_NewObject(ctx);
  for (size_t i = 0; i < count; i++) {
    JS_SetPropertyStr(ctx, ns, ops[i].name, JS_NewCFunction(ctx, ops[i].fn, ops[i].name, ops[i].length));
  }
  JS_SetPropertyStr(ctx, global, name, ns);
}

void pocketjs_host_mount_network(pocketjs_esp_host_t *host) {
  JSContext *ctx = host->ctx;
  JS_SetRuntimeOpaque(host->rt, host);
  static const op_entry NET_OPS[] = {
      {"start", net_start, 2},        {"cancel", net_cancel, 1}, {"poll", net_poll, 0},
      {"lastError", net_last_error, 0}, {"readInto", net_read_into, 4}, {"limits", net_limits, 0},
  };
  static const op_entry WS_OPS[] = {
      {"connect", ws_connect, 1},   {"send", ws_send, 3},           {"receiveInto", ws_receive_into, 4},
      {"close", ws_close, 3},       {"terminate", ws_terminate, 1}, {"bufferedAmount", ws_buffered_amount, 1},
      {"poll", ws_poll, 0},         {"lastError", ws_last_error, 0}, {"limits", ws_limits, 0},
  };
  static const op_entry HTTPD_OPS[] = {
      {"listen", httpd_listen, 1},   {"stop", httpd_stop, 3},        {"respond", httpd_respond, 3},
      {"write", httpd_write, 2},     {"endBody", httpd_end_body, 1}, {"readInto", httpd_read_into, 4},
      {"abort", httpd_abort, 1},     {"poll", httpd_poll, 0},        {"lastError", httpd_last_error, 0},
      {"limits", httpd_limits, 0},
  };
  JSValue global = JS_GetGlobalObject(ctx);
  mount_namespace(ctx, global, "net", NET_OPS, sizeof NET_OPS / sizeof NET_OPS[0]);
  if (host->cfg.mount_websocket_client) mount_namespace(ctx, global, "ws", WS_OPS, sizeof WS_OPS / sizeof WS_OPS[0]);
  if (host->cfg.mount_http_server) mount_namespace(ctx, global, "httpd", HTTPD_OPS, sizeof HTTPD_OPS / sizeof HTTPD_OPS[0]);
  JS_FreeValue(ctx, global);
}
