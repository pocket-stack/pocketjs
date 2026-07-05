use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use openstrike::{OpenStrikeGame, OpenStrikeOptions, run_headless};
use pocket3d_core::{DEFAULT_FIXED_DT, FixedTimestep, InputSnapshot};
use pocket3d_render_wgpu::run_game;
use pocket3d_script::{OpenStrikeConfig, parse_config};

#[derive(Debug, Parser)]
#[command(author, version, about = "OpenStrike: Pocket3D BSP FPS vertical slice")]
struct Args {
    #[arg(
        long,
        env = "OPENSTRIKE_MAP",
        default_value = "~/Downloads/cs-maps-20260705-1836/maps/de_dust2.bsp"
    )]
    map: String,
    #[arg(long = "wad-dir", env = "OPENSTRIKE_WAD_DIR")]
    wad_dir: Vec<String>,
    #[arg(long)]
    config: Option<String>,
    #[arg(long)]
    headless: bool,
    #[arg(long, default_value_t = 600)]
    ticks: u32,
}

fn main() -> Result<()> {
    env_logger::init();
    let args = Args::parse();
    let map = expand_home(&args.map);
    let wad_dirs = if args.wad_dir.is_empty() {
        vec![expand_home("~/Downloads/cs-maps-20260705-1836/support")]
    } else {
        args.wad_dir.iter().map(|path| expand_home(path)).collect()
    };
    let config = if let Some(path) = &args.config {
        parse_config(&std::fs::read_to_string(expand_home(path))?)?
    } else {
        OpenStrikeConfig::default()
    };
    let game = OpenStrikeGame::load(OpenStrikeOptions {
        map,
        wad_dirs,
        config,
    })?;
    eprintln!("{}", game.world.inspect().to_text());

    if args.headless {
        let game = run_headless(game, args.ticks);
        println!(
            "headless result: round={:?} bot_alive={} bot_health={} player_pos={:.1},{:.1},{:.1}",
            game.round,
            game.bot.alive,
            game.bot.health,
            game.player.body.position.x,
            game.player.body.position.y,
            game.player.body.position.z
        );
        anyhow::ensure!(!game.bot.alive, "headless simulation did not kill the bot");
        return Ok(());
    }

    let mut game = game;
    let mut clock = FixedTimestep::new(1.0 / DEFAULT_FIXED_DT);
    run_game(
        "OpenStrike - Pocket3D",
        move |input: &InputSnapshot, frame_dt: f32| {
            let steps = clock.push_frame_time(frame_dt);
            for _ in 0..steps {
                game.fixed_update(input, clock.dt());
            }
            game.scene()
        },
    )
    .context("run OpenStrike window")
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
