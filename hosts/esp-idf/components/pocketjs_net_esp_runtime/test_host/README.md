# Host tests

`runtime_contract_test.c` checks the pure handle, sequence, feature projection,
and reserved redirect rules. `runtime_fake_test.c` links the production runtime
against bounded fake Core and transport implementations and checks pre-I/O
refusal, slot generations, upload credit, response leases, permission phases,
stats, and three-stage shutdown. Hostile cases cover dispatcher failure poison,
Guest-independent native shutdown cleanup, taken and released lease retirement
failures, delayed transport quiescence, and rejection of new work after
shutdown starts. It also checks that native-work and transport-completion pump
budgets can be supplied independently without poisoning the runtime. A
readiness probe covers healthy drained, pending, and poisoned-Core states
without taking an event. Lease reads reject a larger destination window and a
range past the lease end before accepting the exact formal window. A
close-completion poison case retains Core ownership until phase 2 destroys the
dedicated transport. It injects one failed confirmation and rejects all other
Core calls while the transport context is detached, then confirms on the next
turn. A persistent Host terminal-retirement failure is abandoned only through
the poisoned exact-sequence path, after which shutdown reaches the
ready-to-destroy phase without destroying the transport again in phase 3.

Run both with Clang sanitizers from the repository root:

```sh
clang -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer \
  -Ihosts/esp-idf/components/pocketjs_net_esp_runtime/private \
  -Icontracts/spec/network/generated \
  hosts/esp-idf/components/pocketjs_net_esp_runtime/src/runtime_contract.c \
  hosts/esp-idf/components/pocketjs_net_esp_runtime/test_host/runtime_contract_test.c \
  -o /tmp/pocketjs-net-esp-runtime-contract-test
/tmp/pocketjs-net-esp-runtime-contract-test

clang -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -fno-omit-frame-pointer \
  -Ihosts/esp-idf/components/pocketjs_net_esp_runtime/test_host/fake_include \
  -Ihosts/esp-idf/components/pocketjs_net_esp_runtime/include \
  -Ihosts/esp-idf/components/pocketjs_net_esp_runtime/private \
  -Ihosts/esp-idf/components/pocketjs_net_http_client_core/include \
  -Ihosts/esp-idf/components/pocketjs_net_esp_transport/include \
  -Icontracts/spec/network/generated \
  hosts/esp-idf/components/pocketjs_net_esp_runtime/src/esp_runtime.c \
  hosts/esp-idf/components/pocketjs_net_esp_runtime/src/runtime_contract.c \
  hosts/esp-idf/components/pocketjs_net_esp_runtime/test_host/runtime_fake_test.c \
  -o /tmp/pocketjs-net-esp-runtime-fake-test
/tmp/pocketjs-net-esp-runtime-fake-test
```
