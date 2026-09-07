#include <3ds.h>
#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
static _Atomic int slow;
static size_t slow_read(void *p, size_t size, size_t n, FILE *f) {
  if (atomic_load(&slow))
    svcSleepThread(50000000);
  return fread(p, size, n, f);
}
#define fread slow_read
#include "../../../hosts/3ds/src/asset_pack.c"
#undef fread
int32_t ui_register_external_texture(uint32_t w, uint32_t h) {
  assert(w == 16 && h == 16);
  return 17;
}
void ui_free_texture(int32_t handle) { assert(handle == 17); }
bool gfx_stage_image(int32_t handle, const uint8_t *b, unsigned w, unsigned h) {
  assert(handle == 17 && w == 16 && h == 16);
  for (unsigned i = 0; i < 512; i++)
    assert(b[i] == 42);
  return true;
}
static AssetPackResult wait_for(unsigned id) {
  AssetPackResult r;
  u64 end = osGetTime() + 3000;
  while (osGetTime() < end) {
    asset_pack_frame();
    if (asset_pack_take(&r)) {
      assert(r.id == id);
      return r;
    }
    svcSleepThread(1000000);
  }
  assert(!"pack completion deadline");
  return (AssetPackResult){0};
}
static void submit(unsigned id, const char *name, unsigned index) {
  asset_pack_frame();
  assert(asset_pack_submit(id, name, strlen(name), index));
}
int main(void) {
  asset_pack_start();
  assert(asset_pack_session() > 0);
  assert(!asset_pack_submit(1, "../escape", 9, 1));
  submit(1, "valid", 0);
  AssetPackResult r = wait_for(1);
  assert(!r.error && r.kind == 1 && r.length == 2 && !memcmp(r.bytes, "{}", 2));
  asset_pack_release(r.token);
  submit(2, "valid", 1);
  r = wait_for(2);
  assert(!r.error && r.kind == 2 && r.length == 512);
  unsigned old = r.token;
  assert(asset_pack_upload(old) == 17);
  assert(asset_pack_upload(old) < 0);
  asset_pack_release(old);
  asset_pack_frame();
  assert(asset_pack_upload(old) < 0);
  const char *bad[] = {"missing", "checksum", "offset", "truncated"};
  for (unsigned i = 0; i < 4; i++) {
    submit(3 + i, bad[i], 1);
    r = wait_for(3 + i);
    assert(r.error);
    asset_pack_release(r.token);
  }
  // Eight borrowed completions exhaust storage; stale tokens cannot release
  // a reused slot. This is the actual worker and zlib reader, under ASan.
  unsigned held[8];
  for (unsigned i = 0; i < 8; i++) {
    submit(10 + i, "valid", 1);
    r = wait_for(10 + i);
    held[i] = r.token;
    assert(!r.error);
  }
  asset_pack_frame();
  assert(!asset_pack_submit(20, "valid", 5, 1));
  asset_pack_release(old);
  assert(!asset_pack_submit(20, "valid", 5, 1));
  for (unsigned i = 0; i < 8; i++)
    asset_pack_release(held[i]);
  submit(40, "noise", 0);
  r = wait_for(40);
  assert(!r.error && r.kind == 2 && r.length == 131072);
  asset_pack_release(r.token);
  atomic_store(&slow, 1);
  u64 at = osGetTime();
  submit(30, "valid", 1);
  assert(osGetTime() - at < 20);
  // Reset while IO is in progress: the previous realm never receives a
  // completion and the UI can continue ticking without waiting on fread.
  svcSleepThread(5000000);
  asset_pack_reset();
  unsigned ticks = 0;
  at = osGetTime();
  while (osGetTime() - at < 130) {
    asset_pack_frame();
    assert(!asset_pack_take(&r));
    ticks++;
    svcSleepThread(1000000);
  }
  assert(ticks > 30);
  atomic_store(&slow, 0);
  submit(31, "valid", 1);
  r = wait_for(31);
  assert(!r.error);
  asset_pack_release(r.token);
  asset_pack_stop();
  puts("pack worker: bounded IO, corruption, ownership, reset and stalled-read "
       "UI verified");
}
