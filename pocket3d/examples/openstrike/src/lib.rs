use std::{path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use glam::{Quat, Vec3};
use pocket3d_anim::{AnimationStateMachine, procedural_humanoid_skeleton};
use pocket3d_bsp::BspWorld;
use pocket3d_core::{Camera, CharacterBody, DEFAULT_FIXED_DT, InputSnapshot, RoundState, Vec2};
use pocket3d_kcc::{BspCharacterController, CharacterController};
use pocket3d_physics::PhysicsWorld;
use pocket3d_render::{HudState, RenderMesh, SceneView};
use pocket3d_script::OpenStrikeConfig;

const WALK_SPEED: f32 = 240.0;
const RUN_SPEED: f32 = 300.0;
const GRAVITY: f32 = 800.0;
const JUMP_SPEED: f32 = 270.0;
const GROUND_ACCEL: f32 = 12.0;
const AIR_ACCEL: f32 = 2.0;
const FRICTION: f32 = 8.0;
const CAPSULE_RADIUS: f32 = 16.0;
const CAPSULE_HEIGHT: f32 = 72.0;
const EYE_HEIGHT: f32 = 64.0;

#[derive(Debug, Clone)]
pub struct OpenStrikeOptions {
    pub map: PathBuf,
    pub wad_dirs: Vec<PathBuf>,
    pub config: OpenStrikeConfig,
}

#[derive(Debug, Clone)]
pub struct PlayerState {
    pub body: CharacterBody,
    pub yaw: f32,
    pub pitch: f32,
    pub health: i32,
}

#[derive(Debug, Clone)]
pub struct BotState {
    pub body: CharacterBody,
    pub health: i32,
    pub alive: bool,
    pub target: Vec3,
    pub anim: AnimationStateMachine,
}

#[derive(Debug, Clone, Copy)]
pub struct WeaponState {
    pub cooldown: f32,
    pub muzzle_flash: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct LastBullet {
    pub from: Vec3,
    pub to: Vec3,
    pub hit_bot: bool,
}

pub struct OpenStrikeGame {
    pub world: Arc<BspWorld>,
    pub config: OpenStrikeConfig,
    pub player: PlayerState,
    pub bot: BotState,
    pub weapon: WeaponState,
    pub round: RoundState,
    pub round_timer: f32,
    pub debug_overlay: bool,
    pub last_bullet: Option<LastBullet>,
    world_meshes: Vec<RenderMesh>,
    player_kcc: BspCharacterController,
    bot_kcc: BspCharacterController,
}

impl OpenStrikeGame {
    pub fn load(options: OpenStrikeOptions) -> Result<Self> {
        let world = Arc::new(
            BspWorld::load(&options.map, &options.wad_dirs)
                .with_context(|| format!("load BSP {}", options.map.display()))?,
        );
        let world_meshes = render_meshes_from_bsp(&world);
        let mut game = Self {
            world,
            config: options.config,
            player: PlayerState {
                body: CharacterBody {
                    position: Vec3::ZERO,
                    velocity: Vec3::ZERO,
                    radius: CAPSULE_RADIUS,
                    height: CAPSULE_HEIGHT,
                    grounded: false,
                },
                yaw: 0.0,
                pitch: 0.0,
                health: 100,
            },
            bot: BotState {
                body: CharacterBody {
                    position: Vec3::ZERO,
                    velocity: Vec3::ZERO,
                    radius: CAPSULE_RADIUS,
                    height: CAPSULE_HEIGHT,
                    grounded: false,
                },
                health: 100,
                alive: true,
                target: Vec3::ZERO,
                anim: AnimationStateMachine::default(),
            },
            weapon: WeaponState {
                cooldown: 0.0,
                muzzle_flash: 0.0,
            },
            round: RoundState::Loading,
            round_timer: 0.0,
            debug_overlay: true,
            last_bullet: None,
            world_meshes,
            player_kcc: BspCharacterController::default(),
            bot_kcc: BspCharacterController::default(),
        };
        game.restart_round();
        Ok(game)
    }

    pub fn fixed_update(&mut self, input: &InputSnapshot, dt: f32) {
        self.round_timer += dt;
        self.weapon.cooldown = (self.weapon.cooldown - dt).max(0.0);
        self.weapon.muzzle_flash = (self.weapon.muzzle_flash - dt).max(0.0);

        if input.debug_toggle {
            self.debug_overlay = !self.debug_overlay;
        }

        match self.round {
            RoundState::PreRound => {
                if self.round_timer >= self.config.round.pre_round_ms as f32 / 1000.0 {
                    self.round = RoundState::Live;
                    self.round_timer = 0.0;
                }
            }
            RoundState::Live => {
                self.update_player(input, dt);
                self.update_bot(dt);
                if input.fire {
                    self.try_fire();
                }
                if !self.bot.alive {
                    self.round = RoundState::PlayerWon;
                    self.round_timer = 0.0;
                } else if self.player.health <= 0 {
                    self.round = RoundState::PlayerLost;
                    self.round_timer = 0.0;
                }
            }
            RoundState::PlayerWon | RoundState::PlayerLost => {
                if self.round_timer >= self.config.round.intermission_ms as f32 / 1000.0 {
                    self.round = RoundState::Restarting;
                    self.round_timer = 0.0;
                    self.restart_round();
                }
            }
            _ => {}
        }
    }

    pub fn scene(&self) -> SceneView {
        let mut scene = SceneView {
            camera: self.camera(),
            world_meshes: self.world_meshes.clone(),
            hud: self.hud(),
            ..SceneView::default()
        };
        scene.world_meshes.push(self.bot_mesh());
        scene.world_meshes.push(self.viewmodel_mesh());
        if let Some(last) = self.last_bullet {
            scene.debug.push(pocket3d_render::DebugPrimitive::Line {
                from: last.from,
                to: last.to,
                color: if last.hit_bot {
                    [0.1, 1.0, 0.25, 1.0]
                } else {
                    [1.0, 0.35, 0.1, 1.0]
                },
            });
        }
        scene
    }

    pub fn camera(&self) -> Camera {
        Camera {
            eye: self.player.body.eye(EYE_HEIGHT),
            yaw: self.player.yaw,
            pitch: self.player.pitch,
            fov_y_radians: 82_f32.to_radians(),
            near: 0.03,
            far: 8192.0,
        }
    }

    pub fn aim_at_bot(&mut self) {
        let eye = self.player.body.eye(EYE_HEIGHT);
        let target = self.bot.body.position + Vec3::Z * 42.0;
        let dir = (target - eye).normalize_or_zero();
        self.player.yaw = dir.y.atan2(dir.x);
        self.player.pitch = dir.z.asin().clamp(-1.45, 1.45);
    }

    pub fn has_won_round(&self) -> bool {
        matches!(
            self.round,
            RoundState::PlayerWon | RoundState::Restarting | RoundState::PreRound
        ) && !self.bot.alive
    }

    fn restart_round(&mut self) {
        let spawn = self.world.first_spawn_or_center() + Vec3::Z * 2.0;
        self.player.body.position = spawn;
        self.player.body.velocity = Vec3::ZERO;
        self.player.body.grounded = false;
        self.player.health = self.config.round.player_health;
        self.player.pitch = 0.0;
        self.player.yaw = 0.0;

        let bot_pos = self.find_open_bot_spawn(spawn);
        self.bot.body.position = bot_pos;
        self.bot.body.velocity = Vec3::ZERO;
        self.bot.body.radius = self.config.bot.capsule_radius;
        self.bot.body.height = self.config.bot.capsule_height;
        self.bot.health = self.config.round.bot_health;
        self.bot.alive = true;
        self.bot.target = spawn + Vec3::new(48.0, 48.0, 0.0);
        self.bot.anim = AnimationStateMachine::default();
        self.weapon = WeaponState {
            cooldown: 0.0,
            muzzle_flash: 0.0,
        };
        self.last_bullet = None;
        self.round = RoundState::PreRound;
        self.round_timer = 0.0;
    }

    fn find_open_bot_spawn(&self, player_pos: Vec3) -> Vec3 {
        let candidates = [
            Vec3::new(128.0, 0.0, 0.0),
            Vec3::new(0.0, 128.0, 0.0),
            Vec3::new(-128.0, 0.0, 0.0),
            Vec3::new(0.0, -128.0, 0.0),
            Vec3::new(192.0, 64.0, 0.0),
            Vec3::new(-192.0, -64.0, 0.0),
        ];
        let eye = player_pos + Vec3::Z * EYE_HEIGHT;
        for offset in candidates {
            let pos = player_pos + offset;
            if !self.world.point_is_solid(pos + Vec3::Z * 32.0)
                && self.world.raycast(eye, pos + Vec3::Z * 42.0).is_none()
            {
                return pos;
            }
        }
        player_pos + Vec3::new(96.0, 0.0, 0.0)
    }

    fn update_player(&mut self, input: &InputSnapshot, dt: f32) {
        self.player.yaw -= input.look_delta.x * 0.0025;
        self.player.pitch = (self.player.pitch - input.look_delta.y * 0.002).clamp(-1.45, 1.45);

        let camera = self.camera();
        let forward = Vec3::new(camera.forward().x, camera.forward().y, 0.0).normalize_or_zero();
        let right = Vec3::new(camera.right().x, camera.right().y, 0.0).normalize_or_zero();
        let wish_dir = (forward * input.movement.y + right * input.movement.x).normalize_or_zero();
        let speed = if input.sprint { RUN_SPEED } else { WALK_SPEED };
        let accel = if self.player.body.grounded {
            GROUND_ACCEL
        } else {
            AIR_ACCEL
        };
        let target_velocity = wish_dir * speed;
        self.player.body.velocity.x +=
            (target_velocity.x - self.player.body.velocity.x) * accel * dt;
        self.player.body.velocity.y +=
            (target_velocity.y - self.player.body.velocity.y) * accel * dt;

        if self.player.body.grounded && wish_dir.length_squared() < 0.01 {
            let drop = (FRICTION * dt).clamp(0.0, 1.0);
            self.player.body.velocity.x *= 1.0 - drop;
            self.player.body.velocity.y *= 1.0 - drop;
        }
        if self.player.body.grounded && input.jump {
            self.player.body.velocity.z = JUMP_SPEED;
            self.player.body.grounded = false;
        } else {
            self.player.body.velocity.z -= GRAVITY * dt;
        }

        let physics = PhysicsWorld::new(&self.world);
        let result = self.player_kcc.move_character(
            &physics,
            self.player.body,
            self.player.body.velocity * dt,
            dt,
        );
        self.player.body.position = result.position;
        self.player.body.velocity = result.velocity;
        self.player.body.grounded = result.grounded;
    }

    fn update_bot(&mut self, dt: f32) {
        if !self.bot.alive {
            self.bot.anim.update(0.0, false, dt);
            return;
        }
        let to_target = self.bot.target - self.bot.body.position;
        let horizontal = Vec3::new(to_target.x, to_target.y, 0.0);
        if horizontal.length() < 24.0 {
            self.bot.target = self.player.body.position;
        }
        let dir = horizontal.normalize_or_zero();
        self.bot.body.velocity.x = dir.x * self.config.bot.speed;
        self.bot.body.velocity.y = dir.y * self.config.bot.speed;
        self.bot.body.velocity.z -= GRAVITY * dt;

        let physics = PhysicsWorld::new(&self.world);
        let result =
            self.bot_kcc
                .move_character(&physics, self.bot.body, self.bot.body.velocity * dt, dt);
        self.bot.body.position = result.position;
        self.bot.body.velocity = result.velocity;
        self.bot.body.grounded = result.grounded;
        self.bot.anim.update(
            Vec2::new(result.velocity.x, result.velocity.y).length(),
            true,
            dt,
        );
    }

    fn try_fire(&mut self) {
        if self.weapon.cooldown > 0.0 || self.round != RoundState::Live {
            return;
        }
        self.weapon.cooldown = self.config.weapon.fire_interval_ms as f32 / 1000.0;
        self.weapon.muzzle_flash = 0.06;
        let camera = self.camera();
        let from = camera.eye;
        let to = from + camera.forward() * self.config.weapon.range;
        let bot_hit = self
            .bot
            .alive
            .then(|| {
                ray_capsule_fraction(
                    from,
                    to,
                    self.bot.body.position,
                    self.bot.body.height,
                    self.bot.body.radius,
                )
            })
            .flatten();
        let world_hit = self.world.raycast(from, to);
        let world_fraction = world_hit.map(|hit| hit.fraction).unwrap_or(1.0);
        let hit_bot = bot_hit.is_some_and(|fraction| fraction < world_fraction);
        if hit_bot {
            self.bot.health -= self.config.weapon.damage.round() as i32;
            if self.bot.health <= 0 {
                self.bot.alive = false;
            }
        }
        let end = if let Some(fraction) = bot_hit.filter(|fraction| *fraction < world_fraction) {
            from.lerp(to, fraction)
        } else if let Some(hit) = world_hit {
            hit.position
        } else {
            to
        };
        self.last_bullet = Some(LastBullet {
            from,
            to: end,
            hit_bot,
        });
    }

    fn hud(&self) -> HudState {
        let round_text = match self.round {
            RoundState::PreRound => "GET READY",
            RoundState::Live => "LIVE",
            RoundState::PlayerWon => "BOT DOWN - ROUND WON",
            RoundState::PlayerLost => "PLAYER LOST",
            RoundState::Restarting => "RESTARTING",
            RoundState::Loading => "LOADING",
            RoundState::Intermission => "INTERMISSION",
        }
        .to_string();

        let mut debug_text = Vec::new();
        if self.debug_overlay {
            debug_text.push(format!(
                "pos {:.1} {:.1} {:.1}",
                self.player.body.position.x,
                self.player.body.position.y,
                self.player.body.position.z
            ));
            debug_text.push(format!(
                "bot hp {} alive {}",
                self.bot.health, self.bot.alive
            ));
            debug_text.push(format!("round {:?} {:.2}", self.round, self.round_timer));
        }

        HudState {
            health: self.player.health,
            ammo_text: "INF".to_string(),
            round_text,
            debug_text,
            crosshair: true,
        }
    }

    fn bot_mesh(&self) -> RenderMesh {
        let _skeleton = procedural_humanoid_skeleton();
        let _pose = self.bot.anim.sample_procedural_humanoid();
        let p = self.bot.body.position;
        let color_name = if self.bot.alive {
            "bot/alive"
        } else {
            "bot/dead"
        };
        humanoid_mesh("openstrike-bot", color_name, p, self.bot.alive)
    }

    fn viewmodel_mesh(&self) -> RenderMesh {
        let camera = self.camera();
        let forward = camera.forward();
        let right = camera.right();
        let up = Vec3::Z;
        let center = camera.eye + forward * 28.0 + right * 9.0 - up * 9.0;
        box_mesh(
            "os-rifle-viewmodel",
            "weapon/rifle",
            center,
            right * 10.0,
            forward * 20.0,
            up * 3.0,
        )
    }
}

fn render_meshes_from_bsp(world: &BspWorld) -> Vec<RenderMesh> {
    world
        .geometry
        .meshes
        .iter()
        .map(|mesh| RenderMesh {
            name: mesh.name.clone(),
            positions: mesh.positions.clone(),
            normals: mesh.normals.clone(),
            uvs: mesh.uvs.iter().map(|uv| [uv.x, uv.y]).collect(),
            indices: mesh.indices.clone(),
            material_name: mesh.texture.clone(),
        })
        .collect()
}

fn ray_capsule_fraction(from: Vec3, to: Vec3, base: Vec3, height: f32, radius: f32) -> Option<f32> {
    let top = base + Vec3::Z * height;
    let ray = to - from;
    let seg = top - base;
    let w0 = from - base;
    let a = ray.dot(ray);
    let b = ray.dot(seg);
    let c = seg.dot(seg);
    let d = ray.dot(w0);
    let e = seg.dot(w0);
    let denom = a * c - b * b;
    let mut s = if denom.abs() > 0.0001 {
        (b * e - c * d) / denom
    } else {
        0.0
    };
    let mut t = if denom.abs() > 0.0001 {
        (a * e - b * d) / denom
    } else {
        e / c
    };
    s = s.clamp(0.0, 1.0);
    t = t.clamp(0.0, 1.0);
    let closest_ray = from + ray * s;
    let closest_seg = base + seg * t;
    ((closest_ray - closest_seg).length() <= radius).then_some(s)
}

fn humanoid_mesh(name: &str, material: &str, origin: Vec3, alive: bool) -> RenderMesh {
    let lean = if alive {
        Quat::IDENTITY
    } else {
        Quat::from_rotation_x(1.35)
    };
    let torso_center = origin + lean * Vec3::new(0.0, 0.0, 38.0);
    let mut merged = box_mesh(
        name,
        material,
        torso_center,
        Vec3::X * 10.0,
        Vec3::Y * 6.0,
        Vec3::Z * 22.0,
    );
    append_mesh(
        &mut merged,
        box_mesh(
            "head",
            material,
            origin + lean * Vec3::new(0.0, 0.0, 68.0),
            Vec3::X * 8.0,
            Vec3::Y * 8.0,
            Vec3::Z * 8.0,
        ),
    );
    append_mesh(
        &mut merged,
        box_mesh(
            "left-arm",
            material,
            origin + lean * Vec3::new(-16.0, 0.0, 42.0),
            Vec3::X * 4.0,
            Vec3::Y * 5.0,
            Vec3::Z * 18.0,
        ),
    );
    append_mesh(
        &mut merged,
        box_mesh(
            "right-arm",
            material,
            origin + lean * Vec3::new(16.0, 0.0, 42.0),
            Vec3::X * 4.0,
            Vec3::Y * 5.0,
            Vec3::Z * 18.0,
        ),
    );
    append_mesh(
        &mut merged,
        box_mesh(
            "left-leg",
            material,
            origin + lean * Vec3::new(-6.0, 0.0, 14.0),
            Vec3::X * 5.0,
            Vec3::Y * 5.0,
            Vec3::Z * 16.0,
        ),
    );
    append_mesh(
        &mut merged,
        box_mesh(
            "right-leg",
            material,
            origin + lean * Vec3::new(6.0, 0.0, 14.0),
            Vec3::X * 5.0,
            Vec3::Y * 5.0,
            Vec3::Z * 16.0,
        ),
    );
    merged
}

fn append_mesh(dst: &mut RenderMesh, mut src: RenderMesh) {
    let offset = dst.positions.len() as u32;
    dst.positions.append(&mut src.positions);
    dst.normals.append(&mut src.normals);
    dst.uvs.append(&mut src.uvs);
    dst.indices
        .extend(src.indices.into_iter().map(|idx| idx + offset));
}

fn box_mesh(name: &str, material: &str, center: Vec3, x: Vec3, y: Vec3, z: Vec3) -> RenderMesh {
    let corners = [
        center - x - y - z,
        center + x - y - z,
        center + x + y - z,
        center - x + y - z,
        center - x - y + z,
        center + x - y + z,
        center + x + y + z,
        center - x + y + z,
    ];
    let indices: Vec<u32> = vec![
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6,
        3, 0, 4, 3, 4, 7,
    ];
    RenderMesh {
        name: name.to_string(),
        positions: corners.to_vec(),
        normals: vec![Vec3::Z; corners.len()],
        uvs: vec![[0.0, 0.0]; corners.len()],
        indices,
        material_name: Some(material.to_string()),
    }
}

pub fn run_headless(mut game: OpenStrikeGame, ticks: u32) -> OpenStrikeGame {
    for _ in 0..ticks {
        game.aim_at_bot();
        let input = InputSnapshot {
            fire: matches!(game.round, RoundState::Live),
            ..InputSnapshot::default()
        };
        game.fixed_update(&input, DEFAULT_FIXED_DT);
    }
    game
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capsule_intersection_hits_body() {
        let hit = ray_capsule_fraction(
            Vec3::new(-10.0, 0.0, 32.0),
            Vec3::new(10.0, 0.0, 32.0),
            Vec3::ZERO,
            72.0,
            4.0,
        );
        assert!(hit.is_some());
    }
}
