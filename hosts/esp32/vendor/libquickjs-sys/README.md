# libquickjs-sys

FFI Bindings for [quickjs](https://bellard.org/quickjs/), a Javascript engine.

See the [quick](https://crates.io/crates/quickjs) crate for a high-level
wrapper.


*Version 0.9.0*
**Embedded VERSION: 2021-03-27**

## Embedded vs system

By default, an embedded version of quickjs is used.

If you want to use a version installed on your system, use:


```toml
libquickjs-sys = { version = "...", default-features = false, features = ["system"] }
```

## PlayStation Vita

The bundled engine supports Rust's `armv7-sony-vita-newlibeabihf` target with
[VitaSDK](https://vitasdk.org/) on `PATH`. Because the target is a nightly
Tier 3 target, build its standard library from source:

```bash
export VITASDK="$HOME/vitasdk"
export PATH="$VITASDK/bin:$PATH"
export CC_armv7_sony_vita_newlibeabihf=arm-vita-eabi-gcc
export AR_armv7_sony_vita_newlibeabihf=arm-vita-eabi-ar
export CARGO_TARGET_ARMV7_SONY_VITA_NEWLIBEABIHF_LINKER=arm-vita-eabi-gcc

cargo +nightly build -p libquickjs-sys \
  --target armv7-sony-vita-newlibeabihf \
  -Z build-std=std,panic_abort \
  --release
```


## Updating the embedded bindings

QuickJS sources and a pre-generated `bindings.rs` are included in the repo.

They are used if the `embedded` feature is enabled.

To updat the bindings, follow these steps:

* (Install [just](https://github.com/casey/just))
* Update the download URL in ./justfile
* run `just update-quickjs`
