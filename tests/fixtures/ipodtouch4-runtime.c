#include "guest_runtime.h"
#include "pocket_runtime.h"
#include "pocket_target_contract.h"
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static volatile sig_atomic_t stopped;
/* The host Rust archive uses aborting panics, as the native allocator probe. */
void rust_eh_personality(void) { abort(); }
static void stop_signal(int signal_number) { (void)signal_number; stopped = 1; }
static int boot(const PocketGuestPackage *guest) {
  return pocket_runtime_boot((const char *)guest->javascript, guest->javascript_length - 1,
    guest->pak, guest->pak_length, 320, 480);
}
static int validate(const uint8_t *bytes, size_t length) {
  return pocket_package_validate_plan(bytes, length, &POCKET_TARGET_CONTRACT) == 0;
}
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  signal(SIGTERM, stop_signal);
  signal(SIGINT, stop_signal);
  static const uint8_t javascript[] = "globalThis.frame = function() {};";
  static const uint8_t pak[] = {0};
  const PocketGuestPackage recovery = {javascript, sizeof javascript, pak, sizeof pak, NULL, 0, 0, 0};
  const PocketDevHost host = {boot, pocket_runtime_shutdown, validate, pocket_runtime_error, "Pocket Harness"};
  if (!pocket_dev_runtime_init(argv[1], &host, &recovery, (uint16_t)atoi(argv[2]))) return 3;
  puts("runtime harness ready");
  fflush(stdout);
  while (!stopped) {
    pocket_dev_runtime_pump();
    if (pocket_dev_runtime_running()) {
      PocketRuntimeContactsInput input = {0};
      if (!pocket_runtime_tick_contacts(&input) || !pocket_runtime_render())
        pocket_dev_runtime_failed(pocket_runtime_error());
      else pocket_dev_runtime_presented();
    }
    usleep(5000);
  }
  pocket_dev_runtime_shutdown();
  return 0;
}
