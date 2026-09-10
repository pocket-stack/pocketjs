//! Borrowed `.pocket` admission for filesystem-loading C hosts.
use pocketjs_core::package::{select_guest, GuestError, PackageError};

#[repr(C)]
pub struct PocketGuestPackage {
    javascript: *const u8,
    javascript_length: usize,
    pak: *const u8,
    pak_length: usize,
    plan: *const u8,
    plan_length: usize,
    package_hash: u64,
    variant_hash: u64,
}

/// The caller retains the input bytes until the guest has shut down.
/// Error numbers match the 3DS package ABI.
#[no_mangle]
pub unsafe extern "C" fn pocket_package_open(
    ptr: *const u8,
    len: usize,
    target: *const u8,
    target_len: usize,
    host_abi: u32,
    out: *mut PocketGuestPackage,
) -> i32 {
    if ptr.is_null() || len == 0 || target.is_null() || target_len == 0 || out.is_null() {
        return 12;
    }
    let target = match core::str::from_utf8(core::slice::from_raw_parts(target, target_len)) {
        Ok(value) if !value.is_empty() => value,
        _ => return 12,
    };
    match select_guest(
        core::slice::from_raw_parts(ptr, len),
        target,
        host_abi,
        false,
    ) {
        Ok(guest) => {
            out.write(PocketGuestPackage {
                javascript: guest.js.as_ptr(),
                javascript_length: guest.js.len(),
                pak: guest.pak.as_ptr(),
                pak_length: guest.pak.len(),
                plan: guest.plan.as_ptr(),
                plan_length: guest.plan.len(),
                package_hash: guest.package_hash,
                variant_hash: guest.variant_hash,
            });
            0
        }
        Err(error) => match error {
            GuestError::Package(PackageError::Truncated) => 1,
            GuestError::Package(PackageError::BadMagic) => 2,
            GuestError::Package(PackageError::BadVersion) => 3,
            GuestError::Package(PackageError::HashMismatch) => 4,
            GuestError::Package(PackageError::BadUtf8) => 5,
            GuestError::MissingVariant => 6,
            GuestError::HostAbiMismatch => 7,
            GuestError::MissingIdentity => 8,
            GuestError::MissingPlan => 9,
            GuestError::MissingJavaScript => 10,
            GuestError::JavaScriptNotTerminated => 11,
        },
    }
}
