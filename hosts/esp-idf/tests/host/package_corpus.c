#include "pocketjs/package.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3)
    return 2;
  FILE *file = fopen(argv[1], "rb");
  if (!file || fseek(file, 0, SEEK_END))
    return 2;
  long length = ftell(file);
  if (length < 0)
    return 2;
  rewind(file);
  unsigned char *bytes = malloc((size_t)length + 1);
  if (!bytes || fread(bytes, 1, (size_t)length, file) != (size_t)length)
    return 2;
  fclose(file);
  pocketjs_package_t *package = NULL;
  int accepted =
      pocketjs_package_open(bytes, (size_t)length, 0, &package) == ESP_OK;
  pocketjs_package_close(package);
  free(bytes);
  return accepted == (!strcmp(argv[2], "ok")) ? 0 : 1;
}
