# libquickjs_sys - Changelog


## v0.10.0 - 2021-08-09

* Upgraded to quickjs version `2021-03-27`
* Added `JS_ValueGetTag`

## v0.9.0 - 2021-02-04

* Upgraded to quickjs version `2020-11-08`
* Added wrappers to expose various QuickJS functions that are `inline static`
* Always compile with -fPIC

## v0.8.0 - 2020-09-29

Upgraded to quickjs version `2020-09-06`.

* Added
  - JS_SetIsHTMLDDA
  - JS_GetScriptOrModuleName
  - JS_RunModule
  - Multiple new constants, including `JS_ATOM_NULL`

JS_SetIsHTMLDDA

## v0.7.0 - 2020-07-09

Upgraded to quickjs version `2020-07-05`.

* Added
  - JS_ParseJSON2
  - JSSharedArrayBufferFunctions
  - JS_WriteObject2
  - JS_SetSharedArrayBufferFunctions
  - JS_WriteObject2
  - JS_SetSharedArrayBufferFunctions
  - JS_PARSE_JSON_EXT
  - JS_WRITE_OBJ_SAB
  - JS_WRITE_OBJ_REFERENCE
  - JS_READ_OBJ_SAB
  - JS_READ_OBJ_REFERENCE

## v0.6.0 - 2020-05-25

Upgraded to quickjs version `2020-04-12`.

* Lot's of changes from `usize` to `size_t`.

## v0.5.0 - 2020-03-24

Upgraded to version `2020-03-16`:

- Added functions `JS_GetRuntimeOpaque`, `JS_SetRuntimeOpaque`
- Removed function `JS_NewInt64`, JS_ToInt64Ext

## v0.4.0 - 2019-11-02

Upgraded to version `2019-09-18`:

* Added `JS_ValueToAtom`
* Added `JS_SetConstructor`
* `JS_GetTypedArrayBuffer`

Updated bindgen dependency to 0.51.

## v0.3.0 - 2019-08-13

* Added `patched` feature for applying patches
* Added patch stack-overflow-signed to fix stackoverflow due invalid cast

* c_int changed to usize in JS_NewAtomLen/JS_NewStringLen
* JS_ToCStringLen2 replaces JS_ToCStringLen 
* Added JS_GetOwnProperty(Names) functions

## v0.2.0 - 2019-07-31

* Updated embedded bindings to version 2019-07-28
    - `JS_EVAL_FLAG_SHEBANG` constant was removed
    - `JS_NewPromiseCallback` was added
