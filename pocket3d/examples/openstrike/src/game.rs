//! Game state: player, bots, weapon, round loop, HUD.

use std::sync::Arc;

use pocket3d::bsp::MapData;
use pocket3d::input::Input;
use pocket3d::prelude::*;
use pocket3d::winit::event::MouseButton;
use pocket3d::winit::keyboard::KeyCode;

use crate::bot::Bot;
use crate::weapon::{EffectKind, Effects, MUZZLE_LOCAL, RANGE, Rng, Weapon, build_rifle};

pub const MOUSE_SENS: f32 = 0.002;
pub const WALK_SPEED_SCALE: f32 = 0.52;
const ROUND_FREEZE: f32 = 1.2;
const ROUND_END_PAUSE: f32 = 3.5;
const BOT_HALF: Vec3 = Vec3::new(16.0, 36.0, 16.0);

pub struct Player {
    pub state: CharacterState,
    pub prev_pos: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub params: MoveParams,
    pub health: i32,
    pub alive: bool,
}

impl Player {
    pub fn spawn(pos: Vec3, yaw: f32) -> Self {
        Self {
            state: CharacterState::new(pos),
            prev_pos: pos,
            yaw,
            pitch: 0.0,
            params: MoveParams::default(),
            health: 100,
            alive: true,
        }
    }

    pub fn eye_interpolated(&self, alpha: f32) -> Vec3 {
        self.prev_pos.lerp(self.state.pos, alpha) + Vec3::Y * self.params.eye_height
    }

    pub fn eye(&self) -> Vec3 {
        self.state.pos + Vec3::Y * self.params.eye_height
    }

    pub fn forward_flat(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(-sy, 0.0, -cy)
    }

    pub fn right(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        Vec3::new(cy, 0.0, -sy)
    }

    pub fn view_dir(&self) -> Vec3 {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        Vec3::new(-sy * cp, sp, -cy * cp)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Phase {
    /// Round countdown; movement frozen.
    Starting(f32),
    Live,
    Ended {
        won: bool,
        timer: f32,
    },
}

#[derive(Default, Clone, Copy)]
pub struct Score {
    pub wins: u32,
    pub losses: u32,
}

pub struct OpenStrike {
    pub map: MapData,
    pub player: Player,
    pub scene: Scene,
    pub camera: Camera,
    pub hud: Hud,
    pub fly_mode: bool,
    pub time: f32,
    pub debug_overlay: bool,

    pub bot_asset: Option<Arc<ModelAsset>>,
    pub rifle_asset: Option<Arc<ModelAsset>>,
    pub bots: Vec<Bot>,
    pub bot_count: usize,
    pub weapon: Weapon,
    pub effects: Effects,
    pub rng: Rng,
    pub phase: Phase,
    pub score: Score,
    /// Disable round transitions (movement/menu-free test harnesses).
    pub sandbox: bool,
    /// Exit the app after this many seconds (smoke tests).
    pub auto_quit: Option<f32>,

    spawn_point: (Vec3, f32),
    damage_flash: f32,
    kill_message: Option<(String, f32)>,
    bob_time: f32,
    pub fired_this_tick: bool,
}

impl OpenStrike {
    pub fn new(map: MapData, spawn_pos: Vec3, spawn_yaw: f32, bot_count: usize) -> Self {
        let mut scene = Scene::default();
        if let Some(sun) = map.sun {
            scene.sky.sun_dir = sun.dir;
            scene.lighting.sun_dir = sun.dir;
            scene.lighting.sun_color = sun.color * 0.9;
        }
        let camera = Camera {
            fov_y: 74f32.to_radians(),
            ..Default::default()
        };
        let mut game = Self {
            map,
            player: Player::spawn(spawn_pos, spawn_yaw),
            scene,
            camera,
            hud: Hud::default(),
            fly_mode: false,
            time: 0.0,
            debug_overlay: false,
            bot_asset: None,
            rifle_asset: None,
            bots: Vec::new(),
            bot_count,
            weapon: Weapon::default(),
            effects: Effects::default(),
            rng: Rng(0x0DDB1A5E5BAD5EED),
            phase: Phase::Starting(ROUND_FREEZE),
            score: Score::default(),
            sandbox: false,
            auto_quit: None,
            spawn_point: (spawn_pos, spawn_yaw),
            damage_flash: 0.0,
            kill_message: None,
            bob_time: 0.0,
            fired_this_tick: false,
        };
        game.spawn_bots();
        game
    }

    /// Upload GPU resources (called from `Game::init` or headless setup).
    pub fn upload_world(&mut self, gpu: &Gpu, renderer: &Renderer) {
        let world = Arc::new(WorldModel::from_bsp(
            gpu,
            &renderer.world_material_layout,
            &renderer.samplers,
            &self.map,
        ));
        self.scene.world = Some(world);
        self.rifle_asset = Some(build_rifle(gpu, renderer));

        match crate::args::find_asset("models/CesiumMan.glb") {
            Some(path) => {
                match ModelAsset::load_glb(
                    gpu,
                    &renderer.model_material_layout,
                    &renderer.samplers,
                    &path,
                ) {
                    Ok(asset) => self.bot_asset = Some(asset),
                    Err(e) => log::warn!("bot model failed to load: {e:#}"),
                }
            }
            None => {
                log::warn!("bot model not found (models/CesiumMan.glb); bots render as nothing")
            }
        }
    }

    fn spawn_bots(&mut self) {
        self.bots.clear();
        let spawns = if self.map.t_spawns.is_empty() {
            &self.map.ct_spawns
        } else {
            &self.map.t_spawns
        };
        if spawns.is_empty() {
            return;
        }
        for i in 0..self.bot_count {
            // Spread bots over the spawn list.
            let sp = spawns[(i * 3 + 1) % spawns.len()];
            self.bots.push(Bot::spawn(sp.pos, sp.yaw));
        }
    }

    pub fn reset_round(&mut self) {
        let (pos, yaw) = self.spawn_point;
        let pitch = self.player.pitch;
        self.player = Player::spawn(pos, yaw);
        self.player.pitch = pitch * 0.25;
        self.weapon.reset();
        self.effects.clear();
        self.spawn_bots();
        self.phase = Phase::Starting(ROUND_FREEZE);
        self.damage_flash = 0.0;
        self.kill_message = None;
    }

    pub fn apply_look(&mut self, dx: f32, dy: f32) {
        self.player.yaw -= dx * MOUSE_SENS;
        self.player.pitch =
            (self.player.pitch - dy * MOUSE_SENS).clamp(-89f32.to_radians(), 89f32.to_radians());
    }

    pub fn alive_bots(&self) -> usize {
        self.bots.iter().filter(|b| b.alive()).count()
    }

    /// Full fixed-step game tick.
    pub fn tick(&mut self, dt: f32, input: &Input) {
        self.time += dt;
        self.effects.tick(dt);
        self.weapon.tick(dt);
        self.damage_flash = (self.damage_flash - dt * 1.6).max(0.0);
        if let Some((_, t)) = &mut self.kill_message {
            *t -= dt;
            if *t <= 0.0 {
                self.kill_message = None;
            }
        }
        if input.key_pressed(KeyCode::KeyV) {
            self.fly_mode = !self.fly_mode;
        }

        // Round phase.
        let mut movement_frozen = false;
        let mut do_reset = false;
        match &mut self.phase {
            Phase::Starting(t) => {
                *t -= dt;
                movement_frozen = true;
                if *t <= 0.0 {
                    self.phase = Phase::Live;
                }
            }
            Phase::Live => {}
            Phase::Ended { timer, .. } => {
                *timer -= dt;
                do_reset = *timer <= 0.0;
            }
        }
        if do_reset && !self.sandbox {
            self.reset_round();
            return;
        }

        self.tick_player_movement(dt, input, movement_frozen);

        // Combat.
        self.fired_this_tick = false;
        let live = self.phase == Phase::Live;
        if live && self.player.alive && !movement_frozen {
            if input.key_pressed(KeyCode::KeyR) {
                self.weapon.trigger_reload();
            }
            if input.mouse_button_down(MouseButton::Left) && self.weapon.fire() {
                self.fire_shot();
            }
        }

        // Bots.
        let player_eye = self.player.eye();
        let player_alive = self.player.alive;
        let mut incoming = 0i32;
        for bot in &mut self.bots {
            let shot = bot.tick(
                &self.map.collision,
                player_eye,
                player_alive && live,
                dt,
                &mut self.rng,
                &mut self.effects,
            );
            if live && let Some(s) = shot {
                incoming += s.damage;
            }
        }
        if incoming > 0 && self.player.alive {
            self.player.health -= incoming;
            self.damage_flash = (self.damage_flash + 0.45).min(0.9);
            if self.player.health <= 0 {
                self.player.health = 0;
                self.player.alive = false;
                self.score.losses += 1;
                self.phase = Phase::Ended {
                    won: false,
                    timer: ROUND_END_PAUSE,
                };
            }
        }

        // Soft push-out so bots don't share space with the player.
        if self.player.alive {
            for bot in self.bots.iter().filter(|b| b.alive()) {
                let d = self.player.state.pos - bot.state.pos;
                let horiz = Vec3::new(d.x, 0.0, d.z);
                let dist = horiz.length();
                if dist < 34.0 && d.y.abs() < 72.0 && dist > 0.001 {
                    self.player.state.pos += horiz / dist * (34.0 - dist) * 0.35;
                }
            }
        }

        // Win check.
        if live && !self.bots.is_empty() && self.alive_bots() == 0 {
            self.score.wins += 1;
            self.phase = Phase::Ended {
                won: true,
                timer: ROUND_END_PAUSE,
            };
        }
    }

    fn tick_player_movement(&mut self, dt: f32, input: &Input, frozen: bool) {
        let p = &mut self.player;
        p.prev_pos = p.state.pos;
        if !p.alive {
            return;
        }

        let mut wish = Vec3::ZERO;
        if !frozen {
            if input.key_down(KeyCode::KeyW) {
                wish += p.forward_flat();
            }
            if input.key_down(KeyCode::KeyS) {
                wish -= p.forward_flat();
            }
            if input.key_down(KeyCode::KeyD) {
                wish += p.right();
            }
            if input.key_down(KeyCode::KeyA) {
                wish -= p.right();
            }
        }

        if self.fly_mode {
            let mut v = Vec3::ZERO;
            if input.key_down(KeyCode::KeyW) {
                v += p.view_dir() * 600.0;
            }
            if input.key_down(KeyCode::KeyS) {
                v -= p.view_dir() * 600.0;
            }
            if input.key_down(KeyCode::KeyD) {
                v += p.right() * 600.0;
            }
            if input.key_down(KeyCode::KeyA) {
                v -= p.right() * 600.0;
            }
            if input.key_down(KeyCode::Space) {
                v += Vec3::Y * 400.0;
            }
            p.state.pos += v * dt;
            p.state.vel = Vec3::ZERO;
            return;
        }

        let minput = MoveInput {
            wish_dir: wish,
            speed: if input.key_down(KeyCode::ShiftLeft) {
                WALK_SPEED_SCALE
            } else {
                1.0
            },
            jump: !frozen && input.key_down(KeyCode::Space),
        };
        step_character(
            &self.map.collision,
            HullKind::Stand,
            &mut p.state,
            &p.params,
            &minput,
            dt,
        );

        // Weapon bob clock follows ground speed.
        let speed = (p.state.vel.x * p.state.vel.x + p.state.vel.z * p.state.vel.z).sqrt();
        if p.state.on_ground {
            self.bob_time += dt * (speed / 250.0) * 11.0;
        }
    }

    fn fire_shot(&mut self) {
        self.fired_this_tick = true;
        let p = &self.player;
        let eye = p.eye();
        let dir = p.view_dir();
        let right = p.right();
        let up = right.cross(dir).normalize_or_zero();

        // Spread: base + recoil + movement penalty.
        let speed = (p.state.vel.x * p.state.vel.x + p.state.vel.z * p.state.vel.z).sqrt();
        let spread = 0.006
            + self.weapon.recoil * 0.014
            + (speed / 250.0) * 0.02
            + if p.state.on_ground { 0.0 } else { 0.03 };
        let dir = (dir + right * self.rng.signed() * spread + up * self.rng.signed() * spread)
            .normalize();

        // World hit.
        let wt = self
            .map
            .collision
            .trace(pocket3d::bsp::Hull::Point, eye, eye + dir * RANGE);
        let mut best_t = wt.fraction * RANGE;
        let mut hit_bot: Option<usize> = None;
        for (i, bot) in self.bots.iter().enumerate() {
            if !bot.alive() {
                continue;
            }
            let c = bot.state.pos;
            if let Some(t) = ray_aabb(eye, dir, c - BOT_HALF, c + BOT_HALF)
                && t < best_t
            {
                best_t = t;
                hit_bot = Some(i);
            }
        }
        let hit_point = eye + dir * best_t;

        // Effects: muzzle flash + tracer + impact.
        let muzzle = self.viewmodel_transform().transform_point3(MUZZLE_LOCAL);
        self.effects
            .spawn(EffectKind::MuzzleFlash { pos: muzzle }, 0.06);
        self.effects.spawn(
            EffectKind::Tracer {
                a: muzzle,
                b: hit_point,
            },
            0.07,
        );

        if let Some(i) = hit_bot {
            let bot = &mut self.bots[i];
            let headshot = hit_point.y > bot.state.pos.y + 22.0;
            let dmg = if headshot {
                crate::weapon::DAMAGE_HEAD
            } else {
                crate::weapon::DAMAGE_BODY
            };
            let died = bot.hurt(dmg);
            self.effects
                .spawn(EffectKind::BloodPuff { pos: hit_point }, 0.22);
            if died {
                self.kill_message = Some((
                    if headshot {
                        "HEADSHOT - BOT ELIMINATED".to_string()
                    } else {
                        "BOT ELIMINATED".to_string()
                    },
                    2.0,
                ));
            }
        } else if wt.fraction < 1.0 {
            self.effects
                .spawn(EffectKind::Impact { pos: hit_point }, 0.16);
        }

        // Camera kick.
        self.player.pitch = (self.player.pitch + 0.0045).min(89f32.to_radians());
    }

    /// Viewmodel placement: camera-anchored with bob, recoil, and reload dip.
    fn viewmodel_transform(&self) -> Mat4 {
        let p = &self.player;
        let eye = p.eye();
        let speed = (p.state.vel.x * p.state.vel.x + p.state.vel.z * p.state.vel.z).sqrt();
        let bob_amp = (speed / 250.0).min(1.0) * if p.state.on_ground { 1.0 } else { 0.2 };
        let bob_y = (self.bob_time * 2.0).sin() * 0.55 * bob_amp;
        let bob_x = self.bob_time.cos() * 0.4 * bob_amp;

        let recoil = self.weapon.recoil;
        let reload = if self.weapon.reloading() {
            let f = 1.0 - (self.weapon.reload_left / crate::weapon::RELOAD_TIME).clamp(0.0, 1.0);
            (f * std::f32::consts::PI).sin()
        } else {
            0.0
        };

        Mat4::from_translation(eye)
            * Mat4::from_rotation_y(p.yaw)
            * Mat4::from_rotation_x(p.pitch)
            * Mat4::from_translation(Vec3::new(
                7.2 + bob_x,
                -7.0 + bob_y - reload * 4.5,
                -8.5 + recoil * 2.8,
            ))
            * Mat4::from_rotation_x(recoil * 0.10 - reload * 0.55)
            * Mat4::from_rotation_y(-0.03)
    }

    /// Build camera, scene models/effects, and HUD for the current frame.
    pub fn compose_base(&mut self, alpha: f32, time: f32, screen: (f32, f32)) {
        self.scene.time = time;
        self.camera.pos = self.player.eye_interpolated(alpha);
        self.camera.yaw = self.player.yaw;
        self.camera.pitch = self.player.pitch;

        // Bots.
        self.scene.models.clear();
        if let Some(asset) = &self.bot_asset {
            for bot in &self.bots {
                let mut inst = ModelInstance::new(asset.clone());
                inst.transform = bot.transform(asset);
                inst.anim = bot.anim;
                inst.tint = bot.tint();
                self.scene.models.push(inst);
            }
        }

        // Viewmodel.
        self.scene.viewmodel = match (&self.rifle_asset, self.player.alive) {
            (Some(rifle), true) => {
                let mut vm = ModelInstance::new(rifle.clone());
                vm.transform = self.viewmodel_transform();
                vm.lit = 1.0;
                Some(vm)
            }
            _ => None,
        };

        // Effects.
        self.scene.sprites.clear();
        self.scene.beams.clear();
        self.effects
            .emit(&mut self.scene.sprites, &mut self.scene.beams);

        self.compose_hud(screen);
    }

    fn compose_hud(&mut self, screen: (f32, f32)) {
        let (w, h) = screen;
        let alive_bots = self.alive_bots();
        let total_bots = self.bots.len();
        let hud = &mut self.hud;
        hud.clear();

        let white = [1.0, 1.0, 1.0, 0.92];
        let amber = [1.0, 0.8, 0.35, 1.0];
        let red = [1.0, 0.25, 0.2, 0.95];
        let green = [0.55, 1.0, 0.45, 0.95];
        let shadow = [0.0, 0.0, 0.0, 0.45];

        // Damage flash + death desaturation.
        if self.damage_flash > 0.0 {
            hud.rect(0.0, 0.0, w, h, [0.8, 0.05, 0.05, self.damage_flash * 0.45]);
        }
        if !self.player.alive {
            hud.rect(0.0, 0.0, w, h, [0.1, 0.02, 0.02, 0.35]);
        }

        // Crosshair (dynamic gap).
        if self.player.alive {
            let gap = 6.0 + self.weapon.recoil * 14.0;
            hud.crosshair(w / 2.0, h / 2.0, gap, 11.0, 2.0, green);
        }

        // Health (bottom-left).
        let hp = self.player.health.max(0);
        let hp_col = if hp > 60 {
            white
        } else if hp > 25 {
            amber
        } else {
            red
        };
        hud.rect(24.0, h - 64.0, 208.0, 40.0, shadow);
        hud.text(32.0, h - 56.0, 3.0, hp_col, &format!("+{hp:3}"));
        hud.rect(136.0, h - 52.0, 84.0, 16.0, [0.2, 0.2, 0.2, 0.7]);
        hud.rect(136.0, h - 52.0, hp as f32 / 100.0 * 84.0, 16.0, hp_col);

        // Ammo (bottom-right).
        hud.rect(w - 262.0, h - 64.0, 238.0, 40.0, shadow);
        let ammo_col = if self.weapon.ammo == 0 { red } else { white };
        hud.text(
            w - 252.0,
            h - 56.0,
            3.0,
            ammo_col,
            &format!("{:2} / {:<3}", self.weapon.ammo, self.weapon.reserve),
        );
        if self.weapon.reloading() {
            hud.text_centered(w - 143.0, h - 88.0, 2.0, amber, "RELOADING");
        }

        // Score + bots alive (top-right).
        hud.rect(w - 300.0, 16.0, 284.0, 58.0, shadow);
        hud.text(
            w - 288.0,
            24.0,
            2.0,
            white,
            &format!("WON {:2}  LOST {:2}", self.score.wins, self.score.losses),
        );
        hud.text(
            w - 288.0,
            48.0,
            2.0,
            amber,
            &format!("HOSTILES {alive_bots}/{total_bots}"),
        );

        // Round banners.
        match self.phase {
            Phase::Starting(t) => {
                hud.text_centered(w / 2.0, h * 0.32, 4.0, white, "ROUND START");
                hud.text_centered(
                    w / 2.0,
                    h * 0.32 + 44.0,
                    2.0,
                    amber,
                    &format!("GO IN {:.0}", t.max(0.0) + 0.99),
                );
            }
            Phase::Ended { won: true, timer } => {
                hud.text_centered(w / 2.0, h * 0.30, 4.0, green, "HOSTILES ELIMINATED");
                hud.text_centered(w / 2.0, h * 0.30 + 44.0, 3.0, white, "ROUND WON");
                hud.text_centered(
                    w / 2.0,
                    h * 0.30 + 84.0,
                    2.0,
                    amber,
                    &format!("NEXT ROUND IN {:.0}", timer.max(0.0) + 0.99),
                );
            }
            Phase::Ended { won: false, timer } => {
                hud.text_centered(w / 2.0, h * 0.30, 4.0, red, "YOU DIED");
                hud.text_centered(w / 2.0, h * 0.30 + 44.0, 3.0, white, "ROUND LOST");
                hud.text_centered(
                    w / 2.0,
                    h * 0.30 + 84.0,
                    2.0,
                    amber,
                    &format!("NEXT ROUND IN {:.0}", timer.max(0.0) + 0.99),
                );
            }
            Phase::Live => {}
        }
        if let Some((msg, t)) = &self.kill_message {
            let a = (*t / 0.4).clamp(0.0, 1.0);
            hud.text_centered(w / 2.0, h * 0.62, 2.0, [1.0, 0.9, 0.5, a], msg);
        }

        if self.debug_overlay {
            let p = &self.player.state;
            let phase = format!("{:?}", self.phase);
            hud.text(
                8.0,
                8.0,
                2.0,
                [1.0, 1.0, 1.0, 0.8],
                &format!(
                    "POS {:6.0} {:6.0} {:6.0}  VEL {:5.0}  {}  {}",
                    p.pos.x,
                    p.pos.y,
                    p.pos.z,
                    (p.vel.x * p.vel.x + p.vel.z * p.vel.z).sqrt(),
                    if p.on_ground { "GND" } else { "AIR" },
                    phase,
                ),
            );
        }
    }
}

/// Slab-method ray/AABB intersection; returns distance along `dir`.
fn ray_aabb(origin: Vec3, dir: Vec3, min: Vec3, max: Vec3) -> Option<f32> {
    let inv = dir.recip();
    let t0 = (min - origin) * inv;
    let t1 = (max - origin) * inv;
    let tmin = t0.min(t1);
    let tmax = t0.max(t1);
    let enter = tmin.x.max(tmin.y).max(tmin.z);
    let exit = tmax.x.min(tmax.y).min(tmax.z);
    if enter <= exit && exit >= 0.0 {
        Some(enter.max(0.0))
    } else {
        None
    }
}
