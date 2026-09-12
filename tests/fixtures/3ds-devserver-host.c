/* Host process for the Nintendo 3DS Pocket Runtime pump (hosts/3ds/src/
 * devserver.c) with libctru stubbed out (tests/fixtures/3ds-stubs): the same
 * socket code that runs on the console, driven by the desktop client. The
 * runtime paths are the console's literal `sdmc:` paths, resolved relative to
 * the scratch directory this process starts in. */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "devserver.h"

/* soc.c owns the console's socket service; on the host there is none. */
bool soc_ensure(char *error, size_t error_length) {
  (void)error;
  (void)error_length;
  return true;
}
bool soc_active(void) { return true; }
void soc_shutdown(void) {}

static volatile sig_atomic_t stopped;
static PocketRuntimeState state = {1, 0x1122334455667788ULL, 0};
static uint32_t frame;

static void stop_signal(int signal_number) {
  (void)signal_number;
  stopped = 1;
}

static void admit_upload(void) {
  uint64_t declared = 0;
  if (!devserver_take_upload(&declared)) return;
  FILE *file = fopen(POCKET_RUNTIME_UPLOAD, "rb");
  uint64_t footer = 0;
  long size = 0;
  if (file != NULL && fseek(file, 0, SEEK_END) == 0) {
    size = ftell(file);
    if (size >= 8 && fseek(file, size - 8, SEEK_SET) == 0) {
      uint8_t bytes[8];
      if (fread(bytes, 1, 8, file) == 8) memcpy(&footer, bytes, 8);
    }
  }
  if (file != NULL) fclose(file);
  remove(POCKET_RUNTIME_UPLOAD);
  if (footer != 0 && footer == declared) {
    state.generation += 1;
    state.active_hash = declared;
    devserver_set_runtime(&state, NULL, "accepted", frame);
    devserver_report_install("accepted", declared, "footer verified");
  } else {
    devserver_report_install("rejected", declared, "footer mismatch");
  }
}

static void handle_controls(void) {
  char lines[4096];
  size_t length = devserver_recv_ctrl(lines, sizeof lines);
  char *cursor = lines;
  while (length > 0) {
    char *end = strchr(cursor, '\n');
    if (end == NULL) break;
    *end = '\0';
    if (strstr(cursor, "\"screenshot\"") != NULL) {
      devserver_request_screenshot();
    } else {
      char reply[4200];
      int written = snprintf(reply, sizeof reply, "{\"t\":\"echo\",\"length\":%lu}", (unsigned long)(end - cursor));
      if (written > 0) devserver_send_ctrl(reply, (size_t)written);
    }
    length -= (size_t)(end - cursor) + 1;
    cursor = end + 1;
  }
}

static void serve_screenshot(void) {
  if (!devserver_take_screenshot_request()) return;
  uint8_t *top = NULL;
  uint8_t *auxiliary = NULL;
  if (!devserver_screenshot_begin(frame, 400, 240, 320, 240, &top, &auxiliary)) {
    devserver_report_log("error", "screenshot: buffer allocation failed");
    return;
  }
  for (size_t index = 0; index < 400u * 240u * 3u; index += 1) top[index] = (uint8_t)index;
  for (size_t index = 0; index < 320u * 240u * 3u; index += 1) auxiliary[index] = (uint8_t)(255 - (index & 0xff));
  devserver_screenshot_ready();
}

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (chdir(argv[1]) != 0) return 2;
  signal(SIGTERM, stop_signal);
  signal(SIGINT, stop_signal);
  signal(SIGPIPE, SIG_IGN);
  char error[256] = {0};
  DevserverInitResult result = devserver_init(&state, error, sizeof error);
  if (result != DEVSERVER_READY) {
    fprintf(stderr, "devserver_init: %d %s\n", (int)result, error);
    return 3;
  }
  devserver_set_runtime(&state, NULL, "booted", 0);
  puts("3ds devserver ready");
  fflush(stdout);
  while (!stopped) {
    devserver_poll();
    frame += 1;
    admit_upload();
    handle_controls();
    serve_screenshot();
    usleep(2000);
  }
  devserver_shutdown();
  return 0;
}
