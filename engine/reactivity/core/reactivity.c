#include "reactivity.h"
#include <stdio.h>
#include <stdlib.h>
typedef struct {
    RxNode **p;
    size_t n, cap;
} Vec;
struct RxNode {
    RxValue value;
    int kind, state, running, disposed;
    Vec sources, observers, owned;
    RxNode *owner;
    RxCompute compute;
    RxDrop drop;
    void *data;
};
struct RxGraph {
    Vec nodes, queue;
    RxNode *owner, *listener;
    int flushing;
};
/* This experimental runner terminates on allocation failure. */
static void *alloc(void *p, size_t n) {
    void *r = realloc(p, n);
    if (!r) {
        fputs("reactivity: out of memory\n", stderr);
        abort();
    }
    return r;
}
static void push(Vec *v, RxNode *n) {
    if (v->n == v->cap) {
        v->cap = v->cap ? v->cap * 2 : 4;
        v->p = alloc(v->p, v->cap * sizeof(*v->p));
    }
    v->p[v->n++] = n;
}
static void remove_node(Vec *v, RxNode *n) {
    for (size_t i = 0; i < v->n; ++i)
        if (v->p[i] == n) {
            v->p[i] = v->p[--v->n];
            return;
        }
}
static void detach(RxNode *n) {
    for (size_t i = 0; i < n->sources.n; ++i)
        remove_node(&n->sources.p[i]->observers, n);
    n->sources.n = 0;
}
RxGraph *rx_graph_new(void) {
    RxGraph *g = alloc(NULL, sizeof(*g));
    *g = (RxGraph){0};
    return g;
}
RxNode *rx_owner(RxGraph *g, RxNode *n) {
    RxNode *old = g->owner;
    g->owner = n;
    return old;
}
RxNode *rx_listener(RxGraph *g, RxNode *n) {
    RxNode *old = g->listener;
    g->listener = n;
    return old;
}
RxNode *rx_node(RxGraph *g, int kind, RxValue v, RxCompute fn, RxDrop drop, void *data) {
    RxNode *n = alloc(NULL, sizeof(*n));
    *n = (RxNode){.kind = kind,
                  .value = v,
                  .compute = fn,
                  .drop = drop,
                  .data = data,
                  .owner = kind == 0 || kind == 3 ? NULL : g->owner,
                  .state = kind == 1 || kind == 2 ? 2 : 0};
    push(&g->nodes, n);
    if (n->owner)
        push(&n->owner->owned, n);
    return n;
}
static void children(RxGraph *g, RxNode *n) {
    for (size_t i = 0; i < n->owned.n; ++i)
        rx_dispose(g, n->owned.p[i]);
    n->owned.n = 0;
}
void rx_dispose(RxGraph *g, RxNode *n) {
    if (n->disposed)
        return;
    n->disposed = 1;
    n->state = 0;
    children(g, n);
    detach(n);
    free(n->sources.p);
    n->sources = (Vec){0};
    free(n->owned.p);
    n->owned = (Vec){0};
    if (n->drop)
        n->drop(n->data);
    n->drop = NULL;
    n->compute = NULL;
    n->data = NULL;
}
/* 0 = clean, 1 = check upstream memos, 2 = execute callback.
 * Mark descendants before running anything; pull upstreams before observers.
 * An unchanged memo leaves downstream nodes at state 1, suppressing callbacks. */
static void mark(RxGraph *g, RxNode *n, int state) {
    if (n->disposed)
        return;
    int old = n->state;
    if (old < state)
        n->state = state;
    if (old)
        return;
    push(&g->queue, n);
    for (size_t i = 0; i < n->observers.n; ++i)
        mark(g, n->observers.p[i], 1);
}
static void changed(RxGraph *g, RxNode *n) {
    for (size_t i = 0; i < n->observers.n; ++i)
        mark(g, n->observers.p[i], 2);
}
int rx_update(RxGraph *g, RxNode *n) {
    if (n->disposed || !n->state)
        return 0;
    if (n->running)
        return -1;
    n->running = 1;
    for (size_t i = 0; i < n->sources.n; ++i)
        if (rx_update(g, n->sources.p[i])) {
            n->running = 0;
            return -1;
        }
    if (n->state == 2) {
        children(g, n);
        detach(n);
        RxNode *owner = rx_owner(g, n), *listener = rx_listener(g, n);
        RxValue value = {0};
        int error = n->compute(n->data, n->value, &value);
        rx_owner(g, owner);
        rx_listener(g, listener);
        if (error) {
            n->running = 0;
            return -1;
        }
        if (value.kind != n->value.kind || value.number != n->value.number) {
            n->value = value;
            changed(g, n);
        }
    }
    n->state = 0;
    n->running = 0;
    return 0;
}
int rx_read(RxGraph *g, RxNode *n, RxValue *v) {
    if (rx_update(g, n))
        return -1;
    RxNode *l = g->listener;
    if (l && !l->disposed && !n->disposed) {
        size_t i = 0;
        for (; i < l->sources.n && l->sources.p[i] != n; ++i) {
        }
        if (i == l->sources.n) {
            push(&l->sources, n);
            push(&n->observers, l);
        }
    }
    *v = n->value;
    return 0;
}
int rx_write(RxGraph *g, RxNode *n, RxValue v) {
    if (g->listener || g->flushing)
        return -1; /* Reentrant writes are outside v1. */
    if (n->value.kind == v.kind && n->value.number == v.number)
        return 0;
    n->value = v;
    changed(g, n);
    g->flushing = 1;
    int error = 0;
    for (size_t i = 0; i < g->queue.n; ++i)
        if (rx_update(g, g->queue.p[i])) {
            error = -1;
            break;
        }
    for (size_t i = 0; i < g->queue.n; ++i)
        g->queue.p[i]->state = 0;
    g->queue.n = 0;
    g->flushing = 0;
    return error;
}
size_t rx_bytes(RxGraph *g) {
    size_t bytes = sizeof(*g) + (g->nodes.cap + g->queue.cap) * sizeof(RxNode *);
    for (size_t i = 0; i < g->nodes.n; ++i)
        bytes += sizeof(RxNode) + (g->nodes.p[i]->sources.cap + g->nodes.p[i]->observers.cap +
                                   g->nodes.p[i]->owned.cap) *
                                      sizeof(RxNode *);
    return bytes;
}
size_t rx_live(RxGraph *g) {
    size_t n = 0;
    for (size_t i = 0; i < g->nodes.n; ++i)
        n += !g->nodes.p[i]->disposed;
    return n;
}
void rx_graph_free(RxGraph *g) {
    for (size_t i = 0; i < g->nodes.n; ++i)
        rx_dispose(g, g->nodes.p[i]);
    for (size_t i = 0; i < g->nodes.n; ++i) {
        free(g->nodes.p[i]->observers.p);
        free(g->nodes.p[i]);
    }
    free(g->nodes.p);
    free(g->queue.p);
    free(g);
}
