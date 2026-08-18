// SPDX-License-Identifier: MIT

#include "formal_tls_smoke_ipv4.h"

#include <string.h>

bool pocketjs_net_formal_tls_smoke_canonical_peer_ipv4(
    const char *text, ip4_addr_t *out_address) {
  ip4_addr_t address = {0};
  char canonical[16] = {0};
  if (text == NULL || !ip4addr_aton(text, &address) ||
      address.addr == IPADDR_ANY ||
      ip4addr_ntoa_r(&address, canonical, sizeof(canonical)) == NULL ||
      strcmp(text, canonical) != 0) {
    return false;
  }
  if (out_address != NULL) {
    *out_address = address;
  }
  return true;
}
