#include "reactivity.h"
#include <assert.h>
typedef struct {
    RxGraph *g;
    RxNode *source;
    int calls, drops;
} Probe;
static int parity(void *data, RxValue previous, RxValue *value) {
    (void)previous;
    Probe *p = data;
    p->calls++;
    if (rx_read(p->g, p->source, value))
        return -1;
    value->number = (int)value->number % 2;
    return 0;
}
static void dropped(void *data) { ((Probe *)data)->drops++; }
int main(void) {
    RxGraph *g = rx_graph_new();
    RxNode *root = rx_node(g, 3, (RxValue){0}, 0, 0, 0);
    rx_owner(g, root);
    RxNode *source = rx_node(g, 0, (RxValue){0, 1}, 0, 0, 0);
    Probe memo = {g, source, 0, 0};
    RxNode *derived = rx_node(g, 1, (RxValue){0}, parity, dropped, &memo);
    assert(!rx_update(g, derived));
    Probe observer = {g, derived, 0, 0};
    RxNode *sink = rx_node(g, 2, (RxValue){0}, parity, dropped, &observer);
    assert(!rx_update(g, sink));
    assert(!rx_write(g, source, (RxValue){2, 1}));
    assert(memo.calls == 2 && observer.calls == 1);
    assert(!rx_write(g, source, (RxValue){3, 1}));
    assert(memo.calls == 3 && observer.calls == 2);
    size_t allocated = rx_bytes(g);
    rx_dispose(g, root);
    rx_dispose(g, root);
    assert(memo.drops == 1 && observer.drops == 1);
    assert(rx_live(g) == 1 && rx_bytes(g) < allocated);
    assert(!rx_write(g, source, (RxValue){4, 1}));
    assert(memo.calls == 3 && observer.calls == 2);
    rx_graph_free(g);
    assert(memo.drops == 1 && observer.drops == 1);
    return 0;
}
