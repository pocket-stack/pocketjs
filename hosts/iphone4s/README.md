# PocketJS iPhone 4S host

This host targets the exact `iPhone4,1` / iOS 6.1.3 / `10B329` hardware tuple.
It compiles the shared legacy UIKit runtime for ARMv7 and links it against a
local sysroot extracted from the operator-provided, validated restore image.
Apple system binaries are never committed or included in the npm package.

Use `bun iphone4s doctor`, `bun iphone4s prepare-sysroot`, and then the build,
deploy, launch, status, and capture commands documented in `docs/IPHONE4S.md`.
