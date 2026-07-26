//! GoldSrc BSP v30 + WAD3 support for Pocket3D.
//!
//! Parses map geometry, baked lightmaps, entities, and clipnode collision
//! hulls into renderer-agnostic data. No GPU or windowing dependencies.
//!
//! The crate is split along the `std` feature:
//! - **no_std + alloc** (always): the plain data [`types`], hull collision
//!   ([`trace`]), PVS visibility ([`vis`]) and the cooked-map reader
//!   ([`cooked`]) — everything a constrained runtime (the PSP) consumes.
//! - **std** (default): BSP/WAD parsing, lightmap atlases, desktop geometry
//!   building, [`load_map`], and the cooked-map writer ([`cook`]).

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod collide;
#[cfg(feature = "std")]
pub mod cook;
pub mod cooked;
#[cfg(feature = "std")]
pub mod entities;
#[cfg(feature = "std")]
pub mod lightmap;
#[cfg(feature = "std")]
pub mod mesh;
#[cfg(feature = "std")]
pub mod raw;
pub mod trace;
pub mod types;
pub mod vis;
#[cfg(feature = "std")]
pub mod wad;

pub use trace::{Hull, MapCollision, TraceResult};
pub use types::{SpawnPoint, SunLight, SurfaceKind};

#[cfg(feature = "std")]
pub use entities::Entity;
#[cfg(feature = "std")]
pub use mesh::{Batch, MapGeometry, WorldVertexData};
#[cfg(feature = "std")]
pub use wad::{DecodedTexture, WadSet};

#[cfg(feature = "std")]
use std::path::{Path, PathBuf};

#[cfg(feature = "std")]
use anyhow::{Context, Result};
#[cfg(feature = "std")]
use glam::Vec3;

/// Everything a game needs from one map.
#[cfg(feature = "std")]
pub struct MapData {
    pub name: String,
    pub geometry: MapGeometry,
    /// Decoded textures, indexed by `Batch::texture`.
    pub textures: Vec<DecodedTexture>,
    pub entities: Vec<Entity>,
    pub collision: MapCollision,
    /// CT-side spawns (info_player_start).
    pub ct_spawns: Vec<SpawnPoint>,
    /// T-side spawns (info_player_deathmatch).
    pub t_spawns: Vec<SpawnPoint>,
    pub sun: Option<SunLight>,
    pub bounds: (Vec3, Vec3),
}

/// Load a `.bsp` plus any `.wad` texture archives found in `wad_dirs`.
#[cfg(feature = "std")]
pub fn load_map(bsp_path: &Path, wad_dirs: &[PathBuf]) -> Result<MapData> {
    let data =
        std::fs::read(bsp_path).with_context(|| format!("reading {}", bsp_path.display()))?;
    let name = bsp_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "map".into());

    let bsp = raw::parse(&data).with_context(|| format!("parsing {}", bsp_path.display()))?;
    let ents = entities::parse_entities(&bsp.entities_text);

    // WADs: provided dirs plus the map's own directory.
    let mut wads = WadSet::new();
    let mut dirs = wad_dirs.to_vec();
    if let Some(parent) = bsp_path.parent() {
        dirs.push(parent.to_path_buf());
        // Conventional sibling layout: maps/ + support/ or wads/.
        if let Some(gp) = parent.parent() {
            dirs.push(gp.join("support"));
            dirs.push(gp.join("wads"));
            dirs.push(gp.to_path_buf());
        }
    }
    wads.add_dirs(&dirs)?;

    // Decode textures (embedded first, then WAD lookup, then placeholder).
    let mut textures = Vec::with_capacity(bsp.textures.len());
    let mut missing = Vec::new();
    for entry in &bsp.textures {
        let tex = match &entry.embedded {
            Some(block) => wad::decode_miptex(block).ok(),
            None => wads.find(&entry.name),
        };
        let tex = tex.unwrap_or_else(|| {
            missing.push(entry.name.clone());
            DecodedTexture::placeholder(&entry.name, entry.width, entry.height)
        });
        textures.push(tex);
    }
    if !missing.is_empty() {
        log::warn!(
            "{}: {} textures unresolved (add WADs next to the map): {:?}",
            name,
            missing.len(),
            &missing[..missing.len().min(8)]
        );
    }

    // Brush entities: bake visible ones into geometry, register solid ones
    // for collision.
    let (include_models, solid_entities) = entities::brush_entity_layout(&ents, bsp.models.len());

    let tex_sizes: Vec<(u32, u32)> = textures.iter().map(|t| (t.width, t.height)).collect();
    let geometry = mesh::build_geometry(&bsp, &include_models, &tex_sizes);
    log::info!(
        "{name}: {} faces -> {} tris, {} batches, {} lightmap pages, {} textures",
        geometry.stats.faces_drawn,
        geometry.stats.triangles,
        geometry.batches.len(),
        geometry.lightmap_pages.len(),
        textures.len()
    );

    let collision = MapCollision::build(&bsp, &solid_entities);

    let mut ct_spawns = Vec::new();
    let mut t_spawns = Vec::new();
    for e in &ents {
        let list = match e.classname() {
            "info_player_start" => &mut ct_spawns,
            "info_player_deathmatch" => &mut t_spawns,
            _ => continue,
        };
        if let Some(pos) = e.origin() {
            list.push(SpawnPoint {
                pos,
                yaw: e.yaw().unwrap_or(0.0),
            });
        }
    }

    let sun = ents
        .iter()
        .find(|e| e.classname() == "light_environment")
        .and_then(entities::parse_sun);

    let bounds = bsp
        .models
        .first()
        .map(|m| (m.mins, m.maxs))
        .unwrap_or((Vec3::splat(-4096.0), Vec3::splat(4096.0)));

    Ok(MapData {
        name,
        geometry,
        textures,
        entities: ents,
        collision,
        ct_spawns,
        t_spawns,
        sun,
        bounds,
    })
}
