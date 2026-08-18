// SPDX-License-Identifier: MIT

#pragma once

#include "quickjs.h"

typedef struct pocketjs_esp_guest pocketjs_esp_guest_t;

JSContext *pocketjs_esp_guest_context(pocketjs_esp_guest_t *guest);
