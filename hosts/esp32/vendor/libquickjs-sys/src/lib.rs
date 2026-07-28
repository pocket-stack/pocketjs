//! FFI Bindings for [quickjs](https://bellard.org/quickjs/)
#![no_std]
#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]

use core::option::Option;
#[cfg(not(target_arch = "xtensa"))]
use libc;

// `libc` intentionally exposes no C aliases for an unknown bare-metal target.
// The ESP Rust target still has a normal C ABI supplied by ESP-IDF/newlib, so
// use core's target-correct aliases while keeping the public bindings intact.
#[cfg(target_arch = "xtensa")]
mod libc {
    pub use core::ffi::{c_char, c_int, c_uint, c_void};
}

// C `size_t` on the 32-bit mipsel-sony-psp (ILP32) target is `unsigned int`
// (32-bit) == Rust `usize`. NOTE: `libc::c_ulong` resolves to 64-bit here, which
// silently breaks the MIPS o32 ABI for `size_t` arguments (a 64-bit arg is read
// from the even register pair $a2:$a3 instead of $a1), so it must be `usize`.
pub type size_t = usize;

/// QuickJS uses NaN boxing on 32-bit targets by default. Vita opts out so the
/// ARM AAPCS sees the same portable, 16-byte tagged representation on both
/// sides of every FFI call.
#[cfg(all(target_pointer_width = "32", not(target_os = "vita")))]
pub type JSValue = u64;

#[cfg(any(target_pointer_width = "64", target_os = "vita"))]
#[repr(C)]
#[derive(Copy, Clone)]
pub union JSValueUnion {
    pub uint64: u64,
    pub int32: i32,
    pub float64: f64,
    pub ptr: *mut libc::c_void,
}

#[cfg(any(target_pointer_width = "64", target_os = "vita"))]
#[repr(C)]
#[derive(Copy, Clone)]
pub struct JSValue {
    pub u: JSValueUnion,
    pub tag: i64,
}

#[cfg(any(target_pointer_width = "64", target_os = "vita"))]
const _: [(); 16] = [(); core::mem::size_of::<JSValue>()];

#[cfg(any(target_pointer_width = "64", target_os = "vita"))]
const _: [(); 8] = [(); core::mem::align_of::<JSValue>()];

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct JSRuntime {
    _unused: [u8; 0],
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct JSContext {
    _unused: [u8; 0],
}

pub type JSAtom = u32;

pub type JSCFunctionEnum = libc::c_uint;

pub type JSCFunction = Option<
    unsafe extern "C" fn(
        ctx: *mut JSContext,
        this_val: JSValue,
        argc: libc::c_int,
        argv: *mut JSValue,
    ) -> JSValue,
>;

pub type JSCFunctionMagic = Option<
    unsafe extern "C" fn(
        ctx: *mut JSContext,
        this_val: JSValue,
        argc: libc::c_int,
        argv: *mut JSValue,
        magic: libc::c_int,
    ) -> JSValue,
>;

pub const JS_EVAL_TYPE_GLOBAL: u32 = 0;

extern "C" {
    fn JS_ValueGetTag_real(v: JSValue) -> i32;
    fn JS_DupValue_real(ctx: *mut JSContext, v: JSValue);
    fn JS_DupValueRT_real(rt: *mut JSRuntime, v: JSValue);
    fn JS_FreeValue_real(ctx: *mut JSContext, v: JSValue);
    fn JS_FreeValueRT_real(rt: *mut JSRuntime, v: JSValue);
    fn JS_NewBool_real(ctx: *mut JSContext, v: bool) -> JSValue;
    fn JS_NewInt32_real(ctx: *mut JSContext, v: i32) -> JSValue;
    fn JS_NewFloat64_real(ctx: *mut JSContext, v: f64) -> JSValue;
    fn JS_VALUE_IS_NAN_real(v: JSValue) -> bool;
    fn JS_VALUE_GET_FLOAT64_real(v: JSValue) -> f64;
    fn JS_VALUE_GET_NORM_TAG_real(v: JSValue) -> libc::c_int;
    fn JS_IsNumber_real(v: JSValue) -> bool;
    fn JS_IsBigInt_real(ctx: *mut JSContext, v: JSValue) -> bool;
    fn JS_IsBigFloat_real(v: JSValue) -> bool;
    fn JS_IsBigDecimal_real(v: JSValue) -> bool;
    fn JS_IsBool_real(v: JSValue) -> bool;
    fn JS_IsNull_real(v: JSValue) -> bool;
    fn JS_IsUndefined_real(v: JSValue) -> bool;
    fn JS_IsException_real(v: JSValue) -> bool;
    fn JS_IsUninitialized_real(v: JSValue) -> bool;
    fn JS_IsString_real(v: JSValue) -> bool;
    fn JS_IsSymbol_real(v: JSValue) -> bool;
    fn JS_IsObject_real(v: JSValue) -> bool;
    fn JS_ToUint32_real(ctx: *mut JSContext, pres: u32, val: JSValue) -> u32;
    fn JS_SetProperty_real(
        ctx: *mut JSContext,
        this_obj: JSValue,
        prop: JSAtom,
        val: JSValue,
    ) -> libc::c_int;
    fn JS_NewCFunction_real(
        ctx: *mut JSContext,
        func: *mut JSCFunction,
        name: *const libc::c_char,
        length: libc::c_int,
    ) -> JSValue;
    fn JS_NewCFunctionMagic_real(
        ctx: *mut JSContext,
        func: *mut JSCFunctionMagic,
        name: *const libc::c_char,
        length: libc::c_int,
        cproto: JSCFunctionEnum,
        magic: libc::c_int,
    ) -> JSValue;
}

pub unsafe fn JS_ValueGetTag(v: JSValue) -> i32 {
    JS_ValueGetTag_real(v)
}

/// Increment the refcount of this value
pub unsafe fn JS_DupValue(ctx: *mut JSContext, v: JSValue) {
    JS_DupValue_real(ctx, v);
}

/// Increment the refcount of this value
pub unsafe fn JS_DupValueRT(rt: *mut JSRuntime, v: JSValue) {
    JS_DupValueRT_real(rt, v);
}

/// Decrement the refcount of this value
pub unsafe fn JS_FreeValue(ctx: *mut JSContext, v: JSValue) {
    JS_FreeValue_real(ctx, v);
}

/// Decrement the refcount of this value
pub unsafe fn JS_FreeValueRT(rt: *mut JSRuntime, v: JSValue) {
    JS_FreeValueRT_real(rt, v);
}

/// create a new boolean value
pub unsafe fn JS_NewBool(ctx: *mut JSContext, v: bool) -> JSValue {
    JS_NewBool_real(ctx, v)
}

/// create a new int32 value
pub unsafe fn JS_NewInt32(ctx: *mut JSContext, v: i32) -> JSValue {
    JS_NewInt32_real(ctx, v)
}

/// create a new f64 value, please note that if the passed f64 fits in a i32 this will return a value with flag 0 (i32)
pub unsafe fn JS_NewFloat64(ctx: *mut JSContext, v: f64) -> JSValue {
    JS_NewFloat64_real(ctx, v)
}

/// check if a JSValue is a NaN value
pub unsafe fn JS_VALUE_IS_NAN(v: JSValue) -> bool {
    JS_VALUE_IS_NAN_real(v)
}

/// get a f64 value from a JSValue
pub unsafe fn JS_VALUE_GET_FLOAT64(v: JSValue) -> f64 {
    JS_VALUE_GET_FLOAT64_real(v)
}

/// same as JS_VALUE_GET_TAG, but return JS_TAG_FLOAT64 with NaN boxing
pub unsafe fn JS_VALUE_GET_NORM_TAG(v: JSValue) -> libc::c_int {
    JS_VALUE_GET_NORM_TAG_real(v)
}

/// check if a JSValue is a Number
pub unsafe fn JS_IsNumber(v: JSValue) -> bool {
    JS_IsNumber_real(v)
}

/// check if a JSValue is a BigInt
pub unsafe fn JS_IsBigInt(ctx: *mut JSContext, v: JSValue) -> bool {
    JS_IsBigInt_real(ctx, v)
}

/// check if a JSValue is a BigFloat
pub unsafe fn JS_IsBigFloat(v: JSValue) -> bool {
    JS_IsBigFloat_real(v)
}

/// check if a JSValue is a BigDecimal
pub unsafe fn JS_IsBigDecimal(v: JSValue) -> bool {
    JS_IsBigDecimal_real(v)
}

/// check if a JSValue is a Boolean
pub unsafe fn JS_IsBool(v: JSValue) -> bool {
    JS_IsBool_real(v)
}

/// check if a JSValue is null
pub unsafe fn JS_IsNull(v: JSValue) -> bool {
    JS_IsNull_real(v)
}

/// check if a JSValue is Undefined
pub unsafe fn JS_IsUndefined(v: JSValue) -> bool {
    JS_IsUndefined_real(v)
}

/// check if a JSValue is an Exception
pub unsafe fn JS_IsException(v: JSValue) -> bool {
    JS_IsException_real(v)
}

/// check if a JSValue is initialized
pub unsafe fn JS_IsUninitialized(v: JSValue) -> bool {
    JS_IsUninitialized_real(v)
}

/// check if a JSValue is a String
pub unsafe fn JS_IsString(v: JSValue) -> bool {
    JS_IsString_real(v)
}

/// check if a JSValue is a Symbol
pub unsafe fn JS_IsSymbol(v: JSValue) -> bool {
    JS_IsSymbol_real(v)
}

/// check if a JSValue is an Object
pub unsafe fn JS_IsObject(v: JSValue) -> bool {
    JS_IsObject_real(v)
}

/// get a u32 value from a JSValue
pub unsafe fn JS_ToUint32(ctx: *mut JSContext, pres: u32, val: JSValue) -> u32 {
    JS_ToUint32_real(ctx, pres, val)
}

/// set a property of an object identified by a JSAtom
pub unsafe fn JS_SetProperty(
    ctx: *mut JSContext,
    this_obj: JSValue,
    prop: JSAtom,
    val: JSValue,
) -> libc::c_int {
    JS_SetProperty_real(ctx, this_obj, prop, val)
}

/// create a new Function based on a JSCFunction
pub unsafe fn JS_NewCFunction(
    ctx: *mut JSContext,
    func: *mut JSCFunction,
    name: *const libc::c_char,
    length: libc::c_int,
) -> JSValue {
    JS_NewCFunction_real(ctx, func, name, length)
}

/// create a new Function based on a JSCFunction
pub unsafe fn JS_NewCFunctionMagic(
    ctx: *mut JSContext,
    func: *mut JSCFunctionMagic,
    name: *const libc::c_char,
    length: libc::c_int,
    cproto: JSCFunctionEnum,
    magic: libc::c_int,
) -> JSValue {
    JS_NewCFunctionMagic_real(ctx, func, name, length, cproto, magic)
}

extern "C" {
    pub fn JS_NewRuntime() -> *mut JSRuntime;
}

extern "C" {
    pub fn JS_NewContext(rt: *mut JSRuntime) -> *mut JSContext;
}

extern "C" {
    pub fn debug_log(msg: *const libc::c_char, a: i32);
}

extern "C" {
    pub fn JS_Eval(
        ctx: *mut JSContext,
        input: *const libc::c_char,
        input_len: usize,
        filename: *const libc::c_char,
        eval_flags: libc::c_int,
    ) -> JSValue;
}

// --- Additional real (non-inline) exported QuickJS symbols ---
// Needed to bridge native Rust functions into JS and to drive a per-frame loop.
// All verified present in the compiled libquickjs.a for mipsel-sony-psp.
extern "C" {
    pub fn JS_FreeContext(ctx: *mut JSContext);
    pub fn JS_FreeRuntime(rt: *mut JSRuntime);

    pub fn JS_GetGlobalObject(ctx: *mut JSContext) -> JSValue;
    pub fn JS_NewObject(ctx: *mut JSContext) -> JSValue;

    pub fn JS_GetPropertyStr(
        ctx: *mut JSContext,
        this_obj: JSValue,
        prop: *const libc::c_char,
    ) -> JSValue;
    pub fn JS_SetPropertyStr(
        ctx: *mut JSContext,
        this_obj: JSValue,
        prop: *const libc::c_char,
        val: JSValue,
    ) -> libc::c_int;

    /// cproto: JS_CFUNC_generic = 0
    pub fn JS_NewCFunction2(
        ctx: *mut JSContext,
        func: JSCFunction,
        name: *const libc::c_char,
        length: libc::c_int,
        cproto: JSCFunctionEnum,
        magic: libc::c_int,
    ) -> JSValue;

    pub fn JS_Call(
        ctx: *mut JSContext,
        func_obj: JSValue,
        this_obj: JSValue,
        argc: libc::c_int,
        argv: *mut JSValue,
    ) -> JSValue;
    pub fn JS_ReadObject(
        ctx: *mut JSContext,
        buf: *const u8,
        buf_len: size_t,
        flags: libc::c_int,
    ) -> JSValue;
    pub fn JS_EvalFunction(ctx: *mut JSContext, fun_obj: JSValue) -> JSValue;

    pub fn JS_ToInt32(ctx: *mut JSContext, pres: *mut i32, val: JSValue) -> libc::c_int;
    pub fn JS_ToFloat64(ctx: *mut JSContext, pres: *mut f64, val: JSValue) -> libc::c_int;

    pub fn JS_GetException(ctx: *mut JSContext) -> JSValue;
    pub fn JS_ToCStringLen2(
        ctx: *mut JSContext,
        plen: *mut size_t,
        val: JSValue,
        cesu8: libc::c_int,
    ) -> *const libc::c_char;
    pub fn JS_FreeCString(ctx: *mut JSContext, ptr: *const libc::c_char);

    /// Borrow the backing bytes of an ArrayBuffer. `psize` receives the byte
    /// length; the returned pointer is owned by QuickJS (GC-movable) — copy out
    /// immediately, never retain it. Used by the 3D host (gfx3d.rs) to read mesh
    /// + command buffers handed down from JS.
    pub fn JS_GetArrayBuffer(ctx: *mut JSContext, psize: *mut size_t, obj: JSValue) -> *mut u8;
}

/// Custom allocator hooks so QuickJS can use the host (Rust/PSP) allocator
/// instead of newlib malloc (which has no heap under rust-psp's startup).
#[repr(C)]
pub struct JSMallocState {
    pub malloc_count: size_t,
    pub malloc_size: size_t,
    pub malloc_limit: size_t,
    pub opaque: *mut libc::c_void,
}

#[repr(C)]
pub struct JSMallocFunctions {
    pub js_malloc:
        Option<unsafe extern "C" fn(s: *mut JSMallocState, size: size_t) -> *mut libc::c_void>,
    pub js_free: Option<unsafe extern "C" fn(s: *mut JSMallocState, ptr: *mut libc::c_void)>,
    pub js_realloc: Option<
        unsafe extern "C" fn(
            s: *mut JSMallocState,
            ptr: *mut libc::c_void,
            size: size_t,
        ) -> *mut libc::c_void,
    >,
    pub js_malloc_usable_size: Option<unsafe extern "C" fn(ptr: *const libc::c_void) -> size_t>,
}

extern "C" {
    pub fn JS_NewRuntime2(
        mf: *const JSMallocFunctions,
        opaque: *mut libc::c_void,
    ) -> *mut JSRuntime;
}

/// JS_CFUNC_generic
pub const JS_CFUNC_generic: JSCFunctionEnum = 0;
pub const JS_READ_OBJ_BYTECODE: libc::c_int = 1 << 0;

/// JSValue tag for `undefined` (JS_TAG_UNDEFINED = 3).
pub const JS_TAG_UNDEFINED: i32 = 3;
/// JSValue tag for an exception (JS_TAG_EXCEPTION = 6).
pub const JS_TAG_EXCEPTION: i32 = 6;

/// `JS_UNDEFINED` constructed via the NaN-boxing JS_MKVAL layout:
/// `(tag << 32) | val`. Non-refcounted, never needs freeing.
#[cfg(all(target_pointer_width = "32", not(target_os = "vita")))]
pub const JS_UNDEFINED: JSValue = (JS_TAG_UNDEFINED as u64) << 32;

/// `JS_UNDEFINED` in QuickJS's portable tagged representation.
#[cfg(any(target_pointer_width = "64", target_os = "vita"))]
pub const JS_UNDEFINED: JSValue = JSValue {
    u: JSValueUnion { uint64: 0 },
    tag: JS_TAG_UNDEFINED as i64,
};

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;

    #[test]
    fn evaluates_number_through_ffi() {
        unsafe {
            let runtime = JS_NewRuntime();
            assert!(!runtime.is_null());

            let context = JS_NewContext(runtime);
            assert!(!context.is_null());

            let source = b"40 + 2\0";
            let filename = b"ffi-test.js\0";
            let value = JS_Eval(
                context,
                source.as_ptr().cast(),
                source.len() - 1,
                filename.as_ptr().cast(),
                JS_EVAL_TYPE_GLOBAL as libc::c_int,
            );

            if JS_IsException(value) {
                let exception = JS_GetException(context);
                let message_ptr = JS_ToCStringLen2(context, core::ptr::null_mut(), exception, 0);
                assert!(!message_ptr.is_null());
                let message = std::ffi::CStr::from_ptr(message_ptr)
                    .to_string_lossy()
                    .into_owned();
                JS_FreeCString(context, message_ptr);
                JS_FreeValue(context, exception);
                panic!("unexpected QuickJS exception: {}", message);
            }
            let mut result = 0.0;
            assert_eq!(JS_ToFloat64(context, &mut result, value), 0);
            assert_eq!(result, 42.0);
            assert!(JS_IsUndefined(JS_UNDEFINED));

            JS_FreeValue(context, value);
            JS_FreeContext(context);
            JS_FreeRuntime(runtime);
        }
    }
}
