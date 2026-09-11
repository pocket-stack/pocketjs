#ifndef POCKET_MEDIA_LIBRARY_H
#define POCKET_MEDIA_LIBRARY_H
#include <stdbool.h>
#include <stddef.h>
#ifndef POCKETJS_MEDIA_ROOT
#define POCKETJS_MEDIA_ROOT "sdmc:/pocketjs/media/default"
#endif
bool media_library_start(void);
void media_library_stop(void);
bool media_download(const char *host,unsigned port,const char *token,const char *key);
void media_download_cancel(void);
void media_download_status(char *out,size_t capacity);
bool media_library_refresh(void);
bool media_library_remove(const char *key);
const char *media_library_snapshot(void);
void media_library_forget_guest(void);
#endif
