//! `.pocket` package reader — the device side of the container format.
//! spec/pocket-package.ts is the format authority; both implementations are
//! pinned to the SAME committed fixture (test/fixtures/packages/), so they
//! cannot drift apart silently.
//!
//! Zero-copy by design: every accessor returns borrowed slices of the input
//! bytes. An EBOOT embeds `.pocket` files verbatim in .rodata and boots a
//! guest straight out of them — the js section carries its QuickJS NUL
//! terminator (eval with len - 1), the pak section feeds pak::feed as-is.

use core::str;

pub const MAGIC: u32 = 0x544b_4350; // "PCKT"
pub const VERSION: u32 = 1;
const HEADER_SIZE: usize = 16;
const VARIANT_SIZE: usize = 40;
const SECTION_SIZE: usize = 16;
const TARGET_BYTES: usize = 16;
const ALIGN: usize = 16;

/// Section kinds (append-only; skip what you do not know).
pub mod section {
    pub const IDENTITY: u32 = 1;
    pub const PLAN: u32 = 2;
    pub const JS: u32 = 3;
    pub const PAK: u32 = 4;
    pub const COVER: u32 = 5;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    Truncated,
    BadMagic,
    BadVersion,
    HashMismatch,
    BadUtf8,
}

#[derive(Debug)]
pub struct Package<'a> {
    bytes: &'a [u8],
    manifest_len: usize,
    variant_count: usize,
    table_off: usize,
}

#[derive(Clone, Copy)]
pub struct Variant<'a> {
    bytes: &'a [u8],
    pub target: &'a str,
    pub host_abi: u32,
    pub variant_hash: u64,
    section_count: usize,
    sections_off: usize,
}

pub struct Identity<'a> {
    pub output: &'a str,
    pub id: &'a str,
    pub title: &'a str,
}

fn u32_at(bytes: &[u8], off: usize) -> Result<u32, PackageError> {
    let s = bytes.get(off..off + 4).ok_or(PackageError::Truncated)?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn u64_at(bytes: &[u8], off: usize) -> Result<u64, PackageError> {
    let s = bytes.get(off..off + 8).ok_or(PackageError::Truncated)?;
    Ok(u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

/// FNV-1a64, lockstep with scripts/bundle-hash.ts / native/build.rs.
pub fn fnv1a64(chunks: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for chunk in chunks {
        for &b in *chunk {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

impl<'a> Package<'a> {
    /// Parse and (unless `skip_hash`) verify the footer hash. Embedded
    /// packages were hashed at build time — boot paths pass `skip_hash =
    /// true` and rely on the EBOOT's own build identity; filesystem loads
    /// (dynamic install) MUST verify.
    pub fn parse(bytes: &'a [u8], skip_hash: bool) -> Result<Self, PackageError> {
        if bytes.len() < HEADER_SIZE + 8 {
            return Err(PackageError::Truncated);
        }
        if u32_at(bytes, 0)? != MAGIC {
            return Err(PackageError::BadMagic);
        }
        if u32_at(bytes, 4)? != VERSION {
            return Err(PackageError::BadVersion);
        }
        if !skip_hash {
            let stored = u64_at(bytes, bytes.len() - 8)?;
            if stored != fnv1a64(&[&bytes[..bytes.len() - 8]]) {
                return Err(PackageError::HashMismatch);
            }
        }
        let manifest_len = u32_at(bytes, 8)? as usize;
        let variant_count = u32_at(bytes, 12)? as usize;
        let table_off = (HEADER_SIZE + manifest_len).div_ceil(ALIGN) * ALIGN;
        if table_off + variant_count * VARIANT_SIZE > bytes.len() {
            return Err(PackageError::Truncated);
        }
        Ok(Package { bytes, manifest_len, variant_count, table_off })
    }

    /// pocket.json bytes, verbatim.
    pub fn manifest(&self) -> &'a [u8] {
        &self.bytes[HEADER_SIZE..HEADER_SIZE + self.manifest_len]
    }

    pub fn variant_count(&self) -> usize {
        self.variant_count
    }

    pub fn variant(&self, index: usize) -> Result<Variant<'a>, PackageError> {
        if index >= self.variant_count {
            return Err(PackageError::Truncated);
        }
        let entry = self.table_off + index * VARIANT_SIZE;
        let name = self
            .bytes
            .get(entry..entry + TARGET_BYTES)
            .ok_or(PackageError::Truncated)?;
        let len = name.iter().position(|&b| b == 0).unwrap_or(TARGET_BYTES);
        let target = str::from_utf8(&name[..len]).map_err(|_| PackageError::BadUtf8)?;
        Ok(Variant {
            bytes: self.bytes,
            target,
            host_abi: u32_at(self.bytes, entry + 16)?,
            section_count: u32_at(self.bytes, entry + 20)? as usize,
            sections_off: u32_at(self.bytes, entry + 24)? as usize,
            variant_hash: u64_at(self.bytes, entry + 32)?,
        })
    }

    /// The variant for a target id, if the file carries one.
    pub fn find_variant(&self, target: &str) -> Result<Option<Variant<'a>>, PackageError> {
        for i in 0..self.variant_count {
            let v = self.variant(i)?;
            if v.target == target {
                return Ok(Some(v));
            }
        }
        Ok(None)
    }
}

impl<'a> Variant<'a> {
    /// A section payload by kind (unknown kinds are simply never asked for —
    /// forward compatible by construction).
    pub fn section(&self, kind: u32) -> Result<Option<&'a [u8]>, PackageError> {
        for i in 0..self.section_count {
            let entry = self.sections_off + i * SECTION_SIZE;
            if u32_at(self.bytes, entry)? == kind {
                let off = u32_at(self.bytes, entry + 8)? as usize;
                let len = u32_at(self.bytes, entry + 12)? as usize;
                return self
                    .bytes
                    .get(off..off + len)
                    .map(Some)
                    .ok_or(PackageError::Truncated);
            }
        }
        Ok(None)
    }

    /// The device registry line (kind 1) — output, id, title without any
    /// JSON parsing on the console.
    pub fn identity(&self) -> Result<Option<Identity<'a>>, PackageError> {
        let Some(bytes) = self.section(section::IDENTITY)? else {
            return Ok(None);
        };
        let mut off = 0usize;
        let mut fields = [""; 3];
        for slot in fields.iter_mut() {
            let len = bytes
                .get(off..off + 2)
                .map(|s| u16::from_le_bytes([s[0], s[1]]) as usize)
                .ok_or(PackageError::Truncated)?;
            off += 2;
            let raw = bytes.get(off..off + len).ok_or(PackageError::Truncated)?;
            *slot = str::from_utf8(raw).map_err(|_| PackageError::BadUtf8)?;
            off += len;
        }
        Ok(Some(Identity { output: fields[0], id: fields[1], title: fields[2] }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The SAME committed fixture test/pocket-package.test.ts byte-compares
    /// against the TS encoder — the cross-implementation contract.
    static FIXTURE: &[u8] = include_bytes!("../../test/fixtures/packages/synthetic.pocket");

    #[test]
    fn parses_the_shared_fixture() {
        let pkg = Package::parse(FIXTURE, false).unwrap();
        assert_eq!(pkg.variant_count(), 3);
        let targets: alloc::vec::Vec<&str> =
            (0..3).map(|i| pkg.variant(i).unwrap().target).collect();
        assert_eq!(targets, ["macos-widget", "psp", "vita"]);
        assert!(core::str::from_utf8(pkg.manifest()).unwrap().contains("synthetic"));

        let psp = pkg.find_variant("psp").unwrap().unwrap();
        assert_eq!(psp.host_abi, 1);
        let identity = psp.identity().unwrap().unwrap();
        assert_eq!(identity.output, "synthetic-main");
        assert_eq!(identity.title, "Synthetic");
        // The js section ends in the QuickJS NUL (zero-copy eval rule).
        let js = psp.section(section::JS).unwrap().unwrap();
        assert_eq!(*js.last().unwrap(), 0);
        // Target-flavored sections stay per-variant.
        assert_eq!(psp.section(section::PAK).unwrap().unwrap()[0], 10);
        let vita = pkg.find_variant("vita").unwrap().unwrap();
        assert_eq!(vita.section(section::PAK).unwrap().unwrap()[0], 20);
        let widget = pkg.find_variant("macos-widget").unwrap().unwrap();
        assert_eq!(widget.section(section::PAK).unwrap().unwrap()[0], 30);
        assert_eq!(widget.host_abi, 3);
    }

    #[test]
    fn tamper_trips_the_footer_hash() {
        let mut evil = FIXTURE.to_vec();
        let n = evil.len();
        evil[n - 20] ^= 0xff;
        assert_eq!(Package::parse(&evil, false).unwrap_err(), PackageError::HashMismatch);
        assert!(Package::parse(&evil, true).is_ok());
    }

    #[test]
    fn refuses_wrong_magic_and_truncation() {
        assert_eq!(Package::parse(&[0u8; 8], false).unwrap_err(), PackageError::Truncated);
        let mut bad = FIXTURE.to_vec();
        bad[0] ^= 0xff;
        assert_eq!(Package::parse(&bad, false).unwrap_err(), PackageError::BadMagic);
    }
}
