# Package parser fuzz target

Use a Clang installation with libFuzzer. Copy the committed corpus into a
scratch directory before fuzzing; libFuzzer adds new inputs to that directory.

```sh
cmake -S hosts/esp-idf/tests/fuzz -B /tmp/pocketjs-package-fuzz -DCMAKE_C_COMPILER=clang
cmake --build /tmp/pocketjs-package-fuzz
cp -R tests/fixtures/packages/corpus /tmp/pocketjs-package-fuzz/corpus
/tmp/pocketjs-package-fuzz/package_fuzz /tmp/pocketjs-package-fuzz/corpus -runs=10000
```

The target exercises checked and skip-hash opening, host selection, and
destruction under AddressSanitizer and UndefinedBehaviorSanitizer.
