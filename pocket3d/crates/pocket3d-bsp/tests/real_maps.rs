//! Integration tests against real CS 1.6 maps. These only run when
//! POCKET3D_TEST_MAPS points at a directory containing maps/*.bsp and
//! support/*.wad (map data is copyrighted and not part of this repo).

use std::path::PathBuf;

use glam::Vec3;
use pocket3d_bsp::{Hull, load_map};

fn maps_root() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("POCKET3D_TEST_MAPS")?);
    root.exists().then_some(root)
}

#[test]
fn dust2_loads_and_traces() {
    let Some(root) = maps_root() else {
        eprintln!("POCKET3D_TEST_MAPS not set; skipping");
        return;
    };
    let map = load_map(&root.join("maps/de_dust2.bsp"), &[root.join("support")]).unwrap();

    // Geometry sanity.
    assert!(
        map.geometry.stats.triangles > 5_000,
        "{:?}",
        map.geometry.stats
    );
    assert!(map.geometry.batches.len() > 20);
    assert!(!map.geometry.lightmap_pages.is_empty());
    assert!(map.textures.len() > 20);
    let placeholders = map
        .textures
        .iter()
        .filter(|t| t.rgba.chunks_exact(4).next() == Some(&[200, 0, 200, 255]))
        .count();
    assert!(
        placeholders * 10 < map.textures.len(),
        "too many unresolved textures: {placeholders}/{}",
        map.textures.len()
    );

    // Spawns for both teams.
    assert!(!map.ct_spawns.is_empty(), "no CT spawns");
    assert!(!map.t_spawns.is_empty(), "no T spawns");

    // Collision: a standing hull at a CT spawn is in open space, and a
    // downward trace lands on ground within a short distance.
    let spawn = map.ct_spawns[0].pos;
    let contents = map.collision.hull_contents(Hull::Stand, spawn);
    assert_eq!(contents, -1, "spawn hull not in empty space: {contents}");
    let tr = map
        .collision
        .trace(Hull::Stand, spawn, spawn - Vec3::Y * 256.0);
    assert!(tr.fraction < 1.0, "no ground under CT spawn");
    assert!(tr.normal.y > 0.7, "ground normal {:?}", tr.normal);
    assert!(!tr.start_solid);

    // A very long horizontal trace must hit something (the map is sealed).
    let eye = tr.end + Vec3::Y * 28.0;
    let hit = map
        .collision
        .trace(Hull::Point, eye, eye + Vec3::X * 100_000.0);
    assert!(hit.fraction < 1.0, "escaped the map along +X");

    // Sun comes from light_environment.
    assert!(map.sun.is_some(), "dust2 should have light_environment");
}

#[test]
fn all_maps_parse() {
    let Some(root) = maps_root() else {
        eprintln!("POCKET3D_TEST_MAPS not set; skipping");
        return;
    };
    let dir = root.join("maps");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("bsp") {
            continue;
        }
        let map = load_map(&p, &[root.join("support")]).unwrap();
        assert!(
            map.geometry.stats.triangles > 1_000,
            "{}: too few tris",
            map.name
        );
        checked += 1;
    }
    assert!(checked >= 1, "no .bsp files found in {}", dir.display());
}
