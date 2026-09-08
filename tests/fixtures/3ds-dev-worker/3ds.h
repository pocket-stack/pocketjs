#include "../offload-native/3ds.h"
void *test_linear_alloc(size_t);
void test_linear_free(void *);
#define linearAlloc test_linear_alloc
#define linearFree test_linear_free
