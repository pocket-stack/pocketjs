// SPDX-License-Identifier: MIT

#include <arpa/inet.h>
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "formal_tls_smoke_ipv4.h"

int ip4addr_aton(const char *text, ip4_addr_t *address) {
  struct in_addr parsed = {0};
  if (text == NULL || address == NULL || inet_aton(text, &parsed) == 0) {
    return 0;
  }
  address->addr = parsed.s_addr;
  return 1;
}

char *ip4addr_ntoa_r(const ip4_addr_t *address, char *buffer, int length) {
  if (address == NULL || buffer == NULL || length <= 0) {
    return NULL;
  }
  const struct in_addr source = {.s_addr = address->addr};
  return (char *)inet_ntop(AF_INET, &source, buffer, (socklen_t)length);
}

int main(void) {
  static const char *const valid[] = {
      "127.0.0.1",
      "192.0.2.1",
      "255.255.255.255",
  };
  for (size_t index = 0U; index < sizeof(valid) / sizeof(valid[0]); ++index) {
    ip4_addr_t address = {0};
    assert(pocketjs_net_formal_tls_smoke_canonical_peer_ipv4(valid[index],
                                                             &address));
    assert(address.addr != IPADDR_ANY);
  }

  static const char *const invalid[] = {
      "",           "0",           "0.0.0.0",    "0177.0.0.1",
      "0x7f000001", "192.000.2.1", "192.0.2.1.", "192.0.2",
  };
  for (size_t index = 0U; index < sizeof(invalid) / sizeof(invalid[0]);
       ++index) {
    ip4_addr_t address = {.addr = UINT32_C(0x12345678)};
    assert(!pocketjs_net_formal_tls_smoke_canonical_peer_ipv4(invalid[index],
                                                              &address));
    assert(address.addr == UINT32_C(0x12345678));
  }
  assert(!pocketjs_net_formal_tls_smoke_canonical_peer_ipv4(NULL, NULL));
  return 0;
}
