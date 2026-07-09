//! Read-only .pak walker — desktop port of `native/src/pak.rs` (container
//! format pinned in spec.ts "PAK container constants", generated into
//! `pocketjs_core::spec::pak`). Malformed packs/entries are skipped, never
//! fatal, matching the PSP walker's contract.

use pocketjs_core::spec;

/// One named blob from a pak.
pub struct PakEntry<'a> {
    pub key: &'a str,
    pub blob: &'a [u8],
}

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

/// The blob for `key`, or None for absent keys (same tolerance for
/// malformed packs as the walk).
pub fn find_pak<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    walk_pak(pak).into_iter().find(|e| e.key == key).map(|e| e.blob)
}

/// Iterate every well-formed entry in `pak`.
pub fn walk_pak(pak: &[u8]) -> Vec<PakEntry<'_>> {
    let mut out = Vec::new();
    let ok = rd_u32(pak, 0) == Some(spec::pak::MAGIC) && rd_u16(pak, 4) == Some(spec::pak::VERSION);
    if !ok {
        return out;
    }
    let (Some(count), Some(dir_off), Some(names_off)) =
        (rd_u32(pak, 8), rd_u32(pak, 12), rd_u32(pak, 16))
    else {
        return out;
    };
    // Clamp the walk to what the pack can actually hold (corrupt count words
    // must not stall the host).
    let count =
        (count as usize).min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    for i in 0..count {
        let e = dir_off as usize + i * spec::pak::ENTRY_SIZE;
        let (Some(blob_off), Some(blob_len), Some(name_off), Some(name_len)) = (
            rd_u32(pak, e + 4),
            rd_u32(pak, e + 8),
            rd_u32(pak, e + 12),
            rd_u16(pak, e + 16),
        ) else {
            continue;
        };
        let ns = names_off as usize + name_off as usize;
        let (Some(name_bytes), Some(blob)) = (
            pak.get(ns..ns + name_len as usize),
            pak.get(blob_off as usize..blob_off as usize + blob_len as usize),
        ) else {
            continue;
        };
        let Ok(key) = core::str::from_utf8(name_bytes) else {
            continue;
        };
        out.push(PakEntry { key, blob });
    }
    out
}
