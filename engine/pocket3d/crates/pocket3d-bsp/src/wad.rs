//! WAD3 texture archives and miptex decoding (shared with embedded BSP
//! textures — the on-disk layout is identical).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::raw::Reader;

/// A decoded, ready-to-upload texture.
#[derive(Clone)]
pub struct DecodedTexture {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// RGBA8, row-major, `width * height * 4` bytes.
    pub rgba: Vec<u8>,
    /// True when palette index 255 was treated as transparent (`{` masks).
    pub has_alpha: bool,
}

impl DecodedTexture {
    /// A magenta/black checkerboard stand-in for missing textures.
    pub fn placeholder(name: &str, width: u32, height: u32) -> Self {
        let (w, h) = (width.max(16), height.max(16));
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let on = ((x / 8) + (y / 8)) % 2 == 0;
                let i = ((y * w + x) * 4) as usize;
                let c: [u8; 4] = if on {
                    [200, 0, 200, 255]
                } else {
                    [20, 20, 20, 255]
                };
                rgba[i..i + 4].copy_from_slice(&c);
            }
        }
        Self {
            name: name.to_string(),
            width: w,
            height: h,
            rgba,
            has_alpha: false,
        }
    }
}

/// A miptex kept in its native indexed form: 8-bit palette indices for the
/// four stored mip levels plus the 256-color RGB palette. This is what the
/// cooked-map pipeline wants — the PSP consumes palettes natively (CLUT8).
pub struct IndexedTexture {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Mip levels 0..4 at w>>l x h>>l, 8-bit palette indices, row-major.
    pub mips: Vec<Vec<u8>>,
    /// 256 RGB entries (768 bytes).
    pub palette: Vec<u8>,
    /// True for `{` textures (palette index 255 = transparent).
    pub masked: bool,
}

/// Decode a raw miptex block without palette expansion.
pub fn decode_miptex_indexed(block: &[u8]) -> Result<IndexedTexture> {
    let mut r = Reader::new(block);
    let name = r.name(16)?;
    let width = r.u32()?;
    let height = r.u32()?;
    let offsets = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        bail!("miptex {name}: bad dimensions {width}x{height}");
    }
    if offsets[0] == 0 {
        bail!("miptex {name}: no embedded data");
    }
    let mut mips = Vec::with_capacity(4);
    for (level, &off) in offsets.iter().enumerate() {
        let (w, h) = ((width >> level).max(1), (height >> level).max(1));
        let len = (w * h) as usize;
        let off = off as usize;
        if off + len > block.len() {
            bail!("miptex {name}: mip {level} out of range");
        }
        mips.push(block[off..off + len].to_vec());
    }
    let pixel_count = (width * height) as usize;
    let pal_off = offsets[3] as usize + pixel_count / 64 + 2;
    if pal_off + 256 * 3 > block.len() {
        bail!("miptex {name}: palette out of range");
    }
    let palette = block[pal_off..pal_off + 256 * 3].to_vec();
    let masked = name.starts_with('{');
    Ok(IndexedTexture {
        name,
        width,
        height,
        mips,
        palette,
        masked,
    })
}

/// Decode a raw miptex block (name/dims/mip offsets, 8-bit indexed pixels,
/// 256-color RGB palette after the smallest mip).
pub fn decode_miptex(block: &[u8]) -> Result<DecodedTexture> {
    let mut r = Reader::new(block);
    let name = r.name(16)?;
    let width = r.u32()?;
    let height = r.u32()?;
    let offsets = [r.u32()?, r.u32()?, r.u32()?, r.u32()?];
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        bail!("miptex {name}: bad dimensions {width}x{height}");
    }
    if offsets[0] == 0 {
        bail!("miptex {name}: no embedded data");
    }
    let pixel_count = (width * height) as usize;
    let mip0 = offsets[0] as usize;
    if mip0 + pixel_count > block.len() {
        bail!("miptex {name}: pixel data out of range");
    }
    let indices = &block[mip0..mip0 + pixel_count];

    // Palette: after mip3 (w/8 * h/8 pixels), prefixed by u16 color count.
    let mip3 = offsets[3] as usize;
    let mip3_len = pixel_count / 64;
    let pal_off = mip3 + mip3_len + 2;
    if pal_off + 256 * 3 > block.len() {
        bail!("miptex {name}: palette out of range");
    }
    let palette = &block[pal_off..pal_off + 256 * 3];

    let masked = name.starts_with('{');
    let mut rgba = vec![0u8; pixel_count * 4];
    let mut has_alpha = false;
    for (i, &idx) in indices.iter().enumerate() {
        let p = idx as usize * 3;
        let o = i * 4;
        if masked && idx == 255 {
            // Transparent cutout texel.
            rgba[o..o + 4].copy_from_slice(&[0, 0, 0, 0]);
            has_alpha = true;
        } else {
            rgba[o] = palette[p];
            rgba[o + 1] = palette[p + 1];
            rgba[o + 2] = palette[p + 2];
            rgba[o + 3] = 255;
        }
    }
    Ok(DecodedTexture {
        name,
        width,
        height,
        rgba,
        has_alpha,
    })
}

struct WadEntry {
    file: usize,
    offset: usize,
    size: usize,
}

/// An index over one or more WAD3 files, queried by texture name
/// (case-insensitive, as GoldSrc does).
pub struct WadSet {
    files: Vec<(PathBuf, Vec<u8>)>,
    entries: HashMap<String, WadEntry>,
}

impl WadSet {
    pub fn new() -> Self {
        Self {
            files: Vec::new(),
            entries: HashMap::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn add_file(&mut self, path: &Path) -> Result<()> {
        let data = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let file_idx = self.files.len();
        {
            let mut r = Reader::new(&data);
            let magic = r.bytes(4)?;
            if magic != b"WAD3" && magic != b"WAD2" {
                bail!("{}: not a WAD2/WAD3 file", path.display());
            }
            let count = r.u32()? as usize;
            let dir_offset = r.u32()? as usize;
            for i in 0..count {
                let mut er = Reader::new(
                    data.get(dir_offset + i * 32..dir_offset + (i + 1) * 32)
                        .context("wad directory out of range")?,
                );
                let filepos = er.u32()? as usize;
                let disksize = er.u32()? as usize;
                let _size = er.u32()?;
                let ty = er.u8()?;
                let _compression = er.u8()?;
                let _pad = er.u16()?;
                let name = er.name(16)?.to_ascii_lowercase();
                // 0x43 = miptex; ignore fonts/qpics.
                if ty == 0x43 {
                    self.entries.entry(name).or_insert(WadEntry {
                        file: file_idx,
                        offset: filepos,
                        size: disksize,
                    });
                }
            }
        }
        self.files.push((path.to_path_buf(), data));
        Ok(())
    }

    /// Load every `*.wad` found in the given directories (non-recursive).
    pub fn add_dirs(&mut self, dirs: &[PathBuf]) -> Result<()> {
        for dir in dirs {
            let Ok(rd) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in rd.flatten() {
                let p = entry.path();
                if p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("wad"))
                {
                    match self.add_file(&p) {
                        Ok(()) => log::info!("loaded wad {}", p.display()),
                        Err(e) => log::warn!("skipping wad {}: {e}", p.display()),
                    }
                }
            }
        }
        Ok(())
    }

    pub fn find(&self, name: &str) -> Option<DecodedTexture> {
        let block = self.find_block(name)?;
        match decode_miptex(block) {
            Ok(t) => Some(t),
            Err(e) => {
                log::warn!("failed to decode wad texture {name}: {e}");
                None
            }
        }
    }

    /// The raw miptex block for a texture, if present in any loaded WAD.
    pub fn find_block(&self, name: &str) -> Option<&[u8]> {
        let entry = self.entries.get(&name.to_ascii_lowercase())?;
        let (_, data) = &self.files[entry.file];
        data.get(entry.offset..entry.offset + entry.size)
    }
}

impl Default for WadSet {
    fn default() -> Self {
        Self::new()
    }
}
