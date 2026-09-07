#include "../../../hosts/3ds/src/offload.h"
#include <3ds.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
bool soc_ensure(char *error, size_t size) { (void)error; (void)size; return true; }
int main(void) {
  assert(offload_start());
  uint64_t deadline = osGetTime() + 10000; unsigned phase = 0; int first_session = 0;
  while (osGetTime() < deadline && phase < 5) {
    offload_frame(); int session = offload_session();
    if (phase == 0 && session > 0) {
      first_session = session;
      const char *request = "{\"v\":1,\"id\":1,\"method\":\"test.image\",\"payload\":\"{}\",\"response\":\"image\"}";
      if (offload_submit(request, strlen(request))) phase = 1;
    }
    if (phase == 3 && session > first_session) {
      const char *request = "{\"v\":1,\"id\":1,\"method\":\"test.text\",\"payload\":\"{}\"}";
      if (offload_submit(request, strlen(request))) phase = 4;
    }
    char record[4097]; size_t length = offload_take(record); record[length] = 0;
    if (length && phase == 1) {
      unsigned id, token, w, h;
      assert(sscanf(record, "{\"id\":%u,\"image\":{\"token\":%u,\"width\":%u,\"height\":%u}}", &id, &token, &w, &h) == 4);
      assert(id == 1 && w == 256 && h == 256);
      const uint8_t *pixels = offload_image(token, &w, &h); assert(pixels);
      for (unsigned n = 0; n < 256 * 256 * 2; n++) assert(pixels[n] == (n & 255));
      assert(pixels[-3] == 2); /* native IMG envelope uses linear filtering */
      offload_release_image(token); assert(!offload_image(token, &w, &h));
      const char *request="{\"v\":1,\"id\":2,\"method\":\"test.mesh\",\"payload\":\"{}\",\"response\":\"mesh\"}";
      assert(offload_submit(request,strlen(request))); phase=2;
    } else if (length && phase==2) {
      unsigned id,token,w,h,bytes;
      assert(sscanf(record,"{\"id\":%u,\"mesh\":{\"token\":%u,\"width\":%u,\"height\":%u,\"bytes\":%u}}",&id,&token,&w,&h,&bytes)==5);
      assert(id==2 && w==256 && h==256 && bytes==36880); unsigned n;
      const uint8_t *mesh=offload_mesh(token,&n); assert(mesh && n==36880 && !memcmp(mesh,"PMH1",4));
      for(unsigned i=0;i<4096;i++){assert((mesh[16+i*4] | (unsigned)mesh[17+i*4]<<8)==i);assert((mesh[18+i*4] | (unsigned)mesh[19+i*4]<<8)==4096-i);}
      for(unsigned i=0;i<2048;i++){unsigned at=16+4096*4+i*10;for(unsigned j=0;j<3;j++)assert((mesh[at+j*2] | (unsigned)mesh[at+j*2+1]<<8)==i+j);assert(mesh[at+6]==0x56 && mesh[at+9]==0xff);}
      assert(!offload_image(token,&w,&h)); offload_release_image(token); assert(!offload_mesh(token,&n));
      offload_reset(); assert(offload_session() == 0); phase = 3;
    } else if (length && phase == 4) { assert(strstr(record, "network-ok")); phase = 5; }
    svcSleepThread(1000000);
  }
  offload_stop(); assert(phase == 5);
  puts("native socket image transfer and realm-reset reconnect passed");
}
