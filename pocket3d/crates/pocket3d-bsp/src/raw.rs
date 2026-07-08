//! Byte-level parsing of the BSP v30 on-disk format.
//!
//! All positions/directions are converted from Quake space (+Z up, RH) to
//! Pocket3D space (+Y up, RH) at parse time via `q2y`: `(x, y, z) -> (x, z, -y)`.
//! That transform is a proper rotation, so dot products — and therefore plane
//! equations and texture projections — carry over unchanged.

use anyhow::{Context, Result, bail, ensure};
use glam::Vec3;

pub use crate::types::{
    CONTENTS_EMPTY, CONTENTS_LAVA, CONTENTS_SKY, CONTENTS_SLIME, CONTENTS_SOLID, CONTENTS_WATER,
    ClipNode, Leaf, Model, Node, Plane, convert_bounds, q2y, y2q,
};

pub const BSP_VERSION: i32 = 30;

pub const LUMP_ENTITIES: usize = 0;
pub const LUMP_PLANES: usize = 1;
pub const LUMP_TEXTURES: usize = 2;
pub const LUMP_VERTICES: usize = 3;
pub const LUMP_VISIBILITY: usize = 4;
pub const LUMP_NODES: usize = 5;
pub const LUMP_TEXINFO: usize = 6;
pub const LUMP_FACES: usize = 7;
pub const LUMP_LIGHTING: usize = 8;
pub const LUMP_CLIPNODES: usize = 9;
pub const LUMP_LEAVES: usize = 10;
pub const LUMP_MARKSURFACES: usize = 11;
pub const LUMP_EDGES: usize = 12;
pub const LUMP_SURFEDGES: usize = 13;
pub const LUMP_MODELS: usize = 14;
pub const LUMP_COUNT: usize = 15;

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.data.len().saturating_sub(self.pos)
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        ensure!(self.remaining() >= n, "unexpected end of data");
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes(1)?[0])
    }
    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    pub fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    pub fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    pub fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    pub fn vec3_raw(&mut self) -> Result<Vec3> {
        Ok(Vec3::new(self.f32()?, self.f32()?, self.f32()?))
    }
    /// Read a Quake-space vec3 and convert to Y-up.
    pub fn vec3(&mut self) -> Result<Vec3> {
        Ok(q2y(self.vec3_raw()?))
    }
    /// Fixed-size, NUL-padded name field.
    pub fn name(&mut self, n: usize) -> Result<String> {
        let b = self.bytes(n)?;
        let end = b.iter().position(|&c| c == 0).unwrap_or(n);
        Ok(String::from_utf8_lossy(&b[..end]).into_owned())
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Lump {
    pub offset: usize,
    pub length: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct TexInfo {
    pub s: Vec3,
    pub s_shift: f32,
    pub t: Vec3,
    pub t_shift: f32,
    pub miptex: usize,
    pub flags: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Face {
    pub plane: u16,
    pub plane_side: u16,
    pub first_edge: u32,
    pub num_edges: u16,
    pub texinfo: u16,
    pub styles: [u8; 4],
    pub lightmap_offset: i32,
}

/// Metadata for one entry of the textures lump. Pixel data (if embedded)
/// is kept as the raw miptex block for the shared decoder in `wad.rs`.
#[derive(Clone, Debug)]
pub struct MipTexEntry {
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Raw miptex bytes when the texture is embedded in the BSP.
    pub embedded: Option<Vec<u8>>,
}

pub struct RawBsp {
    pub entities_text: String,
    pub planes: Vec<Plane>,
    pub textures: Vec<MipTexEntry>,
    pub vertices: Vec<Vec3>,
    /// Compressed (RLE) potentially-visible-set data, indexed by
    /// `Leaf::vis_offset`.
    pub visibility: Vec<u8>,
    pub nodes: Vec<Node>,
    pub texinfos: Vec<TexInfo>,
    pub faces: Vec<Face>,
    pub lighting: Vec<u8>,
    pub clipnodes: Vec<ClipNode>,
    pub leaves: Vec<Leaf>,
    pub marksurfaces: Vec<u16>,
    pub edges: Vec<[u16; 2]>,
    pub surfedges: Vec<i32>,
    pub models: Vec<Model>,
}

pub fn parse(data: &[u8]) -> Result<RawBsp> {
    let mut r = Reader::new(data);
    let version = r.i32()?;
    if version != BSP_VERSION {
        bail!("unsupported BSP version {version} (expected {BSP_VERSION} / GoldSrc)");
    }
    let mut lumps = [Lump {
        offset: 0,
        length: 0,
    }; LUMP_COUNT];
    for lump in &mut lumps {
        let offset = r.i32()?;
        let length = r.i32()?;
        ensure!(offset >= 0 && length >= 0, "negative lump bounds");
        ensure!(
            (offset as usize) + (length as usize) <= data.len(),
            "lump out of range"
        );
        *lump = Lump {
            offset: offset as usize,
            length: length as usize,
        };
    }
    let lump = |i: usize| -> &[u8] { &data[lumps[i].offset..lumps[i].offset + lumps[i].length] };

    // Entities are a NUL-terminated text blob.
    let ents = lump(LUMP_ENTITIES);
    let ents_end = ents.iter().position(|&c| c == 0).unwrap_or(ents.len());
    let entities_text = String::from_utf8_lossy(&ents[..ents_end]).into_owned();

    let planes = parse_array(lump(LUMP_PLANES), 20, |r| {
        let normal = r.vec3()?;
        let dist = r.f32()?;
        let _type = r.i32()?;
        Ok(Plane { normal, dist })
    })
    .context("planes")?;

    let vertices = parse_array(lump(LUMP_VERTICES), 12, |r| r.vec3()).context("vertices")?;

    let nodes = parse_array(lump(LUMP_NODES), 24, |r| {
        let plane = r.u32()?;
        let children = [r.i16()?, r.i16()?];
        let _bounds = r.bytes(12)?; // i16 mins/maxs
        let _faces = r.bytes(4)?; // first_face, num_faces
        Ok(Node { plane, children })
    })
    .context("nodes")?;

    let texinfos = parse_array(lump(LUMP_TEXINFO), 40, |r| {
        let s = r.vec3()?;
        let s_shift = r.f32()?;
        let t = r.vec3()?;
        let t_shift = r.f32()?;
        let miptex = r.u32()? as usize;
        let flags = r.u32()?;
        Ok(TexInfo {
            s,
            s_shift,
            t,
            t_shift,
            miptex,
            flags,
        })
    })
    .context("texinfo")?;

    let faces = parse_array(lump(LUMP_FACES), 20, |r| {
        Ok(Face {
            plane: r.u16()?,
            plane_side: r.u16()?,
            first_edge: r.u32()?,
            num_edges: r.u16()?,
            texinfo: r.u16()?,
            styles: [r.u8()?, r.u8()?, r.u8()?, r.u8()?],
            lightmap_offset: r.i32()?,
        })
    })
    .context("faces")?;

    let lighting = lump(LUMP_LIGHTING).to_vec();

    let clipnodes = parse_array(lump(LUMP_CLIPNODES), 8, |r| {
        let plane = r.u32()?;
        let children = [r.i16()? as i32, r.i16()? as i32];
        Ok(ClipNode { plane, children })
    })
    .context("clipnodes")?;

    let leaves = parse_array(lump(LUMP_LEAVES), 28, |r| {
        let contents = r.i32()?;
        let vis_offset = r.i32()?;
        let mins_q = Vec3::new(r.i16()? as f32, r.i16()? as f32, r.i16()? as f32);
        let maxs_q = Vec3::new(r.i16()? as f32, r.i16()? as f32, r.i16()? as f32);
        let (mins, maxs) = convert_bounds(mins_q, maxs_q);
        let first_marksurface = r.u16()?;
        let num_marksurfaces = r.u16()?;
        let _ambient = r.bytes(4)?;
        Ok(Leaf {
            contents,
            vis_offset,
            mins,
            maxs,
            first_marksurface,
            num_marksurfaces,
        })
    })
    .context("leaves")?;

    let marksurfaces =
        parse_array(lump(LUMP_MARKSURFACES), 2, |r| r.u16()).context("marksurfaces")?;

    let visibility = lump(LUMP_VISIBILITY).to_vec();

    let edges = parse_array(lump(LUMP_EDGES), 4, |r| Ok([r.u16()?, r.u16()?])).context("edges")?;
    let surfedges = parse_array(lump(LUMP_SURFEDGES), 4, |r| r.i32()).context("surfedges")?;

    let models = parse_array(lump(LUMP_MODELS), 64, |r| {
        let mins_q = r.vec3_raw()?;
        let maxs_q = r.vec3_raw()?;
        let (mins, maxs) = convert_bounds(mins_q, maxs_q);
        let origin = q2y(r.vec3_raw()?);
        let headnodes = [r.i32()?, r.i32()?, r.i32()?, r.i32()?];
        let visleafs = r.i32()?.max(0) as usize;
        let first_face = r.i32()? as usize;
        let num_faces = r.i32()? as usize;
        Ok(Model {
            mins,
            maxs,
            origin,
            headnodes,
            visleafs,
            first_face,
            num_faces,
        })
    })
    .context("models")?;

    // Textures lump: u32 count, then relative offsets to miptex blocks.
    let tex_lump = lump(LUMP_TEXTURES);
    let mut textures = Vec::new();
    if !tex_lump.is_empty() {
        let mut r = Reader::new(tex_lump);
        let count = r.u32()? as usize;
        let mut offsets = Vec::with_capacity(count);
        for _ in 0..count {
            offsets.push(r.i32()?);
        }
        for (i, &off) in offsets.iter().enumerate() {
            if off < 0 || off as usize + 40 > tex_lump.len() {
                textures.push(MipTexEntry {
                    name: format!("__missing_{i}"),
                    width: 16,
                    height: 16,
                    embedded: None,
                });
                continue;
            }
            let start = off as usize;
            let mut mr = Reader::new(&tex_lump[start..]);
            let name = mr.name(16)?;
            let width = mr.u32()?;
            let height = mr.u32()?;
            let data_off = mr.u32()?; // offsets[0]
            let embedded = if data_off != 0 {
                // Slice to the next offset (or lump end) — the decoder walks
                // the mip chain + palette itself.
                let mut end = tex_lump.len();
                for &o in &offsets {
                    if o > off && (o as usize) < end {
                        end = o as usize;
                    }
                }
                Some(tex_lump[start..end].to_vec())
            } else {
                None
            };
            textures.push(MipTexEntry {
                name,
                width,
                height,
                embedded,
            });
        }
    }

    Ok(RawBsp {
        entities_text,
        planes,
        textures,
        vertices,
        visibility,
        nodes,
        texinfos,
        faces,
        lighting,
        clipnodes,
        leaves,
        marksurfaces,
        edges,
        surfedges,
        models,
    })
}

fn parse_array<T>(
    data: &[u8],
    stride: usize,
    mut f: impl FnMut(&mut Reader) -> Result<T>,
) -> Result<Vec<T>> {
    ensure!(
        data.len().is_multiple_of(stride),
        "lump size {} not a multiple of {stride}",
        data.len()
    );
    let count = data.len() / stride;
    let mut r = Reader::new(data);
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(f(&mut r)?);
    }
    Ok(out)
}
