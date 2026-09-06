#include "pocketjs/package.h"
#include <stddef.h>
#include <stdint.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  for (unsigned flags = 0; flags <= 1; ++flags) {
    pocketjs_package_t *package = NULL;
    if (pocketjs_package_open(data, size, flags, &package) != ESP_OK)
      continue;
    pocketjs_package_host_contract_t contract = {
        .struct_size = sizeof(contract),
        .target_id = "psp",
        .host_abi = 1,
    };
    pocketjs_package_variant_t variant = {.struct_size = sizeof(variant)};
    (void)pocketjs_package_select(package, &contract, &variant);
    pocketjs_package_close(package);
  }
  return 0;
}
