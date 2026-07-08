//! pocket3d-cook — bake a GoldSrc BSP (+WADs) into the `.p3d` runtime format.
//!
//! ```sh
//! cargo run -p pocket3d-cook -- de_dust2.bsp --wads ~/cs/support -o dust2.p3d
//! cargo run -p pocket3d-cook -- ~/cs/maps/de_dust2.bsp --verify
//! ```
//!
//! WADs are also auto-discovered next to the map (its directory plus sibling
//! `support/` and `wads/`), matching `pocket3d_bsp::load_map`.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use pocket3d_bsp::cook::{CookOptions, cook_map};

fn main() -> ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let mut bsp: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut wad_dirs: Vec<PathBuf> = Vec::new();
    let mut opts = CookOptions::default();
    let mut verify = false;

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "-o" | "--out" => out = Some(args.next().context("--out needs a path")?.into()),
            "--wads" => wad_dirs.push(args.next().context("--wads needs a dir")?.into()),
            "--subdivide" => {
                opts.subdivide = args
                    .next()
                    .context("--subdivide needs a number")?
                    .parse()
                    .context("bad --subdivide value")?;
            }
            "--verify" => verify = true,
            "-h" | "--help" => {
                println!(
                    "usage: pocket3d-cook <map.bsp> [-o out.p3d] [--wads DIR]... \
                     [--subdivide UNITS] [--verify]"
                );
                return Ok(());
            }
            _ if bsp.is_none() => bsp = Some(a.into()),
            _ => bail!("unexpected argument {a:?}"),
        }
    }
    let bsp = bsp.context("no .bsp given (see --help)")?;
    let out = out.unwrap_or_else(|| bsp.with_extension("p3d"));

    let (bytes, stats) = cook_map(&bsp, &wad_dirs, &opts)?;

    if verify {
        let map = pocket3d_bsp::cooked::read(&bytes)
            .map_err(|e| anyhow::anyhow!("verify failed: {e}"))?;
        println!(
            "verify: {} ok — {} leaves, {} visleaves, spawns {}/{}",
            map.name,
            map.vis.leaves.len(),
            map.vis.num_visleaves,
            map.ct_spawns.len(),
            map.t_spawns.len(),
        );
    }

    std::fs::write(&out, &bytes).with_context(|| format!("writing {}", out.display()))?;
    println!(
        "{} -> {} ({:.2} MB)",
        bsp.display(),
        out.display(),
        stats.total_bytes as f64 / 1e6
    );
    println!(
        "  faces {} (+{} skipped)  verts {}  tris {}  batches {}",
        stats.faces_drawn, stats.faces_skipped, stats.vertices, stats.triangles, stats.batches
    );
    println!(
        "  textures {} ({:.0} KB)  vis {:.0} KB  collision {:.0} KB",
        stats.textures,
        stats.texture_bytes as f64 / 1024.0,
        stats.vis_bytes as f64 / 1024.0,
        stats.collision_bytes as f64 / 1024.0
    );
    Ok(())
}
