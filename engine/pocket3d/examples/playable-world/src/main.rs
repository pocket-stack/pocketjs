//! An original systemic orchard built on `pocket3d-world` + Pocket3D.

mod art;
mod game;

use std::path::PathBuf;

use anyhow::{Context, Result, bail, ensure};
use game::{WorldGame, apply_orchard_script};
use pocket3d::app::{AppConfig, Game};
use pocket3d::gpu::{Gpu, OFFSCREEN_FORMAT, OffscreenTarget};
use pocket3d::input::Input;
use pocket3d::renderer::Renderer;

#[derive(Debug)]
struct Args {
    headless: bool,
    scenario: String,
    ticks: u64,
    seed: u64,
    size: (u32, u32),
    screenshot: Option<PathBuf>,
    receipt: Option<PathBuf>,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            headless: false,
            scenario: "orchard-fire".into(),
            ticks: 720,
            seed: 7,
            size: (1440, 900),
            screenshot: None,
            receipt: None,
        }
    }
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args = parse_args()?;
    if args.headless || args.screenshot.is_some() || args.receipt.is_some() {
        run_headless(args)
    } else {
        pocket3d::app::run(
            AppConfig {
                title: "Pocket3D — Reactive Orchard".into(),
                size: args.size,
                tick_hz: 60.0,
                capture_mouse: true,
                max_fps: Some(60.0),
                ..Default::default()
            },
            WorldGame::new(args.seed),
        )
    }
}

fn run_headless(args: Args) -> Result<()> {
    ensure!(args.ticks > 0, "--ticks must be positive");
    if args.scenario != "orchard-fire" && args.scenario != "idle" {
        bail!(
            "unknown scenario {:?}; expected orchard-fire or idle",
            args.scenario
        );
    }
    let gpu = Gpu::new_headless()?;
    let mut renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT)?;
    let mut game = WorldGame::new(args.seed);
    game.init(&gpu, &mut renderer)?;
    let mut input = Input::default();
    for turn in 0..args.ticks {
        if args.scenario == "orchard-fire" {
            apply_orchard_script(&mut input, turn);
        }
        game.frame(1.0 / 60.0, &input);
        game.tick(1.0 / 60.0, &input);
        input.end_frame();
    }

    if let Some(path) = args.screenshot.as_deref() {
        let target = OffscreenTarget::new(&gpu, args.size.0, args.size.1);
        let (scene, camera, hud) = game.compose(0.0, args.ticks as f32 / 60.0, args.size);
        renderer.render(&gpu, &target.view, args.size, scene, camera, hud);
        target
            .save_png(&gpu, path)
            .with_context(|| format!("writing screenshot {}", path.display()))?;
        println!("playable-world: wrote screenshot {}", path.display());
    }

    let receipt = game.runtime_receipt(args.scenario.clone());
    let receipt_json = serde_json::to_string_pretty(&receipt)?;
    if let Some(path) = args.receipt.as_deref() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        std::fs::write(path, receipt_json.as_bytes())
            .with_context(|| format!("writing receipt {}", path.display()))?;
        println!("playable-world: wrote receipt {}", path.display());
    } else {
        println!("{receipt_json}");
    }
    if args.scenario == "orchard-fire" {
        ensure!(
            receipt.acceptance.playable_chain_complete,
            "orchard-fire acceptance failed: {:#?}",
            receipt.acceptance
        );
    }
    println!(
        "playable-world: {} turns, state {}, systemic acceptance {}",
        receipt.ticks, receipt.state_hash, receipt.acceptance.playable_chain_complete
    );
    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut args = Args::default();
    let mut values = std::env::args().skip(1);
    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--headless" => args.headless = true,
            "--scenario" => {
                args.scenario = values.next().context("--scenario requires a value")?;
            }
            "--ticks" => {
                args.ticks = values
                    .next()
                    .context("--ticks requires a value")?
                    .parse()
                    .context("--ticks must be an integer")?;
            }
            "--seed" => {
                args.seed = values
                    .next()
                    .context("--seed requires a value")?
                    .parse()
                    .context("--seed must be an integer")?;
            }
            "--size" => {
                args.size = parse_size(&values.next().context("--size requires WIDTHxHEIGHT")?)?;
            }
            "--screenshot" => {
                args.screenshot = Some(PathBuf::from(
                    values.next().context("--screenshot requires a path")?,
                ));
            }
            "--receipt" => {
                args.receipt = Some(PathBuf::from(
                    values.next().context("--receipt requires a path")?,
                ));
            }
            "-h" | "--help" => {
                println!(
                    "playable-world\n\n  --headless\n  --scenario orchard-fire|idle\n  --ticks N\n  --seed N\n  --size WIDTHxHEIGHT\n  --screenshot PATH\n  --receipt PATH"
                );
                std::process::exit(0);
            }
            _ => bail!("unknown argument {argument:?}; use --help"),
        }
    }
    ensure!(
        args.size.0 >= 320 && args.size.1 >= 200,
        "--size is too small"
    );
    ensure!(
        args.size.0 <= 4096 && args.size.1 <= 4096,
        "--size is too large"
    );
    Ok(args)
}

fn parse_size(value: &str) -> Result<(u32, u32)> {
    let (width, height) = value
        .split_once(['x', 'X'])
        .context("--size must be WIDTHxHEIGHT")?;
    Ok((
        width.parse().context("invalid width")?,
        height.parse().context("invalid height")?,
    ))
}
