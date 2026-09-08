/* The real socket/file implementation, with only libctru services replaced. */
#include <assert.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include "../../../hosts/3ds/src/dev_transport.c"
static unsigned frees;
void *test_linear_alloc(size_t n) { return malloc(n); }
void test_linear_free(void *p) { frees++; free(p); }
bool soc_ensure(char *error, size_t n) { (void)error; (void)n; return true; }

int main(int argc, char **argv) {
  assert(argc == 2 && chdir(argv[1]) == 0);
  assert(mkdir("sdmc:", 0777) == 0);
  const char *dirs[] = {"sdmc:/pocketjs", POCKET_RUNTIME_ROOT, POCKET_RUNTIME_APPS, POCKET_RUNTIME_APP_ROOT};
  for (unsigned i=0;i<sizeof dirs/sizeof dirs[0];i++) assert(mkdir(dirs[i],0777)==0);
  int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair)==0);
  client_fd=pair[0]; assert(set_nonblocking(client_fd)); assert(set_nonblocking(pair[1]));
  authenticated=initialized=true; client_last_rx_ms=osGetTime();

  uint8_t begin[12]; pocket_runtime_write_u32(begin,POCKET_RUNTIME_UPDATE_MAX_BYTES+1);
  pocket_runtime_write_u64(begin+4,123);
  handle_package_begin(begin,sizeof begin); assert(upload_discarding && !upload_file);
  unsigned notices=install_write; uint8_t chunk[12]={0};
  handle_package_chunk(chunk,sizeof chunk);handle_package_commit();
  assert(install_write==notices && !upload_file && !upload_discarding);
  // Discarding a rejected transfer must leave framing usable for the next one.
  pocket_runtime_write_u32(begin,8);handle_package_begin(begin,sizeof begin);
  assert(upload_file);handle_package_chunk(chunk,sizeof chunk);handle_package_commit();
  assert(upload_ready);uint64_t hash;assert(devtransport_take_upload(&hash) && hash==123);
  FILE *f=fopen(POCKET_RUNTIME_UPLOAD,"rb");assert(f);assert(fread(chunk,1,sizeof chunk,f)==8);fclose(f);

  // An occupied wire buffer cannot swallow a terminal install result.
  tx_offset=0;tx_length=sizeof tx_buffer;unsigned before=install_write;
  devtransport_report_install("accepted",123,"durable");assert(install_write==before+1);
  assert(strstr(install_lines[before%8],"accepted"));tx_offset=tx_length=0;
  install_read=install_write; // isolate screenshot transcript below

  uint8_t *top=malloc(400*240*3),*aux=malloc(320*240*3);
  memset(top,0x33,400*240*3);memset(aux,0x44,320*240*3);
  devtransport_adopt_screenshot(7,400,240,320,240,top,aux);
  size_t received=0;static uint8_t bytes[65536];unsigned steps=0;
  while(devtransport_screenshot_busy() || tx_offset != tx_length) {
    assert(++steps<10000);send_client();ssize_t n;
    while((n=recv(pair[1],bytes,sizeof bytes,0))>0)received+=(size_t)n;
  }
  assert(received>400*240*3+320*240*3 && frees==0);
  // Disconnect returns the borrowed buffers too, without freeing UI memory.
  devtransport_adopt_screenshot(8,400,240,320,240,top,aux);
  disconnect_client();assert(!devtransport_screenshot_busy() && frees==0);
  free(top);free(aux);close(pair[1]);
  puts("transport limits, rejected stream drain, retained receipts and borrowed screenshots verified");
}
