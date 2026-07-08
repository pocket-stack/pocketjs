# @pocketjs/cli

The [PocketJS](https://pocketjs.dev) toolchain CLI — `doctor`/`setup` for the
bun + Rust + PSP toolchain (flutter-doctor style), app scaffolding, and
build/run passthrough.

```sh
npm install -g @pocketjs/cli

pocketjs doctor            # diagnose bun / Rust / PSP toolchain / PSPLINK
pocketjs setup             # install what doctor found missing
pocketjs create my-app     # scaffold demos/my-app in a PocketJS checkout
pocketjs dev my-app-main   # build + serve in the browser
pocketjs psp my-app        # build the PSP EBOOT
pocketjs hw my-app         # build + run on a real PSP over PSPLINK
pocketjs psplink           # interactive multi-app switcher on a real PSP
pocketjs devtools my-app   # DevTools panel + USB debug bridge, one command
pocketjs tape replay …     # record / replay / inspect input tapes headlessly
```

`create`, `dev`, `build`, `psp`, `hw`, `psplink`, `devtools` and `tape` run inside a PocketJS
checkout (the CLI finds it by walking up from the current directory):

```sh
git clone https://github.com/pocket-stack/pocketjs
cd pocketjs && bun install
pocketjs doctor
```

Only Node ≥ 18 is required for the CLI itself; everything it diagnoses or
installs is for building PocketJS apps. See the
[repository](https://github.com/pocket-stack/pocketjs) and
[pocketjs.dev](https://pocketjs.dev) for the framework docs.
