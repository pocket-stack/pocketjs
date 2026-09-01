use alloc::string::String;
use alloc::vec::Vec;

use pocketjs_core::{spec, Ui};

#[inline]
fn rd_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
    ]))
}

#[inline]
fn rd_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(offset)?,
        *bytes.get(offset + 1)?,
        *bytes.get(offset + 2)?,
        *bytes.get(offset + 3)?,
    ]))
}

pub struct SpriteReg {
    pub name: String,
    pub handle: i32,
    pub frames: u16,
    pub cols: u16,
    pub step: u16,
}

pub fn feed(ui: &mut Ui, pak: &[u8]) -> (Vec<(String, i32)>, Vec<SpriteReg>) {
    let mut textures = Vec::new();
    let mut sprites = Vec::new();
    if rd_u32(pak, 0) != Some(spec::pak::MAGIC) || rd_u16(pak, 4) != Some(spec::pak::VERSION) {
        return (textures, sprites);
    }
    let (Some(count), Some(dir_off), Some(names_off)) =
        (rd_u32(pak, 8), rd_u32(pak, 12), rd_u32(pak, 16))
    else {
        return (textures, sprites);
    };
    let count =
        (count as usize).min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    for index in 0..count {
        let entry = dir_off as usize + index * spec::pak::ENTRY_SIZE;
        let (Some(blob_off), Some(blob_len), Some(name_off), Some(name_len)) = (
            rd_u32(pak, entry + 4),
            rd_u32(pak, entry + 8),
            rd_u32(pak, entry + 12),
            rd_u16(pak, entry + 16),
        ) else {
            continue;
        };
        let name_start = names_off as usize + name_off as usize;
        let (Some(name_bytes), Some(blob)) = (
            pak.get(name_start..name_start + name_len as usize),
            pak.get(blob_off as usize..blob_off as usize + blob_len as usize),
        ) else {
            continue;
        };
        let Ok(key) = core::str::from_utf8(name_bytes) else {
            continue;
        };
        if key == "ui:styles" {
            ui.load_styles(blob);
        } else if key.starts_with("ui:font.") {
            ui.load_font_atlas(blob);
        } else if let Some(name) = key.strip_prefix("ui:img.") {
            let (Some(width), Some(height), Some(&psm), Some(pixels)) =
                (rd_u16(blob, 0), rd_u16(blob, 2), blob.get(4), blob.get(8..))
            else {
                continue;
            };
            let handle = ui.upload_texture(pixels, width as u32, height as u32, psm as u32);
            if handle >= 0 {
                textures.push((String::from(name), handle));
            }
        } else if let Some(name) = key.strip_prefix("ui:sprite.") {
            let (
                Some(width),
                Some(height),
                Some(&psm),
                Some(frames),
                Some(cols),
                Some(step),
                Some(pixels),
            ) = (
                rd_u16(blob, 0),
                rd_u16(blob, 2),
                blob.get(4),
                rd_u16(blob, 6),
                rd_u16(blob, 8),
                rd_u16(blob, 10),
                blob.get(16..),
            )
            else {
                continue;
            };
            let handle = ui.upload_texture(pixels, width as u32, height as u32, psm as u32);
            if handle >= 0 {
                sprites.push(SpriteReg {
                    name: String::from(name),
                    handle,
                    frames,
                    cols,
                    step,
                });
            }
        }
    }
    (textures, sprites)
}

pub fn find<'a>(pak: &'a [u8], key: &str) -> Option<&'a [u8]> {
    if rd_u32(pak, 0)? != spec::pak::MAGIC || rd_u16(pak, 4)? != spec::pak::VERSION {
        return None;
    }
    let (count, dir_off, names_off) = (rd_u32(pak, 8)?, rd_u32(pak, 12)?, rd_u32(pak, 16)?);
    let count =
        (count as usize).min(pak.len().saturating_sub(dir_off as usize) / spec::pak::ENTRY_SIZE);
    for index in 0..count {
        let entry = dir_off as usize + index * spec::pak::ENTRY_SIZE;
        let (blob_off, blob_len, name_off, name_len) = (
            rd_u32(pak, entry + 4)?,
            rd_u32(pak, entry + 8)?,
            rd_u32(pak, entry + 12)?,
            rd_u16(pak, entry + 16)?,
        );
        let name_start = names_off as usize + name_off as usize;
        if pak.get(name_start..name_start + name_len as usize)? == key.as_bytes() {
            return pak.get(blob_off as usize..blob_off as usize + blob_len as usize);
        }
    }
    None
}
