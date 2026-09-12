/* Host process for the POSIX Pocket Runtime transport (engine/runtime/
 * dev_wire_posix.c) without a guest: control records are echoed and an
 * upload is admitted by its footer alone, so the desktop client can drive
 * the same scenario it drives against the 3DS pump. */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "dev_wire_posix.h"

static volatile sig_atomic_t stopped;
static uint32_t generation = 1;
static uint64_t active = 0x1122334455667788ULL;

static void stop_signal(int signal_number) {
  (void)signal_number;
  stopped = 1;
}

static void status(char *out, size_t capacity) {
  snprintf(out, capacity,
    "{\"t\":\"runtime.status\",\"target\":\"host-dev\",\"hostAbi\":8,\"phase\":\"test\","
    "\"generation\":%lu,\"active\":\"%016llx\",\"transport\":\"%s\"}",
    (unsigned long)generation, (unsigned long long)active, pocket_devwire_state_name());
}

static void admit_upload(void) {
  uint64_t declared = 0;
  if (!pocket_devserver_take_upload(&declared)) return;
  const char *path = pocket_devserver_upload_path();
  FILE *file = fopen(path, "rb");
  uint64_t footer = 0;
  long size = 0;
  if (file != NULL && fseek(file, 0, SEEK_END) == 0) {
    size = ftell(file);
    if (size >= 8 && fseek(file, size - 8, SEEK_SET) == 0) {
      uint8_t bytes[8];
      if (fread(bytes, 1, 8, file) == 8) footer = pocket_runtime_read_u64(bytes);
    }
  }
  if (file != NULL) fclose(file);
  remove(path);
  if (footer != 0 && footer == declared) {
    generation += 1;
    active = declared;
    pocket_devserver_set_state(generation, active);
    pocket_devserver_report_install("accepted", declared, "footer verified");
  } else {
    pocket_devserver_report_install("rejected", declared, "footer mismatch");
  }
}

static void echo_controls(void) {
  char lines[4096];
  size_t length = pocket_devserver_recv_ctrl(lines, sizeof lines);
  char *cursor = lines;
  while (length > 0) {
    char *end = strchr(cursor, '\n');
    if (end == NULL) break;
    *end = '\0';
    char reply[4200];
    int written = snprintf(reply, sizeof reply, "{\"t\":\"echo\",\"length\":%lu}", (unsigned long)(end - cursor));
    if (written > 0) pocket_devserver_send_ctrl(reply, (size_t)written);
    length -= (size_t)(end - cursor) + 1;
    cursor = end + 1;
  }
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  signal(SIGTERM, stop_signal);
  signal(SIGINT, stop_signal);
  signal(SIGPIPE, SIG_IGN);
  const PocketDevWireOptions options = {argv[1], "host-dev", "PocketJS Host", 8, (uint16_t)atoi(argv[2]), status};
  if (!pocket_devwire_init(&options)) return 3;
  pocket_devserver_set_state(generation, active);
  puts("posix wire ready");
  fflush(stdout);
  while (!stopped) {
    pocket_devwire_pump();
    admit_upload();
    echo_controls();
    usleep(2000);
  }
  pocket_devwire_shutdown();
  return 0;
}
