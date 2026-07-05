//! Headless harness: offscreen rendering + scripted-input acceptance tests.
//! This is how CI (and the agent that built this) verifies the game plays.

use anyhow::{Context, Result, bail};
use pocket3d::input::Input;
use pocket3d::prelude::*;
use pocket3d::winit::event::MouseButton;
use pocket3d::winit::keyboard::KeyCode;

use crate::args::Args;
use crate::bot::Bot;
use crate::game::{OpenStrike, Phase};

pub struct Headless {
    pub gpu: Gpu,
    pub target: OffscreenTarget,
    pub renderer: Renderer,
}

impl Headless {
    pub fn new(size: (u32, u32)) -> Result<Self> {
        let gpu = Gpu::new_headless()?;
        let target = OffscreenTarget::new(&gpu, size.0, size.1);
        let renderer = Renderer::new(&gpu, OFFSCREEN_FORMAT)?;
        Ok(Self {
            gpu,
            target,
            renderer,
        })
    }

    pub fn shot(&mut self, game: &mut OpenStrike, time: f32, path: &str) -> Result<()> {
        let size = self.target.size;
        game.compose_base(1.0, time, (size.0 as f32, size.1 as f32));
        self.renderer.render(
            &self.gpu,
            &self.target.view,
            size,
            &game.scene,
            &game.camera,
            &game.hud,
        );
        self.target
            .save_png(&self.gpu, std::path::Path::new(path))?;
        println!("wrote {path}");
        Ok(())
    }
}

const TICK: f32 = 1.0 / 64.0;

fn settle(game: &mut OpenStrike, ticks: u32) {
    let input = Input::default();
    for _ in 0..ticks {
        game.tick(TICK, &input);
    }
}

/// Point the player's view exactly at a world position.
fn aim_at(game: &mut OpenStrike, target: Vec3) {
    let eye = game.player.eye();
    let d = target - eye;
    game.player.yaw = (-d.x).atan2(-d.z);
    game.player.pitch = d.y.atan2((d.x * d.x + d.z * d.z).sqrt());
}

/// One-frame screenshot mode (map viewer).
pub fn run_screenshot(mut game: OpenStrike, args: &Args) -> Result<()> {
    let mut hl = Headless::new(args.size)?;
    game.upload_world(&hl.gpu, &hl.renderer);
    game.sandbox = true;
    game.phase = Phase::Live;
    if args.pos.is_none() {
        settle(&mut game, 48);
    }
    let path = args
        .screenshot
        .clone()
        .context("--screenshot needs a path")?;
    hl.shot(&mut game, 0.5, &path)
}

pub fn run_script(game: OpenStrike, name: &str, args: &Args) -> Result<()> {
    match name {
        "walk" => walk_script(game, args),
        "model" => model_script(game, args),
        "combat" => combat_script(game, args),
        "round" => round_script(game, args),
        "lose" => lose_script(game, args),
        other => bail!("unknown script: {other} (available: walk, model, combat, round, lose)"),
    }
}

/// Place bots at CT spawns near the player so an encounter is guaranteed
/// within the scripted time budget.
fn place_bots_near_player(game: &mut OpenStrike, count: usize) {
    game.bots.clear();
    let spawns = game.map.ct_spawns.clone();
    if spawns.is_empty() {
        return;
    }
    for i in 0..count {
        let sp = spawns[(4 + i * 4) % spawns.len()];
        game.bots.push(Bot::spawn(sp.pos, sp.yaw));
    }
}

/// Full round acceptance: walk, engage moving bots, eliminate all of them,
/// win the round, and observe the automatic restart.
fn round_script(mut game: OpenStrike, args: &Args) -> Result<()> {
    let mut hl = Headless::new(args.size)?;
    game.upload_world(&hl.gpu, &hl.renderer);
    let base = args.screenshot.clone();

    game.sandbox = false;
    place_bots_near_player(&mut game, 3);
    game.phase = Phase::Starting(0.6);
    let bot_start: Vec<Vec3> = game.bots.iter().map(|b| b.state.pos).collect();

    let mut input = Input::default();
    let mut win_seen = false;
    let mut restart_seen = false;
    let mut first_engagement_shot = false;
    let mut bots_moved = 0.0f32;
    let mut bot_anim_seen = false;
    let mut player_was_hurt = false;

    // Observe the bots' AI for a few seconds before engaging, so the test
    // genuinely covers "meet a moving, animated bot".
    let hold_fire_until = 64 * 4;
    let budget = 64 * 120; // 2 minutes of simulated time
    for tick_no in 0..budget {
        // Steering: run at the nearest living bot, fire when it's visible.
        let player_eye = game.player.eye();
        let target = game
            .bots
            .iter()
            .filter(|b| b.alive())
            .min_by(|a, b| {
                let da = (a.state.pos - player_eye).length_squared();
                let db = (b.state.pos - player_eye).length_squared();
                da.partial_cmp(&db).unwrap()
            })
            .map(|b| (b.state.pos, b.eye()));

        if matches!(game.phase, Phase::Live) {
            if let Some((bot_pos, bot_eye)) = target {
                let chest = bot_pos + Vec3::Y * 8.0;
                aim_at(&mut game, chest);
                let visible = {
                    let tr =
                        game.map
                            .collision
                            .trace(pocket3d::bsp::Hull::Point, player_eye, bot_eye);
                    tr.fraction >= 1.0
                };
                let dist = (bot_pos - player_eye).length();
                let engaging = tick_no >= hold_fire_until;
                input.inject_mouse_button(MouseButton::Left, engaging && visible && dist < 900.0);
                input.inject_key(KeyCode::KeyW, engaging && (!visible || dist > 500.0));
            } else {
                input.inject_mouse_button(MouseButton::Left, false);
                input.inject_key(KeyCode::KeyW, false);
            }
        }

        game.tick(TICK, &input);

        // Instrumentation (only meaningful before the win: the restart
        // teleports bots back to distant spawns).
        if !win_seen && matches!(game.phase, Phase::Live) {
            for (i, b) in game.bots.iter().enumerate() {
                if let Some(start) = bot_start.get(i) {
                    bots_moved = bots_moved.max((b.state.pos - *start).length());
                }
                if b.anim.speed > 0.0 {
                    bot_anim_seen = true;
                }
            }
        }
        if game.player.health < 100 {
            player_was_hurt = true;
        }
        if game.fired_this_tick && !first_engagement_shot {
            first_engagement_shot = true;
            if let Some(b) = &base {
                hl.shot(&mut game, tick_no as f32 * TICK, &format!("{b}.engage.png"))?;
            }
        }
        if matches!(game.phase, Phase::Ended { won: true, .. }) {
            if !win_seen {
                println!(
                    "PASS round: all bots eliminated at t={:.1}s (score W{} L{})",
                    tick_no as f32 * TICK,
                    game.score.wins,
                    game.score.losses
                );
                if let Some(b) = &base {
                    hl.shot(&mut game, tick_no as f32 * TICK, &format!("{b}.win.png"))?;
                }
            }
            win_seen = true;
            input.inject_mouse_button(MouseButton::Left, false);
            input.inject_key(KeyCode::KeyW, false);
        }
        if win_seen && matches!(game.phase, Phase::Starting(_)) {
            restart_seen = true;
            if let Some(b) = &base {
                hl.shot(
                    &mut game,
                    tick_no as f32 * TICK,
                    &format!("{b}.restart.png"),
                )?;
            }
            break;
        }
    }

    if !win_seen {
        bail!(
            "FAIL round: never won (alive bots {}, player hp {}, phase {:?})",
            game.alive_bots(),
            game.player.health,
            game.phase
        );
    }
    if !restart_seen {
        bail!("FAIL round: no automatic restart after winning");
    }
    if bots_moved < 60.0 {
        bail!("FAIL round: bots barely moved ({bots_moved:.0} units)");
    }
    if !bot_anim_seen {
        bail!("FAIL round: bot walk animation never played");
    }
    println!("PASS round: bots moved up to {bots_moved:.0} units and animated");
    if player_was_hurt {
        println!("PASS round: bots fought back (player took damage)");
    }

    // Post-restart state.
    if game.score.wins != 1 {
        bail!("FAIL round: score.wins = {} (expected 1)", game.score.wins);
    }
    if game.alive_bots() != game.bots.len() || game.bots.is_empty() {
        bail!("FAIL round: bots not respawned after restart");
    }
    if game.player.health != 100 || !game.player.alive {
        bail!("FAIL round: player not reset after restart");
    }
    println!(
        "PASS round: auto-restart respawned {} bots, player at full health",
        game.bots.len()
    );
    println!("ROUND SCRIPT PASSED");
    Ok(())
}

/// Losing path: stand still and unarmed until the bots win the round, then
/// verify the automatic restart.
fn lose_script(mut game: OpenStrike, args: &Args) -> Result<()> {
    let mut hl = Headless::new(args.size)?;
    game.upload_world(&hl.gpu, &hl.renderer);
    let base = args.screenshot.clone();

    game.sandbox = false;
    place_bots_near_player(&mut game, 3);
    game.phase = Phase::Starting(0.6);

    let input = Input::default();
    let mut lose_seen = false;
    let budget = 64 * 150;
    for tick_no in 0..budget {
        game.tick(TICK, &input);
        if matches!(game.phase, Phase::Ended { won: false, .. }) {
            if !lose_seen {
                println!(
                    "PASS lose: player died at t={:.1}s (score W{} L{})",
                    tick_no as f32 * TICK,
                    game.score.wins,
                    game.score.losses
                );
                if let Some(b) = &base {
                    hl.shot(&mut game, tick_no as f32 * TICK, &format!("{b}.death.png"))?;
                }
            }
            lose_seen = true;
        }
        if lose_seen && matches!(game.phase, Phase::Starting(_)) {
            break;
        }
    }

    if !lose_seen {
        bail!(
            "FAIL lose: player survived 150s standing still (hp {}, bots alive {})",
            game.player.health,
            game.alive_bots()
        );
    }
    if game.score.losses != 1 {
        bail!(
            "FAIL lose: score.losses = {} (expected 1)",
            game.score.losses
        );
    }
    if !game.player.alive || game.player.health != 100 {
        bail!("FAIL lose: player not revived after restart");
    }
    println!("PASS lose: round lost and auto-restarted cleanly");
    println!("LOSE SCRIPT PASSED");
    Ok(())
}

/// Movement acceptance: settle on ground, run forward, never clip into
/// solid, jump and land.
fn walk_script(mut game: OpenStrike, args: &Args) -> Result<()> {
    let mut hl = Headless::new(args.size)?;
    game.upload_world(&hl.gpu, &hl.renderer);
    game.sandbox = true;
    game.phase = Phase::Live;
    game.bots.clear();
    let shot_base = args.screenshot.clone();

    // 1) Settle onto the ground.
    settle(&mut game, 64);
    let p0 = game.player.state.pos;
    if !game.player.state.on_ground {
        bail!("FAIL settle: not on ground after 1s (pos {p0:?})");
    }
    println!("PASS settle: on ground at {p0:?}");
    if let Some(base) = &shot_base {
        hl.shot(&mut game, 0.0, &format!("{base}.settle.png"))?;
    }

    // 2) Run forward for 2s.
    let mut input = Input::default();
    input.inject_key(KeyCode::KeyW, true);
    let mut min_contents_ok = true;
    for _ in 0..128 {
        game.tick(TICK, &input);
        let eye = game.player.state.pos + Vec3::Y * 20.0;
        if game.map.collision.point_contents(eye) == -2 {
            min_contents_ok = false;
        }
    }
    let p1 = game.player.state.pos;
    let moved = Vec2::new(p1.x - p0.x, p1.z - p0.z).length();
    if moved < 200.0 {
        bail!("FAIL run: only moved {moved:.0} units in 2s");
    }
    if !min_contents_ok {
        bail!("FAIL run: eye entered solid during movement");
    }
    println!(
        "PASS run: moved {moved:.0} units, speed ~{:.0} u/s",
        moved / 2.0
    );

    // 3) Keep running into whatever is ahead for 6s; we must never leave the
    // map, never NaN, never end up inside solid.
    for i in 0..384 {
        game.tick(TICK, &input);
        let pos = game.player.state.pos;
        if !pos.is_finite() {
            bail!("FAIL slide: position NaN at tick {i}");
        }
        let (mins, maxs) = game.map.bounds;
        if pos.cmplt(mins - Vec3::splat(64.0)).any() || pos.cmpgt(maxs + Vec3::splat(64.0)).any() {
            bail!("FAIL slide: escaped map bounds at {pos:?}");
        }
        if game
            .map
            .collision
            .hull_contents(pocket3d::bsp::Hull::Stand, pos)
            == -2
        {
            bail!("FAIL slide: hull stuck in solid at {pos:?}");
        }
    }
    println!(
        "PASS slide: 6s of wall-sliding stayed in bounds, final {:?}",
        game.player.state.pos
    );
    input.inject_key(KeyCode::KeyW, false);
    if let Some(base) = &shot_base {
        hl.shot(&mut game, 8.0, &format!("{base}.run.png"))?;
    }

    // 4) Jump: gain height, land within 1.5s.
    settle(&mut game, 32);
    let ground_y = game.player.state.pos.y;
    input.inject_key(KeyCode::Space, true);
    game.tick(TICK, &input);
    input.inject_key(KeyCode::Space, false);
    if game.player.state.vel.y <= 100.0 {
        bail!("FAIL jump: vy {} after jump", game.player.state.vel.y);
    }
    let mut peak = ground_y;
    let mut landed_at = None;
    for i in 0..96 {
        game.tick(TICK, &input);
        peak = peak.max(game.player.state.pos.y);
        if game.player.state.on_ground && i > 4 {
            landed_at = Some(i);
            break;
        }
    }
    let Some(landed) = landed_at else {
        bail!("FAIL jump: never landed (pos {:?})", game.player.state.pos);
    };
    let height = peak - ground_y;
    if !(20.0..80.0).contains(&height) {
        bail!("FAIL jump: peak height {height:.1} units (expected ~45)");
    }
    println!(
        "PASS jump: height {height:.1} units, landed after {:.2}s",
        landed as f32 * TICK
    );

    println!("WALK SCRIPT PASSED");
    Ok(())
}

/// Skeletal animation acceptance: a bot mid-stride at two different clip
/// times must produce clearly different screenshots.
fn model_script(mut game: OpenStrike, args: &Args) -> Result<()> {
    let mut hl = Headless::new(args.size)?;
    game.upload_world(&hl.gpu, &hl.renderer);
    game.sandbox = true;
    game.phase = Phase::Live;
    game.bots.clear();
    game.bot_asset.clone().context("bot model missing")?;
    settle(&mut game, 48);

    let base = args
        .screenshot
        .clone()
        .context("--screenshot needs a base path")?;
    // A bot 130 units ahead of the player, facing the camera.
    let p = &game.player;
    let bot_pos = p.state.pos + p.forward_flat() * 130.0;
    let face_yaw = p.yaw + std::f32::consts::PI;

    let mut shots = Vec::new();
    for (tag, t) in [("a", 0.25f32), ("b", 0.75f32)] {
        game.bots.clear();
        let mut bot = Bot::spawn(bot_pos, face_yaw);
        bot.anim = AnimState {
            clip: 0,
            time: t,
            speed: 0.0,
            looping: true,
        };
        game.bots.push(bot);
        let path = format!("{base}.pose_{tag}.png");
        hl.shot(&mut game, t, &path)?;
        shots.push(hl.target.read_rgba(&hl.gpu)?);
    }

    // The two poses must differ on a meaningful number of pixels.
    let diff = shots[0]
        .chunks_exact(4)
        .zip(shots[1].chunks_exact(4))
        .filter(|(a, b)| (a[0] as i32 - b[0] as i32).abs() + (a[1] as i32 - b[1] as i32).abs() > 24)
        .count();
    let total = (args.size.0 * args.size.1) as usize;
    let pct = diff as f32 / total as f32 * 100.0;
    if pct < 0.05 {
        bail!("FAIL model: poses at t=0.25 and t=0.75 differ on only {pct:.3}% of pixels");
    }
    println!("PASS model: animation poses differ on {pct:.2}% of pixels");
    println!("MODEL SCRIPT PASSED");
    Ok(())
}

/// Combat acceptance: aim at a bot, hold fire, watch it take damage and die.
fn combat_script(mut game: OpenStrike, args: &Args) -> Result<()> {
    let mut hl = Headless::new(args.size)?;
    game.upload_world(&hl.gpu, &hl.renderer);
    game.sandbox = true;
    game.phase = Phase::Live;
    settle(&mut game, 48);

    // One bot in the open, 220 units ahead.
    let bot_pos = game.player.state.pos + game.player.forward_flat() * 220.0;
    game.bots.clear();
    game.bots
        .push(Bot::spawn(bot_pos, game.player.yaw + std::f32::consts::PI));
    settle(&mut game, 8); // let the bot land

    let chest = game.bots[0].state.pos + Vec3::Y * 8.0;
    aim_at(&mut game, chest);

    let base = args.screenshot.clone();
    let hp0 = game.bots[0].health;
    let mut input = Input::default();
    input.inject_mouse_button(MouseButton::Left, true);

    let mut shots_fired = 0;
    let mut flash_shot_taken = false;
    let mut died_after: Option<u32> = None;
    for i in 0..256 {
        // Track the bot in case it moves.
        let target = game.bots[0].state.pos + Vec3::Y * 8.0;
        aim_at(&mut game, target);
        game.tick(TICK, &input);
        if game.fired_this_tick {
            shots_fired += 1;
            if !flash_shot_taken {
                // Capture the frame with a live muzzle flash + tracer.
                if let Some(b) = &base {
                    hl.shot(&mut game, i as f32 * TICK, &format!("{b}.firing.png"))?;
                }
                flash_shot_taken = true;
            }
        }
        if !game.bots[0].alive() {
            died_after = Some(shots_fired);
            break;
        }
    }
    input.inject_mouse_button(MouseButton::Left, false);

    let Some(n) = died_after else {
        bail!(
            "FAIL combat: bot still alive after {shots_fired} shots (hp {} -> {})",
            hp0,
            game.bots[0].health
        );
    };
    if !(1..=10).contains(&n) {
        bail!("FAIL combat: took {n} shots to kill (expected 1..=10)");
    }
    println!("PASS combat: bot eliminated after {n} shots");

    // Corpse should fall; capture it.
    settle(&mut game, 48);
    if let Some(b) = &base {
        hl.shot(&mut game, 5.0, &format!("{b}.corpse.png"))?;
    }
    if game.alive_bots() != 0 {
        bail!("FAIL combat: alive_bots != 0 after kill");
    }
    println!("COMBAT SCRIPT PASSED");
    Ok(())
}
