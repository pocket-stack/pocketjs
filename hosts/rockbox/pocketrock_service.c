#include "firmware_compat.h"
#include "quickjs.h"

/* The firmware adapter owns the returned string until the next call. */
extern const char *pocketrock_service_call(
  const char *service, const char *method, const char *payload
);

JSValue pocket_runtime_pocketrock_call(
  JSContext *ctx,
  JSValueConst this_value,
  int argc,
  JSValueConst *argv
) {
  const char *service = 0, *method = 0, *payload = 0, *response;
  (void)this_value;
  if (argc < 3)
    return JS_ThrowTypeError(ctx, "pocketrockCall requires service, method and payload");
  service = JS_ToCString(ctx, argv[0]);
  method = JS_ToCString(ctx, argv[1]);
  payload = JS_ToCString(ctx, argv[2]);
  if (!service || !method || !payload) {
    if (service) JS_FreeCString(ctx, service);
    if (method) JS_FreeCString(ctx, method);
    if (payload) JS_FreeCString(ctx, payload);
    return JS_EXCEPTION;
  }
  response = pocketrock_service_call(service, method, payload);
  JSValue result = JS_NewString(ctx, response ? response :
    "{\"error\":{\"code\":\"host.failure\",\"message\":\"empty response\"}}");
  JS_FreeCString(ctx, payload);
  JS_FreeCString(ctx, method);
  JS_FreeCString(ctx, service);
  return result;
}
