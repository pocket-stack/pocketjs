//! Lightmap atlas: packs per-face lightmap blocks (16-unit luxels) into
//! shared RGBA pages with a 1-texel replicated border to prevent bleeding.

pub const PAGE_SIZE: u32 = 1024;

pub struct LightmapAtlas {
    pub pages: Vec<Vec<u8>>, // RGBA8, PAGE_SIZE^2 each
    shelf_x: u32,
    shelf_y: u32,
    shelf_h: u32,
}

pub struct LightmapAlloc {
    pub page: usize,
    /// Texel offset of the *inner* rect (border excluded).
    pub x: u32,
    pub y: u32,
}

impl LightmapAtlas {
    pub fn new() -> Self {
        Self {
            pages: vec![Self::blank_page()],
            shelf_x: 0,
            shelf_y: 0,
            shelf_h: 0,
        }
    }

    fn blank_page() -> Vec<u8> {
        // Mid-grey default so unlit faces are visible, not black holes.
        let mut p = vec![128u8; (PAGE_SIZE * PAGE_SIZE * 4) as usize];
        p.as_chunks_mut::<4>().0.iter_mut().for_each(|c| c[3] = 255);
        p
    }

    /// Allocate and fill a w*h block from RGB8 sample data.
    /// Returns the inner-rect placement.
    pub fn insert_rgb(&mut self, w: u32, h: u32, rgb: Option<&[u8]>) -> LightmapAlloc {
        let bw = w + 2; // with border
        let bh = h + 2;
        assert!(
            bw <= PAGE_SIZE && bh <= PAGE_SIZE,
            "lightmap block too large"
        );
        if self.shelf_x + bw > PAGE_SIZE {
            self.shelf_x = 0;
            self.shelf_y += self.shelf_h;
            self.shelf_h = 0;
        }
        if self.shelf_y + bh > PAGE_SIZE {
            self.pages.push(Self::blank_page());
            self.shelf_x = 0;
            self.shelf_y = 0;
            self.shelf_h = 0;
        }
        let page = self.pages.len() - 1;
        let (bx, by) = (self.shelf_x, self.shelf_y);
        self.shelf_x += bw;
        self.shelf_h = self.shelf_h.max(bh);

        // Fill inner rect (clamping reads to available data), then replicate
        // the border.
        let page_px = self.pages.last_mut().unwrap();
        let sample = |x: u32, y: u32| -> [u8; 4] {
            match rgb {
                Some(data) => {
                    let idx = ((y * w + x) * 3) as usize;
                    if idx + 2 < data.len() {
                        [data[idx], data[idx + 1], data[idx + 2], 255]
                    } else {
                        [255, 255, 255, 255]
                    }
                }
                // No lighting data: fullbright.
                None => [255, 255, 255, 255],
            }
        };
        for oy in 0..bh {
            for ox in 0..bw {
                let sx = ox.saturating_sub(1).min(w - 1);
                let sy = oy.saturating_sub(1).min(h - 1);
                let c = sample(sx, sy);
                let di = (((by + oy) * PAGE_SIZE + bx + ox) * 4) as usize;
                page_px[di..di + 4].copy_from_slice(&c);
            }
        }

        LightmapAlloc {
            page,
            x: bx + 1,
            y: by + 1,
        }
    }
}

impl Default for LightmapAtlas {
    fn default() -> Self {
        Self::new()
    }
}
