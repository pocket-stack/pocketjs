#ifndef POCKET_REACTIVITY_H
#define POCKET_REACTIVITY_H
#include <stddef.h>
typedef struct RxGraph RxGraph;
typedef struct RxNode RxNode;
typedef struct {
    double number;
    int kind;
} RxValue; /* 0 undefined, 1 number, 2 boolean */
typedef int (*RxCompute)(void *, RxValue, RxValue *);
typedef void (*RxDrop)(void *);
RxGraph *rx_graph_new(void);
void rx_graph_free(RxGraph *);
RxNode *rx_node(RxGraph *, int kind, RxValue, RxCompute, RxDrop, void *);
/* kind: 0 signal, 1 memo, 2 observer, 3 root */
int rx_read(RxGraph *, RxNode *, RxValue *);
int rx_write(RxGraph *, RxNode *, RxValue);
int rx_update(RxGraph *, RxNode *);
void rx_dispose(RxGraph *, RxNode *);
RxNode *rx_owner(RxGraph *, RxNode *);
RxNode *rx_listener(RxGraph *, RxNode *);
size_t rx_bytes(RxGraph *);
size_t rx_live(RxGraph *);
#endif
