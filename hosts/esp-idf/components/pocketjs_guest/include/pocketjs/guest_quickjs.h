#pragma once

#include "pocketjs/guest.h"
#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Version-pinned escape hatch used by native surface components. */
typedef esp_err_t (*pocketjs_guest_quickjs_install_fn)(JSContext *context,
                                                       void *user_data);

esp_err_t
pocketjs_guest_quickjs_install(pocketjs_guest_t *guest,
                               pocketjs_guest_quickjs_install_fn install,
                               void *user_data);

/** Install a named surface once per realm. Names are copied. A failed
 * installer releases its reservation. Neither context nor runtime opaque
 * slots are used by this registry. */
esp_err_t
pocketjs_guest_quickjs_install_once(pocketjs_guest_t *guest, const char *name,
                                    pocketjs_guest_quickjs_install_fn install,
                                    void *user_data);

/** Valid only for the duration of a synchronous owner-task operation. */
JSContext *pocketjs_guest_quickjs_context(pocketjs_guest_t *guest);

#ifdef __cplusplus
}
#endif
