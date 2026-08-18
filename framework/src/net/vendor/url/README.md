# Pinned URL and IDNA sources

The HTTP URL parser is a bounded adaptation of the special-URL algorithms in
`whatwg-url@17.1.0` and only accepts absolute `http:` and `https:` URLs. The
upstream tarball SHA-256 is
`41859594cde0afc9250957eabc6f8bfd66706ea130df702bc3f52edf78c841c0`.

IDNA processing uses `tr46@6.0.0` with Unicode 17.0.0 data. Its vendored source,
generator, checksums, and license are in `tools/vendor/tr46-6.0.0`.

Punycode encoding and decoding use `punycode@2.3.1`. `punycode.ts` preserves
the upstream algorithm and captures the intrinsic methods it calls so later
Guest mutation cannot change endpoint normalization. The upstream ES module's SHA-256 is
`8969ae1b78644a33574be197d1a7a9c85b031092f1c1a657d865b7b3c1edd77e`,
and the tarball SHA-256 is
`e4ce59f9fbac44349abab87279ab658f6b4614916bec5e088ae3be9323e193bb`.

The retained third-party notices are in `LICENSES.md`.

## Size and heap probe

The minified browser-target ESM for `http-url.ts` is 181,150 bytes. In the
current HTTP SDK bundle, including this module adds 181,018 bytes (236,550
bytes with the URL module versus 55,532 bytes with that module externalized).

`tests/fixtures/http-url-quickjs-entry.ts` and
`tests/fixtures/http-url-quickjs-memory.c` provide a reproducible QuickJS-ng
0.14.0 allocator probe. The macOS host build of the same QuickJS-ng sources
vendored by the ESP-IDF component measured:

- 290,825 bytes retained after loading the 181,345-byte minified probe IIFE;
- 529,310 bytes peak above an empty runtime while parsing/loading that source;
- 312 bytes retained by the first normalization warmup;
- 18,935 bytes steady-state peak for 64 sequential normalizations, including
  a 7.2-KiB serialized Unicode path;
- 7,242 bytes as the largest single operation allocation; and
- zero bytes retained by the measured steady-state operation after GC.

These host figures bound the JS object behavior but are not an ESP-IDF heap
measurement. The admission run must repeat the probe using the production
precompiled Guest artifact on ESP32-S3 and ESP32-P4.
