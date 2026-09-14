#ifndef POCKET_MEDIA_ARCHIVE_H
#define POCKET_MEDIA_ARCHIVE_H
#include "media_wire.h"
#include <stdio.h>
#include <string.h>
#define MEDIA_ARCHIVE_HEADER 256
#define MEDIA_ARCHIVE_CHUNK 32768
#define MEDIA_LIBRARY_LIMIT 64
static inline bool media_key_valid(const char *key) {
  if (!key || !*key || strlen(key)>64) return false;
  for (const char *p=key;*p;p++) if (!((*p>='a' && *p<='z') || (*p>='A' && *p<='Z') || (*p>='0' && *p<='9') || *p=='-' || *p=='_')) return false;
  return true;
}
static inline uint32_t media_crc(const uint8_t *p,size_t n,uint32_t crc) {
  while(n--) { crc^=*p++; for(unsigned i=0;i<8;i++) crc=(crc>>1)^((crc&1)?0xedb88320:0); }
  return crc;
}
static inline bool media_archive_valid(const uint8_t *p) {
  uint32_t video=media_u32(p+8),index=media_u32(p+12),captions=media_u32(p+16);
  return !memcmp(p,"PKDL",4) && media_u16(p+4)==1 && media_u16(p+6)==256
    && (!video || video>=48) && !!video==!!index && !(index%12) && index<=86401*12
    && captions<=4*1024*1024 && media_u32(p+20)<=86400000
    && (uint64_t)256+video+index+captions<=0x7fffffff
    && memchr(p+32,0,160) && memchr(p+192,0,32);
}
/* Binary search the keyframe table. Every offset remains inside the media
 * section, including the optional active-caption packet for seek preroll. */
static inline bool media_archive_seek(FILE *file,const uint8_t *header,uint32_t target,uint32_t *pts,uint32_t *offset,uint32_t *caption) {
  uint32_t video=media_u32(header+8),count=media_u32(header+12)/12;
  if(!count) return false;
  uint32_t low=0,high=count;
  uint8_t record[12];
  while(low+1<high) {
    uint32_t mid=low+(high-low)/2;
    if(fseek(file,256+video+mid*12,SEEK_SET) || fread(record,1,12,file)!=12) return false;
    if(media_u32(record)<=target) low=mid; else high=mid;
  }
  if(fseek(file,256+video+low*12,SEEK_SET) || fread(record,1,12,file)!=12) return false;
  *pts=media_u32(record); *offset=media_u32(record+4); *caption=media_u32(record+8);
  return *pts<=target && *offset>=32 && *offset<video-16 && (!*caption || (*caption>=32 && *caption<*offset));
}
#endif
