#include <assert.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <3ds.h>
#include "devserver.h"
#include "dev_transport.h"

static pthread_t ui_thread;
static atomic_bool fail_commit, connected, upload_ready, incoming, screenshot_busy, want_shot;
static atomic_bool writable = true;
static atomic_uint starts, reports, sends;
static unsigned linear_live;
static PocketRuntimePackage embedded;
static uint8_t embedded_bytes[32] = {0x50, 1};
static uint64_t upload_hash;
static unsigned ticks;
static void worker_only(void) { assert(!pthread_equal(pthread_self(), ui_thread)); }
void *test_linear_alloc(size_t size) { assert(pthread_equal(pthread_self(), ui_thread)); linear_live++; return malloc(size); }
void test_linear_free(void *p) { assert(pthread_equal(pthread_self(), ui_thread)); linear_live--; free(p); }
int test_fsync(int fd) {
  worker_only(); svcSleepThread(200000000);
  if (atomic_load(&fail_commit)) { errno = EIO; return -1; }
  return fsync(fd);
}
int32_t pocket_package_open(const uint8_t *b, size_t n, const uint8_t *t, size_t tl, uint32_t abi, PocketGuestPackage *out) {
  (void)t; (void)tl; (void)abi;
  worker_only(); atomic_fetch_add(&starts, 1); svcSleepThread(200000000);
  if (n != 32 || b[0] != 0x50) return 4;
  memset(out, 0, sizeof *out); memcpy(&out->package_hash, b + 24, 8); out->javascript = b; out->javascript_length = 2; return 0;
}
bool pocket_package_same_app(const uint8_t *a, size_t an, const uint8_t *b, size_t bn) {
  worker_only(); return an == bn && a[1] == b[1];
}
DevserverInitResult devtransport_init(const PocketRuntimeState *s, char *e, size_t n) { (void)s;(void)e;(void)n;worker_only(); return DEVSERVER_READY; }
void devtransport_shutdown(void) { worker_only(); atomic_store(&screenshot_busy,false); }
bool devtransport_active(void) { worker_only(); return true; }
bool devtransport_connected(void) { worker_only(); return atomic_load(&connected); }
void devtransport_poll(void) { worker_only(); if (!atomic_load(&connected)) atomic_store(&screenshot_busy,false); }
void devtransport_snapshot(DevserverSnapshot *o) { worker_only(); memset(o,0,sizeof *o);o->enabled=true;o->connected=atomic_load(&connected); }
void devtransport_set_runtime(const PocketRuntimeState *s,const PocketRuntimePackage *p,const char *f,uint32_t n) {(void)s;(void)p;(void)f;(void)n;worker_only();}
void devtransport_set_frame_stats(uint32_t f,uint32_t c,uint32_t v,uint32_t d) {(void)f;(void)c;(void)v;(void)d;worker_only();}
const char *devtransport_debug_stats(void) {worker_only();return "{}";}
void devtransport_set_upload_busy(bool b) {(void)b;worker_only();}
void devtransport_reset_guest(void) {worker_only();}
bool devtransport_ctrl_available(size_t n) {(void)n;worker_only();return atomic_load(&writable);}
void devtransport_send_ctrl(const char *b,size_t n) {(void)b;(void)n;worker_only();atomic_fetch_add(&sends,1);}
void devtransport_report_install(const char *p,uint64_t h,const char *m) {(void)p;(void)h;(void)m;worker_only();atomic_fetch_add(&reports,1);}
void devtransport_report_log(const char *p,const char *m) {(void)p;(void)m;worker_only();}
size_t devtransport_recv_ctrl(char *b,size_t n) {
  worker_only();if (!atomic_exchange(&incoming,false))return 0;
  const char *line="{\"t\":\"eval\",\"code\":\"oldGuest()\"}\n";assert(n>strlen(line));strcpy(b,line);return strlen(line);
}
bool devtransport_take_upload(uint64_t *hash) {
  worker_only();if(!atomic_exchange_explicit(&upload_ready,false,memory_order_acq_rel))return false;
  *hash=upload_hash;return true;
}
bool devtransport_request_screenshot(void) {worker_only();atomic_store(&want_shot,true);return true;}
bool devtransport_take_screenshot_request(void) {worker_only();return atomic_exchange(&want_shot,false);}
bool devtransport_screenshot_busy(void) {worker_only();return atomic_load(&screenshot_busy);}
void devtransport_adopt_screenshot(uint32_t f,uint16_t tw,uint16_t th,uint16_t aw,uint16_t ah,uint8_t *top,uint8_t *aux) {
  (void)f;(void)tw;(void)th;(void)aw;(void)ah;worker_only();assert(top[0]==0x33 && aux[0]==0x44);atomic_store(&screenshot_busy,true);
}
static void tick(void) {
  uint64_t start=osGetTime();devserver_poll();devserver_set_frame_stats(ticks++,1,1,0);
  assert(osGetTime()-start<50);svcSleepThread(1000000);
}
static void advance(unsigned ms) {uint64_t end=osGetTime()+ms;while(osGetTime()<end)tick();}
static void write_package(const char *path,uint64_t hash,bool same) {
  uint8_t bytes[32]={0x50,1};if(!same)bytes[1]=2;memcpy(bytes+24,&hash,8);
  FILE *f=fopen(path,"wb");assert(f);assert(fwrite(bytes,1,32,f)==32);assert(!fclose(f));
}
static void upload(uint64_t hash,bool same) {
  write_package(POCKET_RUNTIME_UPLOAD,hash,same);upload_hash=hash;
  atomic_store_explicit(&upload_ready,true,memory_order_release);
}
static PocketRuntimePackage *take(void) {
  PocketRuntimePackage *p=NULL;uint64_t deadline=osGetTime()+3000;
  while(!devserver_take_candidate(&p)){assert(osGetTime()<deadline);tick();}
  return p;
}
static bool outcome(void) {
  bool committed=false;uint64_t deadline=osGetTime()+3000;
  while(!devserver_take_outcome(&committed)){assert(osGetTime()<deadline);tick();}
  return committed;
}
static PocketRuntimeState state(void) {PocketRuntimeState s;char e[256];assert(runtime_storage_init(&s,e,sizeof e));return s;}
int main(int argc,char **argv) {
  assert(argc==2);assert(!chdir(argv[1]));assert(!mkdir("sdmc:",0777));ui_thread=pthread_self();
  PocketRuntimeState s=state();assert(!s.generation);
  embedded.bytes=embedded_bytes;embedded.length=32;embedded.guest.package_hash=123;
  devserver_set_runtime(NULL,&embedded,"booted",0);assert(devserver_start(&embedded));advance(40);
  unsigned before=ticks;upload(1,true);PocketRuntimePackage *p=take();
  assert(p && p->guest.package_hash==1 && ticks-before>50);assert(state().generation==0);
  before=ticks;devserver_finish_candidate(true,NULL);assert(outcome());assert(ticks-before>50);runtime_package_free(p);
  s=state();assert(s.generation==1 && s.active_hash==1 && s.last_good_hash==0);

  upload(2,true);p=take();devserver_finish_candidate(false,"bad eval");assert(!outcome());runtime_package_free(p);assert(state().generation==1);
  upload(3,true);p=take();atomic_store(&fail_commit,true);devserver_finish_candidate(true,NULL);assert(!outcome());runtime_package_free(p);assert(state().active_hash==1);atomic_store(&fail_commit,false);
  unsigned old=atomic_load(&reports);upload(4,false);advance(350);assert(atomic_load(&reports)>old);assert(!devserver_take_candidate(&p));assert(state().active_hash==1);

  upload(5,true);p=take();devserver_finish_candidate(true,NULL);assert(outcome());runtime_package_free(p);
  assert(state().last_good_hash==1);assert(devserver_recover(5,"frame failed"));p=take();assert(p && p->guest.package_hash==1);
  devserver_finish_candidate(false,"last good failed too");assert(!outcome());runtime_package_free(p);
  p=take();assert(p==NULL);devserver_finish_candidate(true,NULL);assert(outcome());s=state();assert(s.active_hash==0 && s.last_good_hash==0);

  atomic_store(&incoming,true);advance(30);devserver_reset_guest();char line[256];assert(devserver_recv_ctrl(line,sizeof line)==0);
  atomic_store(&incoming,true);advance(30);assert(devserver_recv_ctrl(line,sizeof line)>0);
  atomic_store(&writable,false);advance(10);
  for(unsigned i=0;i<100;i++)devserver_send_ctrl("{}",2);
  atomic_store(&writable,true);advance(30);assert(atomic_load(&sends)==4);
  atomic_store(&connected,true);advance(20);assert(devserver_request_screenshot());advance(20);
  assert(devserver_take_screenshot_request());uint8_t *top,*aux;
  assert(devserver_screenshot_begin(1,400,240,320,240,&top,&aux));top[0]=0x33;aux[0]=0x44;
  devserver_screenshot_ready();advance(20);assert(atomic_load(&screenshot_busy));assert(linear_live==2);
  // UI cancellation cannot free a buffer while transport still borrows it.
  devserver_screenshot_cancel();assert(linear_live==2);
  atomic_store(&connected,false);advance(20);assert(linear_live==0);
  atomic_store(&connected,true);advance(20);assert(devserver_request_screenshot());advance(20);
  assert(devserver_take_screenshot_request());assert(devserver_screenshot_begin(2,400,240,320,240,&top,&aux));
  atomic_store(&connected,false);advance(20);assert(linear_live==2);
  devserver_screenshot_ready();advance(20);assert(linear_live==0);
  devserver_shutdown();assert(linear_live==0);
  printf("worker admission, commit, rejection, recovery, bounded queues and epochs verified (%u UI ticks)\n",ticks);
}
