/* UI facade for the native development worker. All shared payloads have one
 * producer and one consumer; release/acquire transfers ownership. No UI call
 * waits for a lock, a socket, SD, hashing, or generation-marker persistence. */
#include "devserver.h"
#include "dev_transport.h"
#include "dev_protocol.h"
#include <3ds.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define QUEUE_SLOTS 4u
#define IN_BYTES (POCKET_RUNTIME_MAX_CTRL_BYTES + 2u)
#define OUT_BYTES POCKET_RUNTIME_MAX_FRAME_BYTES

typedef struct { unsigned epoch; size_t length; char bytes[IN_BYTES]; } Input;
typedef struct {
  unsigned epoch, kind;
  size_t length;
  uint64_t hash;
  char label[32], bytes[OUT_BYTES];
} Output;
static Input inputs[QUEUE_SLOTS];
static Output outputs[QUEUE_SLOTS];
static atomic_uint in_read, in_write, out_read, out_write, epoch;

typedef struct {
  uint64_t hash, variant;
  uint32_t frame, commands, vertices, dropped;
  char phase[32];
} Facts;
static Facts ui_facts, shared_facts;
static atomic_bool facts_ready;
typedef struct { DevserverSnapshot info; char stats[768]; } Snapshot;
static Snapshot snapshot, shared_snapshot;
static atomic_bool snapshot_ready;

/* The worker never dereferences a package after OFFER -> HELD. */
enum { TX_IDLE, TX_OFFER, TX_HELD, TX_ACCEPT, TX_REJECT, TX_OK, TX_ERROR };
static atomic_int transaction;
static PocketRuntimePackage *candidate;
static char rejection[256];
static atomic_bool reload_requested;
static struct { uint64_t hash; char error[256]; } recoveries[QUEUE_SLOTS];
static atomic_uint recovery_read, recovery_write;

/* GPU allocation is UI-owned, borrowed by transport from READY until DONE. */
enum { SHOT_IDLE, SHOT_REQUEST, SHOT_CAPTURE, SHOT_READY, SHOT_SEND, SHOT_DONE };
static atomic_int shot;
static atomic_bool shot_requested;
static struct { uint8_t *top, *aux; uint32_t frame; uint16_t tw, th, aw, ah; } capture;
static Thread worker;
static atomic_bool stopping;
static const PocketRuntimePackage *recovery_package;

static Output *output_slot(unsigned kind) {
  unsigned w = atomic_load_explicit(&out_write, memory_order_relaxed);
  if (w - atomic_load_explicit(&out_read, memory_order_acquire) == QUEUE_SLOTS) return NULL;
  Output *slot = &outputs[w % QUEUE_SLOTS];
  slot->kind = kind;
  slot->epoch = atomic_load_explicit(&epoch, memory_order_relaxed);
  return slot;
}
static void output_publish(void) { atomic_fetch_add_explicit(&out_write, 1, memory_order_release); }
void devserver_send_ctrl(const char *line, size_t length) {
  if (!line || !length || length > OUT_BYTES) return;
  Output *slot = output_slot(0);
  if (!slot) return;
  memcpy(slot->bytes, line, length); slot->length = length; output_publish();
}
void devserver_report_install(const char *phase, uint64_t hash, const char *message) {
  Output *slot = output_slot(1);
  if (!slot) return;
  slot->hash = hash;
  snprintf(slot->label, sizeof slot->label, "%s", phase);
  snprintf(slot->bytes, 512, "%s", message); output_publish();
}
void devserver_report_log(const char *level, const char *message) {
  Output *slot = output_slot(2);
  if (!slot) return;
  snprintf(slot->label, sizeof slot->label, "%s", level);
  snprintf(slot->bytes, 512, "%s", message); output_publish();
}
size_t devserver_recv_ctrl(char *out, size_t capacity) {
  unsigned r = atomic_load_explicit(&in_read, memory_order_relaxed);
  unsigned w = atomic_load_explicit(&in_write, memory_order_acquire);
  unsigned current = atomic_load_explicit(&epoch, memory_order_relaxed);
  for (; r != w; r++) {
    Input *slot = &inputs[r % QUEUE_SLOTS];
    if (slot->epoch == current && capacity > slot->length) {
      memcpy(out, slot->bytes, slot->length + 1);
      size_t n = slot->length;
      atomic_store_explicit(&in_read, r + 1, memory_order_release); return n;
    }
    atomic_store_explicit(&in_read, r + 1, memory_order_release);
  }
  return 0;
}
void devserver_reset_guest(void) { atomic_fetch_add_explicit(&epoch, 1, memory_order_release); }
void devserver_set_frame_stats(uint32_t frame, uint32_t commands, uint32_t vertices, uint32_t dropped) {
  ui_facts.frame = frame; ui_facts.commands = commands;
  ui_facts.vertices = vertices; ui_facts.dropped = dropped;
}
void devserver_set_runtime(const PocketRuntimeState *state, const PocketRuntimePackage *package,
  const char *phase, uint32_t frame) {
  (void)state; /* The committed state belongs exclusively to the worker. */
  ui_facts.hash = package ? package->guest.package_hash : 0;
  ui_facts.variant = package ? package->guest.variant_hash : 0;
  ui_facts.frame = frame;
  snprintf(ui_facts.phase, sizeof ui_facts.phase, "%s", phase);
}
void devserver_poll(void) {
  if (!atomic_load_explicit(&facts_ready, memory_order_acquire)) {
    shared_facts = ui_facts; atomic_store_explicit(&facts_ready, true, memory_order_release);
  }
  if (atomic_load_explicit(&snapshot_ready, memory_order_acquire)) {
    snapshot = shared_snapshot; atomic_store_explicit(&snapshot_ready, false, memory_order_release);
  }
  if (atomic_load_explicit(&shot, memory_order_acquire) == SHOT_DONE) {
    if (capture.top) linearFree(capture.top);
    if (capture.aux) linearFree(capture.aux);
    memset(&capture, 0, sizeof capture);
    atomic_store_explicit(&shot, SHOT_IDLE, memory_order_release);
  }
}
/* This is channel availability, not connection state: the JS shim attaches
 * during boot, before the asynchronous key/network initialization finishes. */
bool devserver_active(void) { return worker != NULL; }
bool devserver_connected(void) { return snapshot.info.connected; }
void devserver_snapshot(DevserverSnapshot *out) { if (out) *out = snapshot.info; }
const char *devserver_debug_stats(void) { return snapshot.stats[0] ? snapshot.stats : "{}"; }

bool devserver_take_candidate(PocketRuntimePackage **out) {
  if (atomic_load_explicit(&transaction, memory_order_acquire) != TX_OFFER) return false;
  *out = candidate;
  atomic_store_explicit(&transaction, TX_HELD, memory_order_release); return true;
}
void devserver_finish_candidate(bool accepted, const char *error) {
  if (atomic_load_explicit(&transaction, memory_order_acquire) != TX_HELD) return;
  snprintf(rejection, sizeof rejection, "%s", error ? error : "guest rejected");
  atomic_store_explicit(&transaction, accepted ? TX_ACCEPT : TX_REJECT, memory_order_release);
}
bool devserver_take_outcome(bool *committed) {
  int phase = atomic_load_explicit(&transaction, memory_order_acquire);
  if (phase != TX_OK && phase != TX_ERROR) return false;
  *committed = phase == TX_OK;
  atomic_store_explicit(&transaction, TX_IDLE, memory_order_release); return true;
}
bool devserver_reload(void) {
  return !atomic_exchange_explicit(&reload_requested, true, memory_order_acq_rel);
}
bool devserver_recover(uint64_t hash, const char *error) {
  unsigned w = atomic_load_explicit(&recovery_write, memory_order_relaxed);
  if (w - atomic_load_explicit(&recovery_read, memory_order_acquire) == QUEUE_SLOTS) return false;
  recoveries[w % QUEUE_SLOTS].hash = hash;
  snprintf(recoveries[w % QUEUE_SLOTS].error, sizeof recoveries[0].error, "%s", error);
  atomic_store_explicit(&recovery_write, w + 1, memory_order_release); return true;
}

bool devserver_request_screenshot(void) {
  if (!devserver_connected() || atomic_load_explicit(&shot, memory_order_acquire) != SHOT_IDLE) return false;
  return !atomic_exchange_explicit(&shot_requested, true, memory_order_acq_rel);
}
bool devserver_take_screenshot_request(void) {
  int expected = SHOT_REQUEST;
  return atomic_compare_exchange_strong_explicit(&shot, &expected, SHOT_CAPTURE, memory_order_acq_rel, memory_order_relaxed);
}
bool devserver_screenshot_begin(uint32_t frame, uint16_t tw, uint16_t th,
  uint16_t aw, uint16_t ah, uint8_t **top, uint8_t **aux) {
  if (atomic_load_explicit(&shot, memory_order_acquire) != SHOT_CAPTURE) return false;
  if (!top || !aux || tw != 400 || th != 240 || aw != 320 || ah != 240) {
    devserver_screenshot_cancel(); return false;
  }
  capture.top = linearAlloc((size_t)tw * th * 3);
  capture.aux = linearAlloc((size_t)aw * ah * 3);
  if (!capture.top || !capture.aux) { devserver_screenshot_cancel(); return false; }
  capture.frame = frame; capture.tw = tw; capture.th = th; capture.aw = aw; capture.ah = ah;
  *top = capture.top; *aux = capture.aux; return true;
}
void devserver_screenshot_ready(void) { atomic_store_explicit(&shot, SHOT_READY, memory_order_release); }
void devserver_screenshot_cancel(void) {
  /* In-flight buffers are returned by the transport, never freed underneath it. */
  int expected = SHOT_CAPTURE;
  atomic_compare_exchange_strong_explicit(&shot, &expected, SHOT_DONE, memory_order_acq_rel, memory_order_relaxed);
}

static void pump_screenshot(void) {
  if (atomic_exchange_explicit(&shot_requested, false, memory_order_acq_rel)) devtransport_request_screenshot();
  if (devtransport_take_screenshot_request()) {
    int expected = SHOT_IDLE;
    atomic_compare_exchange_strong_explicit(&shot, &expected, SHOT_REQUEST, memory_order_acq_rel, memory_order_relaxed);
  }
  int phase = atomic_load_explicit(&shot, memory_order_acquire);
  if (phase == SHOT_READY) {
    if (devtransport_connected()) {
      devtransport_adopt_screenshot(capture.frame, capture.tw, capture.th, capture.aw, capture.ah, capture.top, capture.aux);
      atomic_store_explicit(&shot, SHOT_SEND, memory_order_release);
    } else atomic_store_explicit(&shot, SHOT_DONE, memory_order_release);
  } else if (phase == SHOT_SEND && !devtransport_screenshot_busy()) {
    atomic_store_explicit(&shot, SHOT_DONE, memory_order_release);
  } else if (phase == SHOT_REQUEST && !devtransport_connected()) {
    int expected = SHOT_REQUEST;
    atomic_compare_exchange_strong_explicit(&shot, &expected, SHOT_IDLE, memory_order_acq_rel, memory_order_relaxed);
  }
}

static bool compatible(PocketRuntimePackage *package, char *error, size_t length) {
  if (!package) return false;
  if (pocket_package_same_app(recovery_package->bytes, recovery_package->length, package->bytes, package->length)) return true;
  snprintf(error, length, "app identity or native plan differs; install a new .3dsx"); return false;
}
static void offer(PocketRuntimePackage *package, PocketRuntimePackage *metadata) {
  const PocketRuntimePackage *source = package ? package : recovery_package;
  metadata->guest.package_hash = source->guest.package_hash;
  metadata->guest.variant_hash = source->guest.variant_hash;
  snprintf(metadata->origin, sizeof metadata->origin, "%s", source->origin);
  candidate = package;
  atomic_store_explicit(&transaction, TX_OFFER, memory_order_release);
}
static void serve(void *unused) {
  (void)unused;
  PocketRuntimeState state = {0};
  PocketRuntimeFailureLineage failures = {0};
  char error[256] = {0};
  bool storage = runtime_storage_init(&state, error, sizeof error);
  bool startup = storage, recovering = false, retry_recovery = false;
  uint64_t next_active = 0, next_good = 0, report_hash = 0;
  uint64_t retry_at = 0, storage_retry_at = osGetTime() + 3000;
  unsigned guest_epoch = 0;
  Facts facts = { .hash = recovery_package->guest.package_hash, .variant = recovery_package->guest.variant_hash };
  snprintf(facts.phase, sizeof facts.phase, "booted");
  PocketRuntimePackage running = {0}, admitted = {0};
  while (!atomic_load_explicit(&stopping, memory_order_acquire)) {
    if (!storage && osGetTime() >= storage_retry_at) {
      storage = runtime_storage_init(&state, error, sizeof error);
      startup = storage; storage_retry_at = osGetTime() + 3000;
    }
    if (!devtransport_active() && osGetTime() >= retry_at) {
      devtransport_init(&state, error, sizeof error); retry_at = osGetTime() + 3000;
    }
    unsigned current = atomic_load_explicit(&epoch, memory_order_acquire);
    if (current != guest_epoch) { guest_epoch = current; devtransport_reset_guest(); }
    if (atomic_load_explicit(&facts_ready, memory_order_acquire)) {
      facts = shared_facts; atomic_store_explicit(&facts_ready, false, memory_order_release);
    }
    running.guest.package_hash = facts.hash; running.guest.variant_hash = facts.variant;
    devtransport_set_runtime(&state, &running, facts.phase, facts.frame);
    devtransport_set_frame_stats(facts.frame, facts.commands, facts.vertices, facts.dropped);
    int phase = atomic_load_explicit(&transaction, memory_order_acquire);
    devtransport_set_upload_busy(!storage || (phase != TX_IDLE && phase != TX_OK && phase != TX_ERROR));
    devtransport_poll();
    pump_screenshot();

    /* Each pass copies at most four records in either direction. */
    unsigned r = atomic_load_explicit(&out_read, memory_order_relaxed);
    unsigned w = atomic_load_explicit(&out_write, memory_order_acquire);
    for (; r != w; r++) {
      Output *slot = &outputs[r % QUEUE_SLOTS];
      if (slot->epoch == guest_epoch) {
        if (!devtransport_ctrl_available(slot->kind == 0 ? slot->length : 640)) break;
        if (slot->kind == 0) devtransport_send_ctrl(slot->bytes, slot->length);
        else if (slot->kind == 1) devtransport_report_install(slot->label, slot->hash, slot->bytes);
        else devtransport_report_log(slot->label, slot->bytes);
      }
      atomic_store_explicit(&out_read, r + 1, memory_order_release);
    }
    w = atomic_load_explicit(&in_write, memory_order_relaxed);
    r = atomic_load_explicit(&in_read, memory_order_acquire);
    for (unsigned count = 0; w - r < QUEUE_SLOTS && count < QUEUE_SLOTS; count++, w++) {
      Input *slot = &inputs[w % QUEUE_SLOTS];
      slot->length = devtransport_recv_ctrl(slot->bytes, sizeof slot->bytes);
      if (!slot->length) break;
      slot->epoch = guest_epoch;
      atomic_store_explicit(&in_write, w + 1, memory_order_release);
    }

    if (phase == TX_ACCEPT || phase == TX_REJECT) {
      bool accepted = phase == TX_ACCEPT;
      if (accepted && (state.active_hash != next_active || state.last_good_hash != next_good))
        accepted = runtime_commit(&state, next_active, next_good, error, sizeof error);
      if (accepted) {
        runtime_failure_lineage_reset(&failures); retry_recovery = false;
        runtime_write_status(&state, &admitted, "accepted");
        devtransport_set_runtime(&state, &admitted, "accepted", facts.frame);
        devtransport_report_install("accepted", report_hash, "first GPU frame retired; generation committed");
      } else {
        const char *message = phase == TX_REJECT ? rejection : error;
        runtime_write_error("update", message);
        devtransport_report_install("rejected", report_hash, message);
        if (retry_recovery && next_active != 0) { runtime_failure_lineage_add(&failures, next_active); recovering = true; }
      }
      atomic_store_explicit(&transaction, accepted ? TX_OK : TX_ERROR, memory_order_release);
    } else if (phase == TX_IDLE && storage) {
      bool reload = atomic_exchange_explicit(&reload_requested, false, memory_order_acq_rel);
      unsigned rr = atomic_load_explicit(&recovery_read, memory_order_relaxed);
      unsigned rw = atomic_load_explicit(&recovery_write, memory_order_acquire);
      for (; rr != rw; rr++) {
        runtime_failure_lineage_add(&failures, recoveries[rr % QUEUE_SLOTS].hash);
        runtime_write_error("guest", recoveries[rr % QUEUE_SLOTS].error); recovering = true;
        atomic_store_explicit(&recovery_read, rr + 1, memory_order_release);
      }
      PocketRuntimePackage *package = NULL;
      uint64_t upload = 0;
      RuntimePendingResult result = RUNTIME_PENDING_NONE;
      bool boot = startup;
      if (!recovering && devtransport_take_upload(&upload)) {
        result = runtime_prepare_file(POCKET_RUNTIME_UPLOAD, upload, &package, error, sizeof error);
      } else if (!recovering && (startup || reload)) {
        result = runtime_prepare_pending(&package, error, sizeof error);
      }
      startup = false;
      if (result == RUNTIME_PENDING_READY && !compatible(package, error, sizeof error)) {
        report_hash = package->guest.package_hash; runtime_package_free(package); package = NULL;
        result = RUNTIME_PENDING_ERROR;
      }
      if (result == RUNTIME_PENDING_ERROR) {
        runtime_write_error("admission", error);
        devtransport_report_install("rejected", upload, error);
      }
      if (package) {
        next_active = package->guest.package_hash;
        next_good = next_active == state.active_hash ? state.last_good_hash : state.active_hash;
        report_hash = next_active; retry_recovery = boot;
        offer(package, &admitted);
      } else if (recovering || (boot && state.active_hash != 0)) {
        recovering = false; retry_recovery = true;
        for (;;) {
          next_active = runtime_recovery_hash(&state, &failures);
          if (!next_active) break;
          package = runtime_package_load_hash(next_active, error, sizeof error);
          if (compatible(package, error, sizeof error)) break;
          runtime_package_free(package); package = NULL;
          runtime_write_error("recovery", error);
          if (!runtime_failure_lineage_add(&failures, next_active)) { next_active = 0; break; }
        }
        next_good = next_active == state.active_hash ? state.last_good_hash : 0;
        report_hash = package ? package->guest.package_hash : recovery_package->guest.package_hash;
        offer(package, &admitted);
      }
    }
    if (!atomic_load_explicit(&snapshot_ready, memory_order_acquire)) {
      devtransport_snapshot(&shared_snapshot.info);
      snprintf(shared_snapshot.stats, sizeof shared_snapshot.stats, "%s", devtransport_debug_stats());
      atomic_store_explicit(&snapshot_ready, true, memory_order_release);
    }
    svcSleepThread(4 * 1000 * 1000);
  }
  devtransport_shutdown();
  /* An offered buffer still belongs to the worker; all taken ones to UI. */
  if (atomic_load_explicit(&transaction, memory_order_acquire) == TX_OFFER) runtime_package_free(candidate);
}
bool devserver_start(const PocketRuntimePackage *embedded) {
  if (worker) return true;
  recovery_package = embedded;
  atomic_store(&stopping, false);
  worker = threadCreate(serve, NULL, 32 * 1024, 0x3f, -2, false);
  return worker != NULL;
}
void devserver_shutdown(void) {
  if (!worker) return;
  atomic_store_explicit(&stopping, true, memory_order_release);
  threadJoin(worker, U64_MAX); threadFree(worker); worker = NULL;
  if (capture.top) linearFree(capture.top);
  if (capture.aux) linearFree(capture.aux);
  memset(&capture, 0, sizeof capture);
}
