use std::{
    collections::BTreeMap,
    fs,
    hash::{Hash, Hasher},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AssetError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid p3dpak magic")]
    InvalidMagic,
    #[error("invalid p3dpak manifest: {0}")]
    InvalidManifest(#[from] serde_json::Error),
    #[error("asset not found: {0}")]
    Missing(String),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct AssetId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRecord {
    pub id: AssetId,
    pub kind: String,
    pub source: String,
    pub hash: u64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetManifest {
    pub version: u32,
    pub records: Vec<AssetRecord>,
}

#[derive(Debug, Clone, Default)]
pub struct AssetDatabase {
    records: BTreeMap<AssetId, AssetRecord>,
}

impl AssetDatabase {
    pub fn from_manifest(manifest: AssetManifest) -> Self {
        Self {
            records: manifest
                .records
                .into_iter()
                .map(|record| (record.id.clone(), record))
                .collect(),
        }
    }

    pub fn get(&self, id: &AssetId) -> Option<&AssetRecord> {
        self.records.get(id)
    }

    pub fn records(&self) -> impl Iterator<Item = &AssetRecord> {
        self.records.values()
    }
}

pub fn stable_hash(data: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

const PAK_MAGIC: &[u8; 8] = b"P3DPAK01";

pub fn write_pak(
    files: &[(AssetId, String, PathBuf)],
    out: &Path,
) -> Result<AssetManifest, AssetError> {
    let mut blobs = Vec::new();
    let mut records = Vec::new();

    for (id, kind, path) in files {
        let data = fs::read(path)?;
        let offset = blobs.len() as u64;
        let len = data.len() as u64;
        blobs.extend_from_slice(&data);
        records.push(AssetRecord {
            id: id.clone(),
            kind: kind.clone(),
            source: path.display().to_string(),
            hash: stable_hash(&data),
            offset,
            len,
        });
    }

    let manifest = AssetManifest {
        version: 1,
        records,
    };
    let manifest_json = serde_json::to_vec(&manifest)?;

    let mut file = fs::File::create(out)?;
    file.write_all(PAK_MAGIC)?;
    file.write_all(&(manifest_json.len() as u64).to_le_bytes())?;
    file.write_all(&manifest_json)?;
    file.write_all(&blobs)?;
    Ok(manifest)
}

pub fn read_pak(path: &Path) -> Result<(AssetManifest, Vec<u8>), AssetError> {
    let mut file = fs::File::open(path)?;
    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)?;
    if &magic != PAK_MAGIC {
        return Err(AssetError::InvalidMagic);
    }

    let mut len_bytes = [0u8; 8];
    file.read_exact(&mut len_bytes)?;
    let manifest_len = u64::from_le_bytes(len_bytes) as usize;
    let mut manifest_bytes = vec![0u8; manifest_len];
    file.read_exact(&mut manifest_bytes)?;
    let manifest = serde_json::from_slice(&manifest_bytes)?;

    let mut blobs = Vec::new();
    file.read_to_end(&mut blobs)?;
    Ok((manifest, blobs))
}

pub fn read_asset<'a>(
    manifest: &AssetManifest,
    blobs: &'a [u8],
    id: &AssetId,
) -> Result<&'a [u8], AssetError> {
    let record = manifest
        .records
        .iter()
        .find(|record| &record.id == id)
        .ok_or_else(|| AssetError::Missing(id.0.clone()))?;
    let start = record.offset as usize;
    let end = start + record.len as usize;
    Ok(&blobs[start..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pak_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("map.p3dworld");
        fs::write(&source, b"world").unwrap();
        let out = dir.path().join("game.p3dpak");
        let manifest = write_pak(
            &[(
                AssetId("maps/test".to_string()),
                "p3dworld".to_string(),
                source,
            )],
            &out,
        )
        .unwrap();
        assert_eq!(manifest.records.len(), 1);
        let (read_manifest, blobs) = read_pak(&out).unwrap();
        assert_eq!(
            read_asset(&read_manifest, &blobs, &AssetId("maps/test".to_string())).unwrap(),
            b"world"
        );
    }
}
