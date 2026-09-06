#pragma once
#include <stdio.h>
#define ESP_LOGE(tag, ...) do { (void)(tag); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
