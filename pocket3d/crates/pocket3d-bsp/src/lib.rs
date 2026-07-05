//! GoldSrc BSP v30 + WAD3 support for Pocket3D.
//!
//! Parses map geometry, baked lightmaps, entities, and clipnode collision
//! hulls into renderer-agnostic data. No GPU or windowing dependencies.

pub mod entities;
pub mod lightmap;
pub mod mesh;
pub mod raw;
pub mod trace;
pub mod wad;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use glam::Vec3;

pub use entities::Entity;
pub use mesh::{Batch, MapGeometry, SurfaceKind, WorldVertexData};
pub use trace::{Hull, MapCollision, TraceResult};
pub use wad::{DecodedTexture, WadSet};

#[derive(Clone, Copy, Debug)]
pub struct SpawnPoint {
    pub pos: Vec3,
    pub yaw: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct SunLight {
    /// Direction pointing from the scene towards the sun (Y-up space).
    pub dir: Vec3,
    pub color: Vec3,
}

/// Everything a game needs from one map.
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
    let mut include_models: Vec<(usize, Vec3)> = vec![(0, Vec3::ZERO)];
    let mut solid_entities: Vec<(usize, Vec3)> = Vec::new();
    for e in &ents {
        let Some(mi) = e.brush_model() else { continue };
        if mi == 0 || mi >= bsp.models.len() {
            continue;
        }
        let cls = e.classname();
        let hidden = cls.starts_with("trigger")
            || matches!(
                cls,
                "func_buyzone"
                    | "func_bomb_target"
                    | "func_hostage_rescue"
                    | "func_escapezone"
                    | "func_vip_safetyzone"
                    | "func_ladder"
                    | "env_bubbles"
            );
        let offset = e.origin().unwrap_or(Vec3::ZERO);
        if !hidden {
            include_models.push((mi, offset));
        }
        let solid = !hidden && cls != "func_illusionary";
        if solid {
            solid_entities.push((mi, offset));
        }
    }

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
        .map(parse_sun)
        .unwrap_or(None);

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

fn parse_sun(e: &Entity) -> Option<SunLight> {
    // Light travel direction in Quake space from pitch/yaw; pitch usually
    // negative (downwards). "pitch" overrides angles[0] when present.
    let angles = e.get("angles").unwrap_or("0 0 0");
    let mut it = angles
        .split_ascii_whitespace()
        .map(|v| v.parse::<f32>().unwrap_or(0.0));
    let mut pitch = it.next().unwrap_or(0.0);
    let yaw = it.next().unwrap_or(0.0);
    if let Some(p) = e.get("pitch").and_then(|p| p.parse::<f32>().ok()) {
        pitch = p;
    }
    let (pr, yr) = (pitch.to_radians(), yaw.to_radians());
    let travel_q = Vec3::new(pr.cos() * yr.cos(), pr.cos() * yr.sin(), pr.sin());
    let dir = raw::q2y(-travel_q).normalize_or_zero();

    let color = e
        .get("_light")
        .map(|l| {
            let v: Vec<f32> = l
                .split_ascii_whitespace()
                .filter_map(|x| x.parse().ok())
                .collect();
            match v.len() {
                0 => Vec3::ONE,
                1 | 2 => Vec3::splat(v[0] / 255.0),
                _ => Vec3::new(v[0], v[1], v[2]) / 255.0,
            }
        })
        .unwrap_or(Vec3::ONE);
    if dir.y <= 0.0 {
        // Sun below the horizon — treat as absent.
        return None;
    }
    Some(SunLight { dir, color })
}
