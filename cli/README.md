# @pocketjs/cli

The [PocketJS](https://pocketjs.dev) toolchain CLI — `doctor`/`setup` for the
bun + Rust + PSP toolchain (flutter-doctor style), app scaffolding, and
build/run passthrough.

```sh
npm install -g @pocketjs/cli

pocket doctor            # diagnose bun / Rust / PSP toolchain / PSPLINK
pocket setup             # install what doctor found missing
pocket create my-app     # scaffold demos/my-app in a PocketJS checkout
pocket dev my-app-main   # build + serve in the browser
pocket psp my-app        # build the PSP EBOOT
pocket hw my-app         # build + run on a real PSP over PSPLINK
pocket psplink           # interactive multi-app switcher on a real PSP
pocket devtools my-app   # DevTools panel + USB debug bridge, one command
pocket tape replay …     # record / replay / inspect input tapes headlessly
```

`create`, `dev`, `build`, `psp`, `hw`, `psplink`, `devtools` and `tape` run inside a PocketJS
checkout (the CLI finds it by walking up from the current directory):

```sh
git clone https://github.com/pocket-stack/pocketjs
cd pocketjs && bun install
pocket doctor
```

Only Node ≥ 18 is required for the CLI itself; everything it diagnoses or
installs is for building PocketJS apps. See the
[repository](https://github.com/pocket-stack/pocketjs) and
[pocketjs.dev](https://pocketjs.dev) for the framework docs.
