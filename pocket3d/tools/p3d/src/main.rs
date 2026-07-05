use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use pocket3d_assets::{AssetId, write_pak};
use pocket3d_bsp::BspWorld;

#[derive(Debug, Parser)]
#[command(author, version, about = "Pocket3D asset and OpenStrike tooling")]
struct Cli {
    #[command(subcommand)]
    command: CommandGroup,
}

#[derive(Debug, Subcommand)]
enum CommandGroup {
    Bsp {
        #[command(subcommand)]
        command: BspCommand,
    },
    Asset {
        #[command(subcommand)]
        command: AssetCommand,
    },
    Openstrike {
        #[command(subcommand)]
        command: OpenStrikeCommand,
    },
}

#[derive(Debug, Subcommand)]
enum BspCommand {
    Inspect {
        map: String,
        #[arg(long = "wad-dir")]
        wad_dir: Vec<String>,
    },
    Build {
        map: String,
        #[arg(long = "wad-path")]
        wad_path: Vec<String>,
        #[arg(long)]
        out: String,
    },
}

#[derive(Debug, Subcommand)]
enum AssetCommand {
    Build {
        asset_dir: String,
        #[arg(long)]
        out: String,
    },
}

#[derive(Debug, Subcommand)]
enum OpenStrikeCommand {
    CheckAssets {
        #[arg(
            long,
            default_value = "~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp"
        )]
        map: String,
        #[arg(long = "wad-dir")]
        wad_dir: Vec<String>,
    },
    Run {
        #[arg(
            long,
            default_value = "~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp"
        )]
        map: String,
        #[arg(long = "wad-dir")]
        wad_dir: Vec<String>,
        #[arg(long)]
        headless: bool,
    },
}

fn main() -> Result<()> {
    env_logger::init();
    let cli = Cli::parse();
    match cli.command {
        CommandGroup::Bsp { command } => match command {
            BspCommand::Inspect { map, wad_dir } => {
                let world = BspWorld::load(expand_home(&map), &expand_all(&wad_dir))?;
                print!("{}", world.inspect().to_text());
            }
            BspCommand::Build { map, wad_path, out } => {
                let world = BspWorld::load(expand_home(&map), &expand_all(&wad_path))?;
                let summary = serde_json::to_vec_pretty(&world.inspect())?;
                fs::write(expand_home(&out), summary)?;
            }
        },
        CommandGroup::Asset { command } => match command {
            AssetCommand::Build { asset_dir, out } => {
                let files = collect_assets(&expand_home(&asset_dir))?;
                let manifest = write_pak(&files, &expand_home(&out))?;
                println!("wrote {} records", manifest.records.len());
            }
        },
        CommandGroup::Openstrike { command } => match command {
            OpenStrikeCommand::CheckAssets { map, wad_dir } => {
                let wad_dirs = default_wads_if_empty(wad_dir);
                let world = BspWorld::load(expand_home(&map), &expand_all(&wad_dirs))?;
                let summary = world.inspect();
                print!("{}", summary.to_text());
                anyhow::ensure!(
                    summary.spawn_point_count > 0,
                    "map has no recognized player spawn points"
                );
                anyhow::ensure!(
                    summary.collision_triangle_count > 0,
                    "map has no collision triangles"
                );
            }
            OpenStrikeCommand::Run {
                map,
                wad_dir,
                headless,
            } => {
                let mut cmd = Command::new("cargo");
                cmd.arg("run")
                    .arg("-p")
                    .arg("openstrike")
                    .arg("--")
                    .arg("--map")
                    .arg(expand_home(&map));
                for dir in expand_all(&default_wads_if_empty(wad_dir)) {
                    cmd.arg("--wad-dir").arg(dir);
                }
                if headless {
                    cmd.arg("--headless");
                }
                let status = cmd.status().context("run cargo openstrike")?;
                anyhow::ensure!(status.success(), "openstrike exited with {status}");
            }
        },
    }
    Ok(())
}

fn collect_assets(root: &Path) -> Result<Vec<(AssetId, String, PathBuf)>> {
    let mut out = Vec::new();
    collect_assets_inner(root, root, &mut out)?;
    Ok(out)
}

fn collect_assets_inner(
    root: &Path,
    dir: &Path,
    out: &mut Vec<(AssetId, String, PathBuf)>,
) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_assets_inner(root, &path, out)?;
            continue;
        }
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let id = rel.to_string_lossy().replace('\\', "/");
        let kind = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("bin")
            .trim_start_matches('.')
            .to_ascii_lowercase();
        out.push((AssetId(id), kind, path));
    }
    Ok(())
}

fn default_wads_if_empty(wad_dir: Vec<String>) -> Vec<String> {
    if wad_dir.is_empty() {
        vec!["~/Downloads/cs-maps-20260705-1836/support".to_string()]
    } else {
        wad_dir
    }
}

fn expand_all(paths: &[String]) -> Vec<PathBuf> {
    paths.iter().map(|path| expand_home(path)).collect()
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}
