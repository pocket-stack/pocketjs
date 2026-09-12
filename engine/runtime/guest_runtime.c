/* Frame-confirmed guest replacement. Files are written before the native
 * host releases the current realm. Only a successful presentation commits a
 * generation; boot/frame failures walk active, last-good, embedded recovery. */
#include "guest_runtime.h"
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef POCKETJS_TARGET_ID
#error "POCKETJS_TARGET_ID must come from the build plan"
#endif
#ifndef POCKETJS_HOST_ABI
#error "POCKETJS_HOST_ABI must come from the build plan"
#endif

typedef struct {
  uint8_t *bytes;
  PocketGuestPackage guest;
} LoadedPackage;

static PocketDevHost host;
static PocketGuestPackage embedded;
static LoadedPackage *current;
static char root_path[POCKET_DEV_PATH_BYTES - 128];
static char phase[24] = "starting", last_error[512];
static uint32_t generation, frames;
static uint64_t active_hash, last_good_hash, running_hash, requested_hash;
static uint64_t rejected[3];
static size_t rejected_count;
static int initialized, running, awaiting_frame, failure_pending;

static void error_text(const char *text) {
  if (text == last_error) return;
  snprintf(last_error, sizeof last_error, "%s", text ? text : "guest failure");
}
static void path(char out[POCKET_DEV_PATH_BYTES], const char *suffix) {
  snprintf(out, POCKET_DEV_PATH_BYTES, "%s/%s", root_path, suffix);
}
static void blob_path(char out[POCKET_DEV_PATH_BYTES], uint64_t hash) {
  snprintf(out, POCKET_DEV_PATH_BYTES, "%s/packages/%016llx.pocket", root_path, (unsigned long long)hash);
}
static int mkdir_checked(const char *directory) {
  struct stat info;
  if (!mkdir(directory, 0700)) return 1;
  return errno == EEXIST && !stat(directory, &info) && S_ISDIR(info.st_mode);
}
static int was_rejected(uint64_t hash) {
  for (size_t i = 0; i < rejected_count; ++i) if (rejected[i] == hash) return 1;
  return 0;
}
static void reject_hash(uint64_t hash) {
  if (hash && !was_rejected(hash) && rejected_count < 3) rejected[rejected_count++] = hash;
}
static void release(LoadedPackage *package) {
  if (!package) return;
  free(package->bytes);
  free(package);
}
static void stop_guest(void) {
  host.stop();
  release(current);
  current = NULL;
  running = awaiting_frame = 0;
  pocket_devserver_reset_guest();
}
static LoadedPackage *load_package(const char *filename, uint64_t expected) {
  FILE *file = fopen(filename, "rb");
  if (!file) { error_text("cannot open stored package"); return NULL; }
  long size = -1;
  if (!fseek(file, 0, SEEK_END)) size = ftell(file);
  if (size < 24 || (unsigned long)size > POCKET_DEV_SERVER_MAX_PACKAGE_BYTES || fseek(file, 0, SEEK_SET)) {
    fclose(file); error_text("invalid package file size"); return NULL;
  }
  LoadedPackage *package = calloc(1, sizeof *package);
  if (package) package->bytes = malloc((size_t)size);
  if (!package || !package->bytes) {
    release(package); fclose(file); error_text("package allocation failed"); return NULL;
  }
  int ok = fread(package->bytes, 1, (size_t)size, file) == (size_t)size;
  if (fclose(file)) ok = 0;
  if (!ok) { release(package); error_text("incomplete package read"); return NULL; }
  int result = pocket_package_open(package->bytes, (size_t)size,
    (const uint8_t *)POCKETJS_TARGET_ID, sizeof POCKETJS_TARGET_ID - 1,
    POCKETJS_HOST_ABI, &package->guest);
  if (result || !package->guest.package_hash || (expected && expected != package->guest.package_hash)) {
    snprintf(last_error, sizeof last_error, "package admission failed (code %d; expected hash checked)", result);
    release(package); return NULL;
  }
  if (!host.validate_plan(package->guest.plan, package->guest.plan_length)) {
    error_text("package plan does not match the runtime target, ABI or viewport");
    release(package); return NULL;
  }
  return package;
}
static int boot(LoadedPackage *package) {
  current = package;
  running_hash = package ? package->guest.package_hash : 0;
  frames = 0;
  failure_pending = 0;
  if (!host.boot(package ? &package->guest : &embedded)) {
    error_text(host.error());
    reject_hash(running_hash);
    stop_guest();
    return 0;
  }
  running = awaiting_frame = 1;
  snprintf(phase, sizeof phase, "%s", requested_hash ? "candidate" : "recovering");
  return 1;
}
static void recover(void) {
  const uint64_t choices[] = {active_hash, last_good_hash};
  for (size_t i = 0; i < 2; ++i) {
    if (!choices[i] || was_rejected(choices[i])) continue;
    char filename[POCKET_DEV_PATH_BYTES];
    blob_path(filename, choices[i]);
    LoadedPackage *package = load_package(filename, choices[i]);
    if (package && boot(package)) return;
    reject_hash(choices[i]);
  }
  if (!boot(NULL)) {
    strcpy(phase, "failed");
    pocket_devserver_report_log("error", last_error);
  }
}
static void load_state(void) {
  char directory[POCKET_DEV_PATH_BYTES];
  path(directory, "state");
  DIR *dir = opendir(directory);
  if (!dir) return;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    unsigned int gen;
    unsigned long long active, good;
    int consumed = 0;
    if (sscanf(entry->d_name, "state-%8x-%16llx-%16llx.commit%n", &gen, &active, &good, &consumed) != 3 ||
        consumed != 55 || entry->d_name[consumed] || gen <= generation) continue;
    char filename[POCKET_DEV_PATH_BYTES], marker[10] = {0};
    snprintf(filename, sizeof filename, "%s/state/%.55s", root_path, entry->d_name);
    FILE *file = fopen(filename, "rb");
    if (!file) continue;
    size_t length = fread(marker, 1, sizeof marker, file);
    fclose(file);
    if (length != 9 || memcmp(marker, "accepted\n", 9)) continue;
    generation = gen;
    active_hash = (uint64_t)active;
    last_good_hash = (uint64_t)good;
  }
  closedir(dir);
}
static void collect_old_files(void) {
  char directory[POCKET_DEV_PATH_BYTES];
  path(directory, "packages");
  DIR *dir = opendir(directory);
  if (dir) {
    struct dirent *entry;
    while ((entry = readdir(dir))) {
      unsigned long long hash;
      int consumed = 0;
      if (sscanf(entry->d_name, "%16llx.pocket%n", &hash, &consumed) != 1 ||
          consumed != 23 || entry->d_name[consumed] || hash == active_hash || hash == last_good_hash) continue;
      char filename[POCKET_DEV_PATH_BYTES];
      blob_path(filename, (uint64_t)hash);
      remove(filename);
    }
    closedir(dir);
  }
  path(directory, "state");
  dir = opendir(directory);
  if (!dir) return;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    unsigned int gen;
    unsigned long long active, good;
    int consumed = 0;
    if (sscanf(entry->d_name, "state-%8x-%16llx-%16llx.commit%n", &gen, &active, &good, &consumed) != 3 ||
        consumed != 55 || entry->d_name[consumed] || gen >= generation - 1) continue;
    char filename[POCKET_DEV_PATH_BYTES];
    snprintf(filename, sizeof filename, "%s/state/%.55s", root_path, entry->d_name);
    remove(filename);
  }
  closedir(dir);
}
static int commit(uint64_t active, uint64_t good) {
  if (generation == UINT32_MAX) { error_text("runtime generation exhausted"); return 0; }
  char temporary[POCKET_DEV_PATH_BYTES], destination[POCKET_DEV_PATH_BYTES];
  path(temporary, "state/state.tmp");
  snprintf(destination, sizeof destination, "%s/state/state-%08x-%016llx-%016llx.commit",
    root_path, generation + 1, (unsigned long long)active, (unsigned long long)good);
  FILE *file = fopen(temporary, "wb");
  if (!file) { error_text("cannot write runtime generation"); return 0; }
  int ok = fputs("accepted\n", file) >= 0 && fflush(file) == 0 && fsync(fileno(file)) == 0;
  if (fclose(file)) ok = 0;
  if (!ok || rename(temporary, destination)) {
    remove(temporary); error_text("cannot commit runtime generation"); return 0;
  }
  ++generation;
  active_hash = active;
  last_good_hash = good;
  pocket_devserver_set_state(generation, active_hash);
  collect_old_files();
  return 1;
}
void pocket_dev_runtime_status(char *out, size_t length) {
  snprintf(out, length,
    "{\"t\":\"runtime.status\",\"target\":\"%s\",\"hostAbi\":%u,\"phase\":\"%s\","
    "\"generation\":%u,\"active\":\"%016llx\",\"lastGood\":\"%016llx\",\"running\":\"%016llx\","
    "\"frame\":%u,\"transport\":\"%s\"}", POCKETJS_TARGET_ID, (unsigned)POCKETJS_HOST_ABI, phase,
    generation, (unsigned long long)active_hash, (unsigned long long)last_good_hash,
    (unsigned long long)running_hash, frames, pocket_devwire_state_name());
}
int pocket_dev_runtime_init(const char *root, const PocketDevHost *callbacks,
  const PocketGuestPackage *recovery, uint16_t port) {
  if (initialized || !root || strlen(root) >= sizeof root_path || !callbacks || !recovery ||
      !callbacks->boot || !callbacks->stop || !callbacks->validate_plan || !callbacks->error ||
      !callbacks->label) return 0;
  host = *callbacks;
  embedded = *recovery;
  strcpy(root_path, root);
  generation = frames = 0;
  active_hash = last_good_hash = running_hash = requested_hash = 0;
  rejected_count = 0;
  failure_pending = 0;
  char directory[POCKET_DEV_PATH_BYTES];
  if (!mkdir_checked(root_path)) return 0;
  path(directory, "packages");
  if (!mkdir_checked(directory)) return 0;
  path(directory, "state");
  if (!mkdir_checked(directory)) return 0;
  load_state();
  const PocketDevWireOptions wire = {root_path, POCKETJS_TARGET_ID, host.label,
    POCKETJS_HOST_ABI, port, pocket_dev_runtime_status};
  if (!pocket_devwire_init(&wire)) return 0;
  remove(pocket_devserver_upload_path());
  pocket_devserver_set_state(generation, active_hash);
  initialized = 1;
  recover();
  return 1;
}
void pocket_dev_runtime_failed(const char *message) {
  if (!initialized || !running) return;
  error_text(message);
  failure_pending = 1;
}
int pocket_dev_runtime_running(void) { return running && !failure_pending; }
void pocket_dev_runtime_pump(void) {
  if (!initialized) return;
  if (failure_pending) {
    failure_pending = 0;
    pocket_devserver_report_log("error", last_error);
    if (requested_hash) pocket_devserver_report_install("rejected", requested_hash, last_error);
    requested_hash = 0;
    reject_hash(running_hash);
    int embedded_failed = running_hash == 0;
    stop_guest();
    if (embedded_failed) strcpy(phase, "failed");
    else recover();
  }
  pocket_devwire_pump();
  if (awaiting_frame && running) return;
  uint64_t hash;
  if (!pocket_devserver_take_upload(&hash)) return;
  LoadedPackage *candidate = load_package(pocket_devserver_upload_path(), hash);
  if (!candidate) {
    pocket_devserver_report_install("rejected", hash, last_error);
    remove(pocket_devserver_upload_path());
    return;
  }
  char destination[POCKET_DEV_PATH_BYTES];
  blob_path(destination, hash);
  if (rename(pocket_devserver_upload_path(), destination)) {
    release(candidate);
    pocket_devserver_report_install("rejected", hash, "cannot store admitted package");
    remove(pocket_devserver_upload_path());
    return;
  }
  stop_guest();
  rejected_count = 0;
  requested_hash = hash;
  if (boot(candidate)) {
    pocket_devserver_report_install("staged", hash, "guest booted; waiting for presentation");
  } else {
    pocket_devserver_report_install("rejected", hash, last_error);
    requested_hash = 0;
    recover();
  }
}
void pocket_dev_runtime_presented(void) {
  if (!running || failure_pending) return;
  ++frames;
  if (!awaiting_frame) return;
  uint64_t good = active_hash;
  if (good == running_hash || was_rejected(good)) good = last_good_hash;
  if (good == running_hash || was_rejected(good)) good = 0;
  if (running_hash != active_hash || good != last_good_hash) {
    if (!commit(running_hash, good)) {
      pocket_dev_runtime_failed(last_error);
      return;
    }
  }
  awaiting_frame = 0;
  rejected_count = 0;
  strcpy(phase, "accepted");
  if (requested_hash) pocket_devserver_report_install("accepted", requested_hash, "first frame presented");
  requested_hash = 0;
}
void pocket_dev_runtime_shutdown(void) {
  if (initialized) stop_guest();
  pocket_devwire_shutdown();
  initialized = 0;
}
