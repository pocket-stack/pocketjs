/* Storage and sockets belong to this worker. Guest calls copy bounded
 * commands and atomics; the library response is an SPSC publication. */
#include "media_library.h"
#include "media_archive.h"
#include "soc.h"
#include <3ds.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>

enum { LIB_SCAN=1, LIB_SAVE, LIB_REMOVE };
enum { DL_IDLE, DL_CONNECTING, DL_DOWNLOADING, DL_VERIFYING, DL_COMPLETE, DL_CANCELLED, DL_ERROR };
enum { DL_OK, DL_NETWORK, DL_INVALID, DL_STORAGE, DL_CHECKSUM, DL_EXISTS, DL_FULL };
typedef struct { unsigned kind,port,generation; char host[16],token[65],key[65]; } LibraryCommand;
static LibraryCommand commands[4];
static _Atomic unsigned command_read,command_write,cancellation,phase,received,total,error_code;
static _Atomic bool running,save_pending;
static Thread worker;
static unsigned current_generation;
/* One writer publishes only while the reader has released the previous copy. */
static char library_json[65536],guest_json[65536];
static _Atomic bool library_ready;
static uint8_t buffer[MEDIA_ARCHIVE_CHUNK];
_Static_assert(ATOMIC_INT_LOCK_FREE==2,"Library commands must be lock-free");

static void path_for(char *out,size_t capacity,const char *key,const char *suffix) { snprintf(out,capacity,"%s/%s%s",POCKETJS_MEDIA_ROOT,key,suffix); }
static bool alive(void) { return atomic_load(&running) && current_generation==atomic_load(&cancellation); }
static bool mkdirs(void) {
  char path[256]; snprintf(path,sizeof path,"%s",POCKETJS_MEDIA_ROOT);
  for(char *p=path;*p;p++) if(*p=='/' && p>path && p[-1]!=':') { *p=0; if(mkdir(path,0777) && errno!=EEXIST) return false; *p='/'; }
  return !mkdir(path,0777) || errno==EEXIST;
}
static size_t quote(char *out,const uint8_t *text,size_t length) {
  size_t at=0; out[at++]='"';
  for(size_t i=0;i<length && text[i];i++) {
    unsigned c=text[i];
    if(c=='"' || c=='\\') out[at++]='\\';
    if(c<32) { out[at++]=' '; continue; }
    out[at++]=(char)c;
  }
  out[at++]='"';out[at]=0;return at;
}
static unsigned scan(bool publish) {
  /* Scans may coalesce, but never race a guest copying a published response. */
  if(publish) while(atomic_load_explicit(&library_ready,memory_order_acquire) && atomic_load(&running)) svcSleepThread(1000000);
  size_t at=0;unsigned count=0; if(publish) library_json[at++]='[';
  DIR *dir=opendir(POCKETJS_MEDIA_ROOT); struct dirent *entry;
  if(dir) while((entry=readdir(dir))) {
    size_t n=strlen(entry->d_name); if(n<5 || n>68 || strcmp(entry->d_name+n-4,".pkd")) continue;
    char key[65],path[320];memcpy(key,entry->d_name,n-4);key[n-4]=0;
    if(!media_key_valid(key)) continue;
    path_for(path,sizeof path,key,".pkd");FILE *file=fopen(path,"rb");uint8_t h[256];
    bool valid=file && fread(h,1,256,file)==256 && media_archive_valid(h);
    struct stat info;valid=valid && !stat(path,&info) && (uint64_t)info.st_size==256ull+media_u32(h+8)+media_u32(h+12)+media_u32(h+16);
    if(file) fclose(file);
    if(!valid) continue;
    if(publish && count<MEDIA_LIBRARY_LIMIT) {
      char title[322],language[66];quote(title,h+32,160);quote(language,h+192,32);
      at+=(size_t)snprintf(library_json+at,sizeof library_json-at,"%s{\"key\":\"%s\",\"title\":%s,\"language\":%s,\"durationMs\":%lu,\"bytes\":%lu,\"video\":%s,\"captions\":%s}",
        count?",":"",key,title,language,(unsigned long)media_u32(h+20),(unsigned long)info.st_size,media_u32(h+8)?"true":"false",media_u32(h+16)?"true":"false");
    }
    count++;
  }
  if(dir) closedir(dir);
  if(publish) { library_json[at++]=']';library_json[at]=0;atomic_store_explicit(&library_ready,true,memory_order_release); }
  return count;
}
static bool receive_bytes(int fd,uint8_t *bytes,size_t count) {
  uint64_t deadline=osGetTime()+15000;
  while(count && alive()) {
    int n=recv(fd,bytes,count,0);
    if(n>0) { bytes+=n;count-=n;deadline=osGetTime()+15000;continue; }
    if(!n || (errno!=EWOULDBLOCK && errno!=EAGAIN) || osGetTime()>deadline) return false;
    svcSleepThread(1000000);
  }
  return !count && alive();
}
static bool send_bytes(int fd,const char *bytes,size_t count) {
  uint64_t deadline=osGetTime()+15000;
  while(count && alive() && osGetTime()<deadline) {
    int n=send(fd,bytes,count,0);
    if(n>0) { bytes+=n;count-=n;continue; }
    if(errno!=EWOULDBLOCK && errno!=EAGAIN && errno!=ENOTCONN && errno!=EINPROGRESS) return false;
    svcSleepThread(1000000);
  }
  return !count && alive();
}
static void download(const LibraryCommand *cmd) {
  current_generation=cmd->generation;
  unsigned error=DL_NETWORK;int fd=-1;FILE *file=NULL,*vtt=NULL;
  char temporary[320],destination[320],subpart[320],subtitle[320];
  path_for(temporary,sizeof temporary,cmd->key,".part");path_for(destination,sizeof destination,cmd->key,".pkd");
  path_for(subpart,sizeof subpart,cmd->key,".vtt.part");path_for(subtitle,sizeof subtitle,cmd->key,".vtt");
  uint8_t header[256];uint32_t crc=0xffffffff;
  if(!alive()) goto done;
  if(!mkdirs()) {error=DL_STORAGE;goto done;}
  struct stat info;if(!stat(destination,&info)) {error=DL_EXISTS;goto done;}
  if(scan(false)>=MEDIA_LIBRARY_LIMIT) {error=DL_FULL;goto done;}
  uint64_t deadline=osGetTime()+15000;
  while(alive() && !soc_ensure(NULL,0) && osGetTime()<deadline) svcSleepThread(10000000);
  if(!alive()) goto done;
  fd=socket(AF_INET,SOCK_STREAM,0);if(fd<0) goto done;
  fcntl(fd,F_SETFL,O_NONBLOCK);
  struct sockaddr_in address={.sin_family=AF_INET,.sin_port=htons(cmd->port)};
  if(inet_pton(AF_INET,cmd->host,&address.sin_addr)!=1) goto done;
  if(connect(fd,(struct sockaddr *)&address,sizeof address)<0 && errno!=EINPROGRESS) goto done;
  if(!send_bytes(fd,cmd->token,64) || !receive_bytes(fd,header,256)) goto done;
  if(!media_archive_valid(header)) {error=DL_INVALID;goto done;}
  uint32_t payload=media_u32(header+8)+media_u32(header+12)+media_u32(header+16);
  atomic_store(&total,payload+256);atomic_store(&received,256);
  file=fopen(temporary,"wb");if(!file || fwrite(header,1,256,file)!=256) {error=DL_STORAGE;goto done;}
  if(!send_bytes(fd,"\1",1)) goto done;
  atomic_store(&phase,DL_DOWNLOADING);
  for(uint32_t remaining=payload;remaining && alive();) {
    unsigned count=remaining<sizeof buffer?remaining:sizeof buffer;
    if(!receive_bytes(fd,buffer,count)) goto done;
    if(fwrite(buffer,1,count,file)!=count) {error=DL_STORAGE;goto done;}
    crc=media_crc(buffer,count,crc);remaining-=count;atomic_fetch_add(&received,count);
    if(!send_bytes(fd,"\1",1)) goto done;
  }
  if(!alive()) goto done;
  if((crc^0xffffffff)!=media_u32(header+24)) {error=DL_CHECKSUM;goto done;}
  atomic_store(&phase,DL_VERIFYING);
  if(fflush(file)) {error=DL_STORAGE;goto done;}
  if(fclose(file)) {file=NULL;error=DL_STORAGE;goto done;}file=NULL;
  /* Read back the SD file before publishing it; a successful socket read is
   * not a durable library entry. This also catches short SD writes. */
  file=fopen(temporary,"rb");if(!file || fseek(file,256,SEEK_SET)) {error=DL_STORAGE;goto done;}
  crc=0xffffffff;
  for(uint32_t remaining=payload;remaining && alive();) {
    unsigned count=remaining<sizeof buffer?remaining:sizeof buffer;
    if(fread(buffer,1,count,file)!=count) {error=DL_STORAGE;goto done;}
    crc=media_crc(buffer,count,crc);remaining-=count;
  }
  if(!alive()) goto done;
  if((crc^0xffffffff)!=media_u32(header+24)) {error=DL_CHECKSUM;goto done;}
  if(media_u32(header+16)) {
    if(fseek(file,256+media_u32(header+8)+media_u32(header+12),SEEK_SET)) {error=DL_STORAGE;goto done;}
    vtt=fopen(subpart,"wb");if(!vtt) {error=DL_STORAGE;goto done;}
    for(uint32_t remaining=media_u32(header+16);remaining && alive();) {
      unsigned count=remaining<sizeof buffer?remaining:sizeof buffer;
      if(fread(buffer,1,count,file)!=count || fwrite(buffer,1,count,vtt)!=count) {error=DL_STORAGE;goto done;}
      remaining-=count;
    }
    if(fclose(vtt)) {vtt=NULL;error=DL_STORAGE;goto done;}vtt=NULL;
    if(!alive()) goto done;
    if(rename(subpart,subtitle)) {error=DL_STORAGE;goto done;}
  }
  fclose(file);file=NULL;
  if(!alive()) {remove(subtitle);goto done;}
  if(rename(temporary,destination)) {remove(subtitle);error=DL_STORAGE;goto done;}
  error=DL_OK;
done:
  if(fd>=0) close(fd);
  if(file) fclose(file);
  if(vtt) fclose(vtt);
  remove(temporary);remove(subpart);
  atomic_store(&error_code,error);atomic_store(&phase,error==DL_OK?DL_COMPLETE:!alive()?DL_CANCELLED:DL_ERROR);
  atomic_store(&save_pending,false);
  scan(true);
}
static void run(void *unused) {
  (void)unused;mkdirs();scan(true);
  while(atomic_load(&running)) {
    unsigned read=atomic_load_explicit(&command_read,memory_order_relaxed),write=atomic_load_explicit(&command_write,memory_order_acquire);
    if(read==write) {svcSleepThread(1000000);continue;}
    LibraryCommand cmd=commands[read%4];atomic_store_explicit(&command_read,read+1,memory_order_release);
    if(cmd.kind==LIB_SAVE) download(&cmd);
    else if(cmd.kind==LIB_SCAN) scan(true);
    else if(cmd.kind==LIB_REMOVE) {char path[320];path_for(path,sizeof path,cmd.key,".pkd");remove(path);path_for(path,sizeof path,cmd.key,".vtt");remove(path);scan(true);}
  }
}
static bool enqueue(LibraryCommand cmd) {
  unsigned write=atomic_load_explicit(&command_write,memory_order_relaxed);
  if(!atomic_load(&running) || write-atomic_load_explicit(&command_read,memory_order_acquire)>=4) return false;
  commands[write%4]=cmd;atomic_store_explicit(&command_write,write+1,memory_order_release);return true;
}
bool media_library_start(void) {atomic_store(&running,true);worker=threadCreate(run,NULL,32*1024,0x3f,-2,false);return worker!=NULL;}
void media_library_stop(void) {atomic_store(&running,false);atomic_fetch_add(&cancellation,1);if(worker){threadJoin(worker,U64_MAX);threadFree(worker);worker=NULL;}}
bool media_download(const char *host,unsigned port,const char *token,const char *key) {
  if(!host || strlen(host)>15 || !port || port>65535 || !token || strlen(token)!=64 || !media_key_valid(key) || atomic_load(&save_pending)) return false;
  for(unsigned i=0;i<64;i++) if(!((token[i]>='0' && token[i]<='9') || (token[i]>='a' && token[i]<='f'))) return false;
  LibraryCommand cmd={.kind=LIB_SAVE,.port=port,.generation=atomic_load(&cancellation)};
  strcpy(cmd.host,host);strcpy(cmd.token,token);strcpy(cmd.key,key);
  atomic_store(&received,0);atomic_store(&total,0);atomic_store(&error_code,0);atomic_store(&phase,DL_CONNECTING);atomic_store(&save_pending,true);
  if(enqueue(cmd)) return true;
  atomic_store(&save_pending,false);atomic_store(&phase,DL_IDLE);return false;
}
void media_download_cancel(void) {atomic_fetch_add(&cancellation,1);}
bool media_library_refresh(void) {return enqueue((LibraryCommand){.kind=LIB_SCAN});}
bool media_library_remove(const char *key) {if(!media_key_valid(key)) return false;LibraryCommand cmd={.kind=LIB_REMOVE};strcpy(cmd.key,key);return enqueue(cmd);}
const char *media_library_snapshot(void) {
  if(!atomic_load_explicit(&library_ready,memory_order_acquire)) return NULL;
  memcpy(guest_json,library_json,sizeof guest_json);atomic_store_explicit(&library_ready,false,memory_order_release);return guest_json;
}
void media_library_forget_guest(void) {media_download_cancel();media_library_snapshot();media_library_refresh();}
void media_download_status(char *out,size_t capacity) {
  static const char *phases[]={"idle","connecting","downloading","verifying","complete","cancelled","error"};
  static const char *errors[]={"","Download connection lost; retry","Invalid download format","SD write failed; check free space","Download checksum failed; retry","Already saved on SD","Library full; delete a saved item"};
  unsigned p=atomic_load(&phase),e=atomic_load(&error_code);
  snprintf(out,capacity,"{\"phase\":\"%s\",\"receivedBytes\":%u,\"totalBytes\":%u,\"error\":\"%s\"}",phases[p<7?p:6],atomic_load(&received),atomic_load(&total),errors[e<7?e:1]);
}
