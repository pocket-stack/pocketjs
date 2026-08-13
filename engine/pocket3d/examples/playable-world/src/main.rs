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
use winit::keyboard::KeyCode;

const SCENARIOS: &[&str] = &["orchard-fire", "idle", "character-walk", "character-chop"];

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
    if !SCENARIOS.contains(&args.scenario.as_str()) {
        bail!(
            "unknown scenario {:?}; expected one of {}",
            args.scenario,
            SCENARIOS.join(", ")
        );
    }
    let gpu = Gpu::new_headless()?;
    let mut renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT)?;
    let mut game = WorldGame::new(args.seed);
    game.init(&gpu, &mut renderer)?;
    let mut input = Input::default();
    for turn in 0..args.ticks {
        apply_scenario_script(&mut input, &args.scenario, turn);
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
                    "playable-world\n\n  --headless\n  --scenario orchard-fire|idle|character-walk|character-chop\n  --ticks N\n  --seed N\n  --size WIDTHxHEIGHT\n  --screenshot PATH\n  --receipt PATH"
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

fn apply_scenario_script(input: &mut Input, scenario: &str, turn: u64) {
    match scenario {
        "orchard-fire" => apply_orchard_script(input, turn),
        "character-walk" => input.inject_key(KeyCode::KeyW, true),
        "character-chop" => {
            input.inject_key(KeyCode::KeyW, turn < 101);
            input.inject_key(KeyCode::Space, turn == 108);
            if turn == 109 {
                input.inject_key(KeyCode::Space, false);
            }
        }
        "idle" => {}
        _ => unreachable!("scenario was validated before playback"),
    }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use gltf::{Semantic, buffer, mesh};

    use super::*;

    #[test]
    fn character_preview_scripts_exercise_live_input_paths() {
        let mut walk = Input::default();
        apply_scenario_script(&mut walk, "character-walk", 24);
        assert!(walk.key_down(KeyCode::KeyW));

        let mut chop = Input::default();
        apply_scenario_script(&mut chop, "character-chop", 108);
        assert!(chop.key_down(KeyCode::Space));
    }

    #[test]
    fn explorer_glb_contains_the_runtime_rig_contract() {
        let bytes = include_bytes!("../assets/character/explorer.glb");
        let gltf = gltf::Gltf::from_slice(bytes).expect("checked-in explorer.glb must parse");
        assert!(
            gltf.blob.is_some(),
            "the runtime GLB must be self-contained"
        );
        assert!(
            gltf.buffers()
                .all(|buffer| matches!(buffer.source(), buffer::Source::Bin))
        );

        let animation_names: BTreeSet<_> = gltf
            .animations()
            .map(|animation| animation.name().unwrap_or("<unnamed>"))
            .collect();
        assert_eq!(animation_names, BTreeSet::from(["Chop", "Idle", "Walk"]));
        let clip_targets = |name: &str| -> BTreeSet<String> {
            gltf.animations()
                .find(|animation| animation.name() == Some(name))
                .expect("required clip was checked above")
                .channels()
                .filter_map(|channel| channel.target().node().name().map(str::to_owned))
                .collect()
        };
        let walk_targets = clip_targets("Walk");
        assert!(walk_targets.contains("thigh.L") && walk_targets.contains("thigh.R"));
        let chop_targets = clip_targets("Chop");
        assert!(
            chop_targets.contains("upper_arm.R") && chop_targets.contains("forearm.R"),
            "Chop must animate the axe-side arm chain"
        );

        let joint_names: BTreeSet<_> = gltf
            .skins()
            .flat_map(|skin| skin.joints())
            .filter_map(|node| node.name())
            .collect();
        for required in [
            "root",
            "hips",
            "spine",
            "chest",
            "neck",
            "head",
            "upper_arm.L",
            "forearm.L",
            "hand.L",
            "upper_arm.R",
            "forearm.R",
            "hand.R",
            "thigh.L",
            "shin.L",
            "foot.L",
            "thigh.R",
            "shin.R",
            "foot.R",
            "axe.R",
        ] {
            assert!(
                joint_names.contains(required),
                "missing required joint {required}"
            );
        }

        assert!(
            gltf.nodes()
                .filter(|node| node.mesh().is_some())
                .all(|node| node.skin().is_some()),
            "every runtime mesh, including the axe, must be driven by the skin"
        );

        let mut triangles = 0_usize;
        let mut primitive_count = 0_usize;
        let mut skinned_primitives = 0_usize;
        for primitive in gltf.meshes().flat_map(|mesh| mesh.primitives()) {
            primitive_count += 1;
            assert_eq!(primitive.mode(), mesh::Mode::Triangles);
            triangles += primitive
                .indices()
                .or_else(|| primitive.get(&Semantic::Positions))
                .map(|accessor| accessor.count() / 3)
                .unwrap_or_default();
            if primitive.get(&Semantic::Joints(0)).is_some()
                && primitive.get(&Semantic::Weights(0)).is_some()
            {
                skinned_primitives += 1;
            }
        }
        assert!(
            (2_000..=8_000).contains(&triangles),
            "explorer mesh budget changed: {triangles} triangles"
        );
        assert_eq!(
            primitive_count, skinned_primitives,
            "every explorer primitive must carry skin weights"
        );
        assert!(
            primitive_count <= 16,
            "explorer draw-call budget changed: {primitive_count} primitives"
        );
        assert!(
            gltf.materials().count() >= 6,
            "explorer lost authored material separation"
        );

        let (document, buffers, _) = gltf::import_slice(bytes).expect("GLB payload must import");
        let skin = document.skins().next().expect("explorer must have a skin");
        assert_eq!(
            document.skins().count(),
            1,
            "explorer must use one joint palette"
        );
        let axe_joint = skin
            .joints()
            .position(|joint| joint.name() == Some("axe.R"))
            .expect("axe.R must be in the skin") as u16;
        let axe_weighted_vertices = document
            .meshes()
            .flat_map(|mesh| mesh.primitives())
            .map(|primitive| {
                let reader = primitive
                    .reader(|buffer| buffers.get(buffer.index()).map(|data| data.0.as_slice()));
                let joints = reader
                    .read_joints(0)
                    .expect("skinned primitive must have JOINTS_0")
                    .into_u16();
                let weights = reader
                    .read_weights(0)
                    .expect("skinned primitive must have WEIGHTS_0")
                    .into_f32();
                joints
                    .zip(weights)
                    .filter(|(joints, weights)| {
                        (0..4).any(|index| joints[index] == axe_joint && weights[index] > 0.999)
                    })
                    .count()
            })
            .sum::<usize>();
        assert!(
            axe_weighted_vertices >= 100,
            "axe geometry is no longer rigidly bound to axe.R: {axe_weighted_vertices} vertices"
        );
    }
}
