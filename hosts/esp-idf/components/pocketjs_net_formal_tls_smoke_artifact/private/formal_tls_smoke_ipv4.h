// SPDX-License-Identifier: MIT

#pragma once

#include <stdbool.h>

#include "lwip/ip4_addr.h"

bool pocketjs_net_formal_tls_smoke_canonical_peer_ipv4(const char *text,
                                                       ip4_addr_t *out_address);
