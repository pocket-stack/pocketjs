//! Bots: T-side dummies with a small patrol/chase/attack brain.

use pocket3d::bsp::MapCollision;
use pocket3d::prelude::*;

use crate::weapon::{EffectKind, Effects, Rng};

pub const BOT_HEALTH: i32 = 100;
pub const BOT_EYE: f32 = 20.0;
pub const BOT_SPEED: f32 = 190.0;
const SIGHT_RANGE: f32 = 2600.0;
const ATTACK_RANGE: f32 = 420.0;
const ATTACK_INTERVAL: f32 = 1.4;
const LOSE_SIGHT_AFTER: f32 = 1.6;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum BotState {
    Patrol,
    Chase,
    Attack,
    Dead,
}

pub struct Bot {
    pub state: CharacterState,
    pub prev_pos: Vec3,
    pub yaw: f32,
    pub health: i32,
    pub brain: BotState,
    pub anim: AnimState,
    wander_yaw: f32,
    think_timer: f32,
    attack_timer: f32,
    lost_timer: f32,
    pub death_time: f32,
}

pub struct BotShot {
    pub damage: i32,
}

impl Bot {
    pub fn spawn(pos: Vec3, yaw: f32) -> Self {
        Self {
            state: CharacterState::new(pos),
            prev_pos: pos,
            yaw,
            health: BOT_HEALTH,
            brain: BotState::Patrol,
            anim: AnimState::default(),
            wander_yaw: yaw,
            think_timer: 0.0,
            attack_timer: 1.0,
            lost_timer: 0.0,
            death_time: 0.0,
        }
    }

    pub fn alive(&self) -> bool {
        self.brain != BotState::Dead
    }

    pub fn eye(&self) -> Vec3 {
        self.state.pos + Vec3::Y * BOT_EYE
    }

    pub fn hurt(&mut self, dmg: i32) -> bool {
        if !self.alive() {
            return false;
        }
        self.health -= dmg;
        if self.health <= 0 {
            self.brain = BotState::Dead;
            self.death_time = 0.0;
            return true;
        }
        false
    }

    fn yaw_towards(&mut self, target: Vec3, dt: f32, rate: f32) {
        let d = target - self.state.pos;
        let want = (-d.x).atan2(-d.z);
        let mut diff = want - self.yaw;
        while diff > std::f32::consts::PI {
            diff -= std::f32::consts::TAU;
        }
        while diff < -std::f32::consts::PI {
            diff += std::f32::consts::TAU;
        }
        let max = rate * dt;
        self.yaw += diff.clamp(-max, max);
    }

    /// Advance one tick. Returns a shot descriptor when the bot lands a hit
    /// on the player this tick.
    #[allow(clippy::too_many_arguments)]
    pub fn tick(
        &mut self,
        col: &MapCollision,
        player_eye: Vec3,
        player_alive: bool,
        dt: f32,
        rng: &mut Rng,
        effects: &mut Effects,
    ) -> Option<BotShot> {
        self.prev_pos = self.state.pos;
        if self.brain == BotState::Dead {
            self.death_time += dt;
            self.anim.speed = 0.0;
            return None;
        }

        // Perception: distance + line of sight to the player's eye.
        let to_player = player_eye - self.eye();
        let dist = to_player.length();
        let visible = player_alive && dist < SIGHT_RANGE && {
            let tr = col.trace(pocket3d::bsp::Hull::Point, self.eye(), player_eye);
            tr.fraction >= 1.0
        };

        if visible {
            self.lost_timer = 0.0;
        } else {
            self.lost_timer += dt;
        }

        // Brain transitions.
        self.brain = match self.brain {
            BotState::Patrol if visible => BotState::Chase,
            BotState::Chase if visible && dist < ATTACK_RANGE => BotState::Attack,
            BotState::Chase if self.lost_timer > LOSE_SIGHT_AFTER => BotState::Patrol,
            BotState::Attack if !visible || dist > ATTACK_RANGE * 1.25 => {
                if self.lost_timer > LOSE_SIGHT_AFTER {
                    BotState::Patrol
                } else {
                    BotState::Chase
                }
            }
            s => s,
        };

        let mut shot = None;
        let mut wish = Vec3::ZERO;
        let mut speed = 0.0;

        match self.brain {
            BotState::Patrol => {
                self.think_timer -= dt;
                let fwd = Vec3::new(-self.wander_yaw.sin(), 0.0, -self.wander_yaw.cos());
                // Re-pick direction when the timer expires or a wall is close.
                let probe = col.trace(
                    pocket3d::bsp::Hull::Stand,
                    self.state.pos,
                    self.state.pos + fwd * 56.0,
                );
                if self.think_timer <= 0.0 || probe.fraction < 1.0 {
                    self.wander_yaw = rng.range(0.0, std::f32::consts::TAU);
                    self.think_timer = rng.range(1.5, 4.0);
                }
                let fwd = Vec3::new(-self.wander_yaw.sin(), 0.0, -self.wander_yaw.cos());
                wish = fwd;
                speed = 0.55;
                self.yaw_towards(self.state.pos + fwd * 100.0, dt, 4.0);
            }
            BotState::Chase => {
                let dir = Vec3::new(to_player.x, 0.0, to_player.z).normalize_or_zero();
                wish = dir;
                speed = 1.0;
                self.yaw_towards(player_eye, dt, 7.0);
            }
            BotState::Attack => {
                self.yaw_towards(player_eye, dt, 9.0);
                self.attack_timer -= dt;
                if self.attack_timer <= 0.0 && visible {
                    self.attack_timer = ATTACK_INTERVAL * rng.range(0.85, 1.25);
                    // Muzzle flash + tracer from the bot towards the player.
                    let from = self.eye() + Vec3::Y * 4.0;
                    let miss = rng.f32() > (1.25 - dist / 900.0).clamp(0.25, 0.85);
                    let aim = if miss {
                        player_eye
                            + Vec3::new(rng.signed(), rng.signed() * 0.4, rng.signed()) * 45.0
                    } else {
                        player_eye
                    };
                    effects.spawn(EffectKind::MuzzleFlash { pos: from }, 0.08);
                    effects.spawn(EffectKind::Tracer { a: from, b: aim }, 0.09);
                    if !miss {
                        shot = Some(BotShot {
                            damage: 8 + (rng.f32() * 7.0) as i32,
                        });
                    }
                }
            }
            BotState::Dead => {}
        }

        let input = MoveInput {
            wish_dir: wish,
            speed,
            jump: false,
        };
        step_character(
            col,
            HullKind::Stand,
            &mut self.state,
            &MoveParams {
                max_speed: BOT_SPEED,
                ..Default::default()
            },
            &input,
            dt,
        );

        // Animation: walk speed scales the clip; idle freezes it.
        let ground_speed =
            (self.state.vel.x * self.state.vel.x + self.state.vel.z * self.state.vel.z).sqrt();
        if ground_speed > 12.0 {
            self.anim.speed = (ground_speed / 90.0).clamp(0.6, 2.2);
        } else {
            self.anim.speed = 0.0;
        }
        self.anim.advance(dt);
        shot
    }

    /// World transform, including the death fall.
    pub fn transform(&self, asset: &pocket3d::model::ModelAsset) -> Mat4 {
        let scale = 70.0 / asset.height();
        let feet = self.state.pos - Vec3::Y * 36.0;
        let fall = (self.death_time * 3.0).min(1.0);
        // Ease-out fall backwards, slight sink so the corpse hugs the ground.
        let ease = 1.0 - (1.0 - fall) * (1.0 - fall);
        Mat4::from_translation(feet + Vec3::Y * (2.0 - 2.0 * ease))
            * Mat4::from_rotation_y(self.yaw)
            * Mat4::from_rotation_x(-ease * std::f32::consts::FRAC_PI_2 * 0.94)
            * Mat4::from_scale(Vec3::splat(scale))
    }

    pub fn tint(&self) -> [f32; 4] {
        if self.alive() {
            [1.0, 0.86, 0.78, 1.0]
        } else {
            [0.55, 0.42, 0.4, 1.0]
        }
    }
}
