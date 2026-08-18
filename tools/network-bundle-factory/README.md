# Network bundle factory

`tools/build.ts --network-factory` emits an artifact whose evaluation returns a
one-argument factory. **Evaluation does not run the application bundle.** The
Host calls the factory with its frozen private network binding table; only that
call starts the original IIFE. The binding remains lexical and is never written
to `globalThis`.

The option is accepted only with a checksummed `ResolvedBuildPlan` containing
network admission. A network plan without the option, or the option without a
network plan, fails the build. The factory is consumed by its first call,
including a call that supplies an invalid argument or whose application
initializer throws. A fresh attempt requires evaluating the artifact again.
After a successful initializer the generated factory returns `undefined`;
loaders observe the installed runtime/frame checkpoints instead of treating the
original IIFE's completion value as an artifact ABI.

**The experimental ESP-IDF Guest loader is currently the only implemented
factory consumer.** Stock target profiles do not advertise ESP network
capabilities, and the normal PSP, Vita, web, Apple, Symbian, and iPhone loaders
still consume the unchanged IIFE artifact. Formal target registration and
loader wiring remain staged behind network conformance.
