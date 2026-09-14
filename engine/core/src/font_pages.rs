//! Bounded GPU renditions of immutable baked font cells. Source glyph IDs and
//! metrics never change when a texture page is evicted. Call `retire_frame`
//! only after the GPU has finished reading every page used by the frame.
use crate::text::Atlas;
use alloc::vec::Vec;

pub const PAGE_DIM: u32 = 128;
pub const MAX_PAGES: usize = 8;

pub struct FontPage {
    pub slot: u8,
    pub revision: u64,
    pub first: u16,
    pub count: u16,
    pub cols: u32,
    pub width: u32,
    pub height: u32,
    /// Aligned ABGR4444 coverage, white RGB for per-draw modulation.
    pub pixels: Vec<u128>,
    pinned: bool,
    used: u64,
}

impl FontPage {
    pub fn contains(&self, gid: u16) -> bool {
        gid >= self.first && u32::from(gid) < u32::from(self.first) + u32::from(self.count)
    }
}

pub struct FontPages {
    pages: Vec<FontPage>,
    clock: u64,
}

impl Default for FontPages {
    fn default() -> Self {
        Self {
            pages: Vec::new(),
            clock: 0,
        }
    }
}

impl FontPages {
    /// Releases GPU ownership; keeps useful pages for the next frame.
    pub fn retire_frame(&mut self) {
        for page in &mut self.pages {
            page.pinned = false;
        }
    }

    pub fn resident_bytes(&self) -> usize {
        self.pages.iter().map(|page| page.pixels.len() * 16).sum()
    }

    /// Returns a page and whether its pixels need a native cache writeback.
    /// `None` means the caller must use the source glyph's CPU paint path.
    /// In particular, pressure never overwrites a page queued for GPU reads.
    pub fn get(&mut self, atlas: &Atlas, revision: u64, gid: u16) -> Option<(&FontPage, bool)> {
        let cw = atlas.coverage_width();
        let ch = atlas.coverage_height();
        if gid >= atlas.glyph_count || cw == 0 || ch == 0 || cw > PAGE_DIM || ch > PAGE_DIM {
            return None;
        }
        let cols = PAGE_DIM / cw;
        let capacity = cols * (PAGE_DIM / ch);
        let first = u32::from(gid) / capacity * capacity;
        self.clock = self.clock.saturating_add(1);
        if let Some(index) = self.pages.iter().position(|page| {
            page.slot == atlas.slot && page.revision == revision && page.first == first as u16
        }) {
            let page = &mut self.pages[index];
            page.pinned = true;
            page.used = self.clock;
            return Some((page, false));
        }
        let index = if self.pages.len() < MAX_PAGES {
            self.pages.len()
        } else {
            self.pages
                .iter()
                .enumerate()
                .filter(|(_, page)| !page.pinned)
                .min_by_key(|(_, page)| page.used)
                .map(|(index, _)| index)?
        };
        let count = capacity.min(u32::from(atlas.glyph_count) - first);
        let width = (cols.min(count) * cw).next_power_of_two();
        let height = (count.div_ceil(cols) * ch).next_power_of_two();
        // Reuse retired storage. No allocation scales with total font coverage.
        let mut pixels = if index < self.pages.len() {
            core::mem::take(&mut self.pages[index].pixels)
        } else {
            Vec::new()
        };
        pixels.resize(((width * height * 2) as usize).div_ceil(16), 0);
        pixels.fill(0);
        let dst = unsafe {
            core::slice::from_raw_parts_mut(pixels.as_mut_ptr() as *mut u16, pixels.len() * 8)
        };
        for local in 0..count {
            let src = atlas.glyph_rows((first + local) as u16);
            let x0 = local % cols * cw;
            let y0 = local / cols * ch;
            for y in 0..ch {
                for x in 0..cw {
                    let alpha = ((u32::from(src[(y * cw + x) as usize]) + 8) / 17).min(15) as u16;
                    if alpha != 0 {
                        dst[((y0 + y) * width + x0 + x) as usize] = (alpha << 12) | 0x0fff;
                    }
                }
            }
        }
        let page = FontPage {
            slot: atlas.slot,
            revision,
            first: first as u16,
            count: count as u16,
            cols,
            width,
            height,
            pixels,
            pinned: true,
            used: self.clock,
        };
        if index == self.pages.len() {
            self.pages.push(page);
        } else {
            self.pages[index] = page;
        }
        Some((&self.pages[index], true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn atlas(count: u16) -> Atlas {
        let mut bytes = vec![0; 16 + count as usize * (8 + 16 * 16)];
        bytes[..4].copy_from_slice(&crate::spec::font_atlas::MAGIC.to_le_bytes());
        bytes[4..6].copy_from_slice(&2u16.to_le_bytes());
        bytes[6..8].copy_from_slice(&count.to_le_bytes());
        bytes[8..12].copy_from_slice(&[16, 16, 12, 16]);
        for gid in 0..count {
            let at = 16 + gid as usize * 8;
            bytes[at..at + 4].copy_from_slice(&(0x4e00 + u32::from(gid)).to_le_bytes());
            bytes[at + 4..at + 6].copy_from_slice(&gid.to_le_bytes());
            bytes[at + 6] = 16;
            let start = 16 + count as usize * 8 + gid as usize * 256;
            bytes[start..start + 256].fill(((gid % 15) as u8 + 1) * 17);
        }
        Atlas::parse(&bytes).unwrap()
    }

    fn pixel(page: &FontPage, gid: u16) -> u16 {
        let local = u32::from(gid - page.first);
        let at = (local / page.cols * 16 * page.width + local % page.cols * 16) as usize;
        let pixels = unsafe {
            core::slice::from_raw_parts(page.pixels.as_ptr() as *const u16, page.pixels.len() * 8)
        };
        pixels[at]
    }

    #[test]
    fn more_than_140_distinct_glyphs_keep_their_source_identity() {
        let atlas = atlas(4096);
        let mut cache = FontPages::default();
        for gid in 0..256 {
            let (page, _) = cache.get(&atlas, 1, gid).unwrap();
            assert!(page.contains(gid));
            assert_eq!(pixel(page, gid), (((gid % 15) + 1) << 12) | 0x0fff);
        }
        assert!(cache.resident_bytes() <= MAX_PAGES * PAGE_DIM as usize * PAGE_DIM as usize * 2);
    }

    #[test]
    fn pressure_cannot_reuse_pixels_in_flight_and_recovers_after_retirement() {
        let atlas = atlas(4096);
        let mut cache = FontPages::default();
        for page in 0..MAX_PAGES {
            assert!(cache.get(&atlas, 1, (page * 64) as u16).is_some());
        }
        let pointer = cache.get(&atlas, 1, 0).unwrap().0.pixels.as_ptr();
        assert!(cache.get(&atlas, 1, 1024).is_none());
        assert_eq!(cache.get(&atlas, 1, 0).unwrap().0.pixels.as_ptr(), pointer);
        assert_eq!(pixel(cache.get(&atlas, 1, 0).unwrap().0, 0), 0x1fff);
        cache.retire_frame();
        assert!(cache.get(&atlas, 1, 1024).unwrap().1);
        assert_eq!(pixel(cache.get(&atlas, 1, 0).unwrap().0, 0), 0x1fff);
    }

    #[test]
    fn same_address_same_size_replacement_obeys_font_revision() {
        let mut atlas = atlas(256);
        let mut cache = FontPages::default();
        let address = atlas.bitmap.as_ptr();
        assert_eq!(pixel(cache.get(&atlas, 1, 1).unwrap().0, 1), 0x2fff);
        cache.retire_frame();
        atlas.bitmap.fill(255);
        assert_eq!(atlas.bitmap.as_ptr(), address);
        let (page, upload) = cache.get(&atlas, 2, 1).unwrap();
        assert!(upload);
        assert_eq!(pixel(page, 1), 0xffff);
    }
}
