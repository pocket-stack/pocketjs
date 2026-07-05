use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
};

use glam::{Vec2, Vec3};
use qbsp::{
    data::texture::{BspMipTexture, Palette},
    prelude::*,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PocketBspError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("BSP parse error: {0}")]
    Bsp(#[from] qbsp::BspParseError),
    #[error("invalid WAD3 archive {path}: {reason}")]
    InvalidWad { path: PathBuf, reason: String },
    #[error("texture {0} is missing from BSP embedded textures and configured WADs")]
    MissingTexture(String),
}

pub type Result<T> = std::result::Result<T, PocketBspError>;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub min: Vec3,
    pub max: Vec3,
}

impl Bounds {
    pub const EMPTY: Self = Self {
        min: Vec3::splat(f32::INFINITY),
        max: Vec3::splat(f32::NEG_INFINITY),
    };

    pub fn include(&mut self, point: Vec3) {
        self.min = self.min.min(point);
        self.max = self.max.max(point);
    }

    pub fn center(self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    pub fn size(self) -> Vec3 {
        self.max - self.min
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CollisionTriangle {
    pub a: Vec3,
    pub b: Vec3,
    pub c: Vec3,
    pub normal: Vec3,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorldMesh {
    pub name: String,
    pub texture: Option<String>,
    pub positions: Vec<Vec3>,
    pub normals: Vec<Vec3>,
    pub uvs: Vec<Vec2>,
    pub indices: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorldRenderGeometry {
    pub meshes: Vec<WorldMesh>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntityRecord {
    pub classname: Option<String>,
    pub properties: BTreeMap<String, String>,
}

impl EntityRecord {
    pub fn origin(&self) -> Option<Vec3> {
        parse_vec3(self.properties.get("origin")?)
    }

    pub fn angle_yaw_radians(&self) -> f32 {
        self.properties
            .get("angle")
            .and_then(|angle| angle.parse::<f32>().ok())
            .unwrap_or(0.0)
            .to_radians()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum SpawnKind {
    Player,
    Terrorist,
    CounterTerrorist,
    Deathmatch,
    Bot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnPoint {
    pub kind: SpawnKind,
    pub position: Vec3,
    pub yaw: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextureImage {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BspInspectSummary {
    pub format: String,
    pub map_name: String,
    pub vertex_count: usize,
    pub face_count: usize,
    pub mesh_count: usize,
    pub texture_count: usize,
    pub missing_textures: Vec<String>,
    pub entity_count: usize,
    pub entity_counts: BTreeMap<String, usize>,
    pub collision_triangle_count: usize,
    pub spawn_point_count: usize,
    pub bounds: Bounds,
}

impl BspInspectSummary {
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("map: {}\n", self.map_name));
        out.push_str(&format!("format: {}\n", self.format));
        out.push_str(&format!("vertices: {}\n", self.vertex_count));
        out.push_str(&format!("faces: {}\n", self.face_count));
        out.push_str(&format!("world meshes: {}\n", self.mesh_count));
        out.push_str(&format!("textures referenced: {}\n", self.texture_count));
        out.push_str(&format!(
            "missing textures: {}\n",
            self.missing_textures.len()
        ));
        for missing in &self.missing_textures {
            out.push_str(&format!("  - {missing}\n"));
        }
        out.push_str(&format!("entities: {}\n", self.entity_count));
        for (classname, count) in &self.entity_counts {
            out.push_str(&format!("  {classname}: {count}\n"));
        }
        out.push_str(&format!(
            "collision triangles: {}\n",
            self.collision_triangle_count
        ));
        out.push_str(&format!("spawn points: {}\n", self.spawn_point_count));
        out.push_str(&format!(
            "bounds: min=({:.1}, {:.1}, {:.1}) max=({:.1}, {:.1}, {:.1}) size=({:.1}, {:.1}, {:.1})\n",
            self.bounds.min.x,
            self.bounds.min.y,
            self.bounds.min.z,
            self.bounds.max.x,
            self.bounds.max.y,
            self.bounds.max.z,
            self.bounds.size().x,
            self.bounds.size().y,
            self.bounds.size().z
        ));
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BspTrace {
    pub hit: bool,
    pub fraction: f32,
    pub position: Vec3,
    pub normal: Vec3,
}

#[derive(Debug, Clone)]
pub struct BspWorld {
    pub path: PathBuf,
    pub data: BspData,
    pub geometry: WorldRenderGeometry,
    pub collision: Vec<CollisionTriangle>,
    pub entities: Vec<EntityRecord>,
    pub spawn_points: Vec<SpawnPoint>,
    pub bounds: Bounds,
    pub wads: WadTextureIndex,
    pub missing_textures: Vec<String>,
}

impl BspWorld {
    pub fn load(path: impl AsRef<Path>, wad_dirs: &[PathBuf]) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let bytes = fs::read(&path)?;
        let data = BspData::parse(BspParseInput {
            bsp: &bytes,
            lit: None,
            settings: BspParseSettings::default(),
        })?;
        let wads = WadTextureIndex::load_dirs(wad_dirs)?;
        let geometry = build_geometry(&data);
        let collision = build_collision(&geometry);
        let bounds = compute_bounds(&geometry);
        let mut entity_bytes = data.entities.clone();
        let entity_text = qbsp::util::quake_string_to_utf8_lossy(&mut entity_bytes).to_string();
        let entities = parse_entities(&entity_text);
        let spawn_points = collect_spawn_points(&entities);
        let missing_textures = collect_missing_textures(&data, &wads);

        Ok(Self {
            path,
            data,
            geometry,
            collision,
            entities,
            spawn_points,
            bounds,
            wads,
            missing_textures,
        })
    }

    pub fn inspect(&self) -> BspInspectSummary {
        let mut entity_counts = BTreeMap::new();
        for entity in &self.entities {
            let classname = entity
                .classname
                .clone()
                .unwrap_or_else(|| "<unknown>".to_string());
            *entity_counts.entry(classname).or_insert(0) += 1;
        }

        let mut textures = BTreeSet::new();
        for mesh in &self.geometry.meshes {
            if let Some(texture) = &mesh.texture {
                textures.insert(texture.clone());
            }
        }

        BspInspectSummary {
            format: self.data.parse_ctx.format.to_string(),
            map_name: self
                .path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("map")
                .to_string(),
            vertex_count: self.data.vertices.len(),
            face_count: self.data.faces.len(),
            mesh_count: self.geometry.meshes.len(),
            texture_count: textures.len(),
            missing_textures: self.missing_textures.clone(),
            entity_count: self.entities.len(),
            entity_counts,
            collision_triangle_count: self.collision.len(),
            spawn_point_count: self.spawn_points.len(),
            bounds: self.bounds,
        }
    }

    pub fn point_is_solid(&self, point: Vec3) -> bool {
        let leaf_idx = self.data.leaf_at_point(0, point);
        self.data
            .leaves
            .get(leaf_idx)
            .map(|leaf| {
                leaf.contents
                    .contains(qbsp::data::nodes::BspLeafContentFlags::SOLID)
            })
            .unwrap_or(true)
    }

    pub fn raycast(&self, from: Vec3, to: Vec3) -> Option<BspTrace> {
        let result = self.data.raycast(0, from, to);
        result.impact.map(|impact| BspTrace {
            hit: true,
            fraction: impact.fraction.clamp(0.0, 1.0),
            position: impact.position,
            normal: impact.normal,
        })
    }

    pub fn texture_rgba(&self, name: &str) -> Result<TextureImage> {
        if let Some(image) = embedded_texture_rgba(&self.data, name) {
            return Ok(image);
        }
        self.wads
            .texture_rgba(name)
            .ok_or_else(|| PocketBspError::MissingTexture(name.to_string()))
    }

    pub fn first_spawn_or_center(&self) -> Vec3 {
        self.spawn_points
            .iter()
            .find(|spawn| {
                matches!(
                    spawn.kind,
                    SpawnKind::Player | SpawnKind::CounterTerrorist | SpawnKind::Deathmatch
                )
            })
            .or_else(|| self.spawn_points.first())
            .map(|spawn| spawn.position)
            .unwrap_or_else(|| self.bounds.center() + Vec3::Z * 32.0)
    }
}

fn build_geometry(data: &BspData) -> WorldRenderGeometry {
    let output = data.mesh_model(0, None);
    let meshes = output
        .meshes
        .into_iter()
        .enumerate()
        .map(|(idx, mesh)| {
            let texture = mesh.texture.map(|name| name.as_str().to_string());
            WorldMesh {
                name: texture
                    .as_ref()
                    .map(|texture| format!("world/{texture}"))
                    .unwrap_or_else(|| format!("world/mesh-{idx}")),
                texture,
                positions: mesh.positions,
                normals: mesh.normals,
                uvs: mesh.uvs,
                indices: mesh.indices.into_iter().flatten().collect(),
            }
        })
        .collect();
    WorldRenderGeometry { meshes }
}

fn build_collision(geometry: &WorldRenderGeometry) -> Vec<CollisionTriangle> {
    let mut out = Vec::new();
    for mesh in &geometry.meshes {
        for tri in mesh.indices.chunks_exact(3) {
            let a = mesh.positions[tri[0] as usize];
            let b = mesh.positions[tri[1] as usize];
            let c = mesh.positions[tri[2] as usize];
            let normal = (b - a).cross(c - a).normalize_or_zero();
            out.push(CollisionTriangle { a, b, c, normal });
        }
    }
    out
}

fn compute_bounds(geometry: &WorldRenderGeometry) -> Bounds {
    let mut bounds = Bounds::EMPTY;
    for mesh in &geometry.meshes {
        for &position in &mesh.positions {
            bounds.include(position);
        }
    }
    bounds
}

fn collect_missing_textures(data: &BspData, wads: &WadTextureIndex) -> Vec<String> {
    let mut referenced = BTreeSet::new();
    for face in &data.faces {
        let tex_info = &data.tex_info[face.texture_info_idx.0 as usize];
        if let Some(texture) = data.get_texture_name(tex_info) {
            referenced.insert(texture.as_str().to_string());
        }
    }

    referenced
        .into_iter()
        .filter(|name| embedded_texture_rgba(data, name).is_none() && !wads.contains(name))
        .collect()
}

fn embedded_texture_rgba(data: &BspData, name: &str) -> Option<TextureImage> {
    let name = normalize_texture_name(name);
    for texture in data.textures.iter().flatten() {
        if normalize_texture_name(texture.header.name.as_str()) != name {
            continue;
        }
        let pixels = texture.data.full.as_ref()?;
        let palette = texture.data.palette.0.as_ref()?;
        return Some(indexed_to_rgba(
            texture.header.name.as_str(),
            texture.header.width,
            texture.header.height,
            pixels,
            palette,
        ));
    }
    None
}

fn indexed_to_rgba(
    name: &str,
    width: u32,
    height: u32,
    pixels: &[u8],
    palette: &Palette,
) -> TextureImage {
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for &idx in pixels.iter().take(width as usize * height as usize) {
        let [r, g, b] = palette.colors[idx as usize];
        rgba.extend_from_slice(&[r, g, b, 255]);
    }
    TextureImage {
        name: name.to_string(),
        width,
        height,
        rgba,
    }
}

#[derive(Debug, Clone)]
pub struct WadTextureIndex {
    archives: Vec<WadArchive>,
    entries: HashMap<String, (usize, usize)>,
}

impl WadTextureIndex {
    pub fn empty() -> Self {
        Self {
            archives: Vec::new(),
            entries: HashMap::new(),
        }
    }

    pub fn load_dirs(dirs: &[PathBuf]) -> Result<Self> {
        let mut index = Self::empty();
        for dir in dirs {
            if !dir.exists() {
                continue;
            }
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                if path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("wad"))
                {
                    index.add_archive(WadArchive::open(path)?);
                }
            }
        }
        Ok(index)
    }

    pub fn add_archive(&mut self, archive: WadArchive) {
        let archive_idx = self.archives.len();
        for (entry_idx, entry) in archive.entries.iter().enumerate() {
            self.entries
                .entry(normalize_texture_name(&entry.name))
                .or_insert((archive_idx, entry_idx));
        }
        self.archives.push(archive);
    }

    pub fn contains(&self, name: &str) -> bool {
        self.entries.contains_key(&normalize_texture_name(name))
    }

    pub fn texture_rgba(&self, name: &str) -> Option<TextureImage> {
        let (archive_idx, entry_idx) = *self.entries.get(&normalize_texture_name(name))?;
        self.archives[archive_idx].texture_rgba(entry_idx).ok()
    }
}

#[derive(Debug, Clone)]
pub struct WadArchive {
    pub path: PathBuf,
    bytes: Vec<u8>,
    entries: Vec<WadEntry>,
}

#[derive(Debug, Clone)]
struct WadEntry {
    name: String,
    offset: usize,
    disk_size: usize,
}

impl WadArchive {
    pub fn open(path: PathBuf) -> Result<Self> {
        let bytes = fs::read(&path)?;
        if bytes.len() < 12 || &bytes[0..4] != b"WAD3" {
            return Err(PocketBspError::InvalidWad {
                path,
                reason: "missing WAD3 magic".to_string(),
            });
        }
        let num_entries = read_i32(&bytes, 4).ok_or_else(|| PocketBspError::InvalidWad {
            path: path.clone(),
            reason: "missing entry count".to_string(),
        })? as usize;
        let dir_offset = read_i32(&bytes, 8).ok_or_else(|| PocketBspError::InvalidWad {
            path: path.clone(),
            reason: "missing directory offset".to_string(),
        })? as usize;

        let mut entries = Vec::with_capacity(num_entries);
        for i in 0..num_entries {
            let base = dir_offset + i * 32;
            if base + 32 > bytes.len() {
                return Err(PocketBspError::InvalidWad {
                    path,
                    reason: "directory entry out of bounds".to_string(),
                });
            }
            let offset = read_i32(&bytes, base).unwrap() as usize;
            let disk_size = read_i32(&bytes, base + 4).unwrap() as usize;
            let name = nul_trim(&bytes[base + 16..base + 32]).to_string();
            if !name.is_empty() {
                entries.push(WadEntry {
                    name,
                    offset,
                    disk_size,
                });
            }
        }

        Ok(Self {
            path,
            bytes,
            entries,
        })
    }

    fn texture_rgba(&self, entry_idx: usize) -> Result<TextureImage> {
        let entry = &self.entries[entry_idx];
        let base = entry.offset;
        if base + 40 > self.bytes.len() || base + entry.disk_size > self.bytes.len() {
            return Err(PocketBspError::InvalidWad {
                path: self.path.clone(),
                reason: format!("texture {} is out of bounds", entry.name),
            });
        }
        let header_name = nul_trim(&self.bytes[base..base + 16]);
        let width = read_u32(&self.bytes, base + 16).unwrap();
        let height = read_u32(&self.bytes, base + 20).unwrap();
        let offset_full = read_u32(&self.bytes, base + 24).unwrap() as usize;
        let pixels_len = width as usize * height as usize;
        let pixels_start = base + offset_full;
        let pixels_end = pixels_start + pixels_len;
        if pixels_end > self.bytes.len() {
            return Err(PocketBspError::InvalidWad {
                path: self.path.clone(),
                reason: format!("texture {} pixels are out of bounds", entry.name),
            });
        }
        let palette_start =
            pixels_start + pixels_len + pixels_len / 4 + pixels_len / 16 + pixels_len / 64;
        let palette_bytes_start = palette_start + 2;
        if palette_bytes_start + 768 > self.bytes.len() {
            return Err(PocketBspError::InvalidWad {
                path: self.path.clone(),
                reason: format!("texture {} palette is out of bounds", entry.name),
            });
        }
        let palette = Palette::parse(&self.bytes[palette_bytes_start..palette_bytes_start + 768])
            .map_err(|err| PocketBspError::InvalidWad {
            path: self.path.clone(),
            reason: format!("texture {} palette parse failed: {err}", entry.name),
        })?;
        Ok(indexed_to_rgba(
            if header_name.is_empty() {
                &entry.name
            } else {
                header_name
            },
            width,
            height,
            &self.bytes[pixels_start..pixels_end],
            &palette,
        ))
    }
}

fn read_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn nul_trim(bytes: &[u8]) -> &str {
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end]).unwrap_or("")
}

fn normalize_texture_name(name: &str) -> String {
    name.trim_start_matches(['{', '!', '+', '-', '~'])
        .to_ascii_lowercase()
}

pub fn parse_entities(text: &str) -> Vec<EntityRecord> {
    let mut scanner = EntityScanner::new(text);
    let mut records = Vec::new();

    while scanner.seek_char('{') {
        let mut properties = BTreeMap::new();
        loop {
            scanner.skip_ws();
            if scanner.peek_char() == Some('}') {
                scanner.next_char();
                break;
            }
            let Some(key) = scanner.quoted_string() else {
                break;
            };
            let Some(value) = scanner.quoted_string() else {
                break;
            };
            properties.insert(key, value);
        }
        let classname = properties.get("classname").cloned();
        records.push(EntityRecord {
            classname,
            properties,
        });
    }

    records
}

fn collect_spawn_points(entities: &[EntityRecord]) -> Vec<SpawnPoint> {
    entities
        .iter()
        .filter_map(|entity| {
            let classname = entity.classname.as_deref()?;
            let kind = match classname {
                "info_player_start" => SpawnKind::Player,
                "info_player_deathmatch" => SpawnKind::Deathmatch,
                "info_player_terrorist" => SpawnKind::Terrorist,
                "info_player_counterterrorist" => SpawnKind::CounterTerrorist,
                "info_player_bot" | "info_bot_spawn" => SpawnKind::Bot,
                _ => return None,
            };
            Some(SpawnPoint {
                kind,
                position: entity.origin()?,
                yaw: entity.angle_yaw_radians(),
            })
        })
        .collect()
}

fn parse_vec3(value: &str) -> Option<Vec3> {
    let mut parts = value
        .split_whitespace()
        .filter_map(|part| part.parse::<f32>().ok());
    Some(Vec3::new(parts.next()?, parts.next()?, parts.next()?))
}

struct EntityScanner<'a> {
    chars: std::str::Chars<'a>,
    peeked: Option<char>,
}

impl<'a> EntityScanner<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            chars: text.chars(),
            peeked: None,
        }
    }

    fn next_char(&mut self) -> Option<char> {
        self.peeked.take().or_else(|| self.chars.next())
    }

    fn peek_char(&mut self) -> Option<char> {
        if self.peeked.is_none() {
            self.peeked = self.chars.next();
        }
        self.peeked
    }

    fn skip_ws(&mut self) {
        while self.peek_char().is_some_and(char::is_whitespace) {
            self.next_char();
        }
    }

    fn seek_char(&mut self, target: char) -> bool {
        while let Some(ch) = self.next_char() {
            if ch == target {
                return true;
            }
        }
        false
    }

    fn quoted_string(&mut self) -> Option<String> {
        self.skip_ws();
        if self.next_char()? != '"' {
            return None;
        }
        let mut out = String::new();
        while let Some(ch) = self.next_char() {
            match ch {
                '"' => return Some(out),
                '\\' => {
                    if let Some(next) = self.next_char() {
                        out.push(next);
                    }
                }
                _ => out.push(ch),
            }
        }
        None
    }
}

#[allow(dead_code)]
fn _assert_bsp_texture_data_is_public(_: &BspMipTexture) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_entity_records_and_spawns() {
        let entities = parse_entities(
            r#"
            {
              "classname" "worldspawn"
            }
            {
              "classname" "info_player_counterterrorist"
              "origin" "1 2 3"
              "angle" "90"
            }
            "#,
        );
        assert_eq!(entities.len(), 2);
        let spawns = collect_spawn_points(&entities);
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].position, Vec3::new(1.0, 2.0, 3.0));
        assert!((spawns[0].yaw - 90_f32.to_radians()).abs() < 0.001);
    }

    #[test]
    fn normalizes_goldsrc_texture_prefixes() {
        assert_eq!(normalize_texture_name("!WATER"), "water");
        assert_eq!(normalize_texture_name("{crate"), "crate");
        assert_eq!(normalize_texture_name("+0door"), "0door");
    }
}
