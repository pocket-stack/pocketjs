// SPDX-License-Identifier: MIT

#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint32_t addr;
} ip4_addr_t;

#define IPADDR_ANY UINT32_C(0)

int ip4addr_aton(const char *text, ip4_addr_t *address);
char *ip4addr_ntoa_r(const ip4_addr_t *address, char *buffer, int length);
