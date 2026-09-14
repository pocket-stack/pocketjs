#include "3ds.h"
#include "media_library.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <signal.h>
bool soc_ensure(char *error,size_t length) {(void)error;(void)length;return true;}
static const char *wait_library(void) {
  for(unsigned i=0;i<5000;i++) {const char *value=media_library_snapshot();if(value)return value;svcSleepThread(1000000);}
  assert(!"Library publication timed out");return NULL;
}
int main(int argc,char **argv) {
  assert(argc==5);signal(SIGPIPE,SIG_IGN);
  assert(media_library_start());puts(wait_library());
  assert(!media_download("127.0.0.1",atoi(argv[1]),argv[2],"../escape"));
  assert(media_download("127.0.0.1",atoi(argv[1]),argv[2],argv[3]));
  assert(!media_download("127.0.0.1",atoi(argv[1]),argv[2],"duplicate"));
  if(!strcmp(argv[4],"cancel"))media_download_cancel();
  char status[320];bool done=false;
  for(uint64_t deadline=osGetTime()+20000;osGetTime()<deadline;) {
    media_download_status(status,sizeof status);
    if(strstr(status,"complete") || strstr(status,"cancelled") || strstr(status,"\"phase\":\"error\"")) {done=true;break;}
    svcSleepThread(1000000);
  }
  assert(done);puts(status);puts(wait_library());media_library_stop();
  assert(media_library_start());puts(wait_library());
  if(!strcmp(argv[4],"remove")) {assert(media_library_remove(argv[3]));puts(wait_library());}
  media_library_stop();return 0;
}
