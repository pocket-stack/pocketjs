/* Desktop OS shim for executing the actual SD/socket worker in tests.
 * It substitutes only libctru thread and time calls, never the transfer code. */
#ifndef TEST_CTRU_THREAD_H
#define TEST_CTRU_THREAD_H
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>
#define U64_MAX UINT64_MAX
typedef pthread_t *Thread;
typedef struct { void (*run)(void *); void *arg; } Start;
static void *thread_entry(void *arg) { Start start=*(Start*)arg;free(arg);start.run(start.arg);return NULL; }
static Thread threadCreate(void (*run)(void *),void *arg,size_t stack,int priority,int cpu,bool detached) {
  (void)stack;(void)priority;(void)cpu;(void)detached;
  Thread thread=malloc(sizeof *thread);Start *start=malloc(sizeof *start);*start=(Start){run,arg};
  if(pthread_create(thread,NULL,thread_entry,start)) abort();return thread;
}
static void threadJoin(Thread thread,uint64_t timeout) { (void)timeout;pthread_join(*thread,NULL); }
static void threadFree(Thread thread) {free(thread);}
static uint64_t osGetTime(void) {struct timespec now;clock_gettime(CLOCK_MONOTONIC,&now);return (uint64_t)now.tv_sec*1000+now.tv_nsec/1000000;}
static void svcSleepThread(int64_t ns) {struct timespec delay={ns/1000000000,ns%1000000000};nanosleep(&delay,NULL);}
#endif
