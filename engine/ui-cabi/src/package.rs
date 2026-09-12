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

use core::ffi::{c_char, CStr};
use pocketjs_core::plan::{validate_plan, PlanError, SurfaceContract, TargetContract};

/// The host's target contract, laid out as engine/ui-cabi/include/pocket_package.h
/// declares it and as tools/target-contract.ts generates it.
#[repr(C)]
pub struct PocketTargetContract {
    target: *const c_char,
    host_abi: u32,
    logical_width: u32,
    logical_height: u32,
    physical_width: u32,
    physical_height: u32,
    raster_density: u32,
    presentation: *const c_char,
    capabilities: *const *const c_char,
    capability_count: usize,
    auxiliary_logical_width: u32,
    auxiliary_logical_height: u32,
    auxiliary_physical_width: u32,
    auxiliary_physical_height: u32,
    auxiliary_raster_density: u32,
    /// NULL when the host presents no auxiliary surface.
    auxiliary_presentation: *const c_char,
    host_extension: u32,
}

unsafe fn c_text<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

/// Admit a plan section for this host. 0 = the plan matches the contract;
/// 1 syntax, 2 target, 3 host ABI, 4 viewport, 5 presentation, 6 surfaces,
/// 7 host extension, 8 features, 12 invalid arguments.
#[no_mangle]
pub unsafe extern "C" fn pocket_package_validate_plan(
    plan: *const u8,
    len: usize,
    contract: *const PocketTargetContract,
) -> i32 {
    if plan.is_null() || len == 0 || contract.is_null() {
        return 12;
    }
    let contract = &*contract;
    let (Some(target), Some(presentation)) = (c_text(contract.target), c_text(contract.presentation)) else {
        return 12;
    };
    if contract.capabilities.is_null() && contract.capability_count != 0 {
        return 12;
    }
    let mut capabilities = alloc::vec::Vec::with_capacity(contract.capability_count);
    for index in 0..contract.capability_count {
        match c_text(*contract.capabilities.add(index)) {
            Some(id) => capabilities.push(id),
            None => return 12,
        }
    }
    let auxiliary = if contract.auxiliary_presentation.is_null() {
        None
    } else {
        match c_text(contract.auxiliary_presentation) {
            Some(presentation) => Some(SurfaceContract {
                logical: [contract.auxiliary_logical_width, contract.auxiliary_logical_height],
                physical: [contract.auxiliary_physical_width, contract.auxiliary_physical_height],
                raster_density: contract.auxiliary_raster_density,
                presentation,
            }),
            None => return 12,
        }
    };
    let contract = TargetContract {
        target,
        host_abi: contract.host_abi,
        primary: SurfaceContract {
            logical: [contract.logical_width, contract.logical_height],
            physical: [contract.physical_width, contract.physical_height],
            raster_density: contract.raster_density,
            presentation,
        },
        auxiliary,
        capabilities: &capabilities,
        host_extension: contract.host_extension != 0,
    };
    match validate_plan(core::slice::from_raw_parts(plan, len), &contract) {
        Ok(()) => 0,
        Err(PlanError::Syntax) => 1,
        Err(PlanError::Target) => 2,
        Err(PlanError::HostAbi) => 3,
        Err(PlanError::Viewport) => 4,
        Err(PlanError::Presentation) => 5,
        Err(PlanError::Surfaces) => 6,
        Err(PlanError::HostExtension) => 7,
        Err(PlanError::Features) => 8,
    }
}
