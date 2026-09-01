//! Collision interface + a Quake-style character controller.
//!
//! The runtime doesn't know what a world is made of; anything that can
//! answer hull traces (BSP today, custom geometry tomorrow) implements
//! [`TraceWorld`] and the controller works on top.
//!
//! Pure math over `alloc` — shared verbatim by the desktop runtime and the
//! PSP (this is the movement code air-strafing depends on; both targets run
//! the exact same source). `pocket3d::collide` re-exports this module.

use alloc::vec::Vec;

use glam::Vec3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HullKind {
    Point,
    Stand,
    Crouch,
    Large,
}

#[derive(Clone, Copy, Debug)]
pub struct Trace {
    pub fraction: f32,
    pub end: Vec3,
    pub normal: Vec3,
    pub start_solid: bool,
}

impl Trace {
    pub fn hit(&self) -> bool {
        self.fraction < 1.0 || self.start_solid
    }
}

pub trait TraceWorld {
    fn trace(&self, hull: HullKind, start: Vec3, end: Vec3) -> Trace;
}

impl TraceWorld for crate::trace::MapCollision {
    fn trace(&self, hull: HullKind, start: Vec3, end: Vec3) -> Trace {
        let h = match hull {
            HullKind::Point => crate::trace::Hull::Point,
            HullKind::Stand => crate::trace::Hull::Stand,
            HullKind::Crouch => crate::trace::Hull::Crouch,
            HullKind::Large => crate::trace::Hull::Large,
        };
        let t = crate::trace::MapCollision::trace(self, h, start, end);
        Trace {
            fraction: t.fraction,
            end: t.end,
            normal: t.normal,
            start_solid: t.start_solid,
        }
    }
}

// ---------------------------------------------------------------------------
// Character controller (GoldSrc-flavored: friction/accelerate/step/jump)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct MoveParams {
    pub gravity: f32,
    pub max_speed: f32,
    pub accelerate: f32,
    pub air_accelerate: f32,
    /// Air acceleration wish-speed cap (the famous 30 u/s).
    pub air_speed_cap: f32,
    pub friction: f32,
    pub stop_speed: f32,
    pub jump_speed: f32,
    pub step_height: f32,
    /// Eye offset above the hull center.
    pub eye_height: f32,
}

impl Default for MoveParams {
    fn default() -> Self {
        Self {
            gravity: 800.0,
            max_speed: 250.0,
            accelerate: 5.5,
            air_accelerate: 10.0,
            air_speed_cap: 30.0,
            friction: 4.0,
            stop_speed: 75.0,
            jump_speed: 268.3,
            step_height: 18.0,
            eye_height: 28.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CharacterState {
    /// Hull center position.
    pub pos: Vec3,
    pub vel: Vec3,
    pub on_ground: bool,
}

impl CharacterState {
    pub fn new(pos: Vec3) -> Self {
        Self {
            pos,
            vel: Vec3::ZERO,
            on_ground: false,
        }
    }

    pub fn eye(&self, params: &MoveParams) -> Vec3 {
        self.pos + Vec3::Y * params.eye_height
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MoveInput {
    /// Desired horizontal move direction (normalized or zero), world space.
    pub wish_dir: Vec3,
    /// 0..1 of max speed.
    pub speed: f32,
    pub jump: bool,
}

const GROUND_NORMAL_Y: f32 = 0.7;
const STOP_EPSILON: f32 = 0.1;

fn clip_velocity(v: Vec3, normal: Vec3) -> Vec3 {
    let backoff = v.dot(normal);
    let mut out = v - normal * backoff;
    // Suppress micro-jitter (Quake's STOP_EPSILON snap).
    for c in 0..3 {
        if out[c].abs() < STOP_EPSILON {
            out[c] = 0.0;
        }
    }
    out
}

/// Slide the hull along its velocity for `dt`, clipping against surfaces
/// (up to 4 bumps). Returns the covered time fraction spent not stuck.
fn slide_move(world: &impl TraceWorld, hull: HullKind, pos: &mut Vec3, vel: &mut Vec3, dt: f32) {
    let original = *vel;
    let mut planes: Vec<Vec3> = Vec::with_capacity(4);
    let mut time_left = dt;

    for _ in 0..4 {
        if vel.length_squared() < 1e-8 || time_left <= 0.0 {
            break;
        }
        let target = *pos + *vel * time_left;
        let tr = world.trace(hull, *pos, target);
        if tr.start_solid {
            // Stuck: kill velocity, let the caller's unstick logic handle it.
            *vel = Vec3::ZERO;
            return;
        }
        if tr.fraction > 0.0 {
            *pos = tr.end;
            planes.clear();
        }
        if tr.fraction >= 1.0 {
            return;
        }
        time_left -= time_left * tr.fraction;
        if planes.len() >= 4 {
            *vel = Vec3::ZERO;
            return;
        }
        planes.push(tr.normal);

        // Find a velocity that leaves every touched plane.
        let mut found = false;
        for i in 0..planes.len() {
            let candidate = clip_velocity(*vel, planes[i]);
            if planes
                .iter()
                .enumerate()
                .all(|(j, p)| j == i || candidate.dot(*p) >= 0.0)
            {
                *vel = candidate;
                found = true;
                break;
            }
        }
        if !found {
            if planes.len() == 2 {
                let dir = planes[0].cross(planes[1]).normalize_or_zero();
                *vel = dir * dir.dot(*vel);
            } else {
                *vel = Vec3::ZERO;
                return;
            }
        }
        if vel.dot(original) <= 0.0 {
            *vel = Vec3::ZERO;
            return;
        }
    }
}

/// Slide move with stair stepping: try both the direct slide and an
/// up-step/slide/down-step variant, keep whichever travels further.
fn step_slide_move(
    world: &impl TraceWorld,
    hull: HullKind,
    pos: &mut Vec3,
    vel: &mut Vec3,
    dt: f32,
    step_height: f32,
) {
    let start_pos = *pos;
    let start_vel = *vel;

    let mut down_pos = start_pos;
    let mut down_vel = start_vel;
    slide_move(world, hull, &mut down_pos, &mut down_vel, dt);

    // Stepped variant.
    let up = world.trace(hull, start_pos, start_pos + Vec3::Y * step_height);
    let mut step_pos = up.end;
    let mut step_vel = start_vel;
    slide_move(world, hull, &mut step_pos, &mut step_vel, dt);
    let down = world.trace(hull, step_pos, step_pos - Vec3::Y * (step_height + 2.0));
    let stepped_ok = !down.start_solid && (down.fraction >= 1.0 || down.normal.y > GROUND_NORMAL_Y);
    let step_final = down.end;

    let dist2 = |a: Vec3, b: Vec3| {
        let d = b - a;
        d.x * d.x + d.z * d.z
    };
    if stepped_ok && dist2(start_pos, step_final) > dist2(start_pos, down_pos) {
        *pos = step_final;
        *vel = Vec3::new(step_vel.x, down_vel.y, step_vel.z);
    } else {
        *pos = down_pos;
        *vel = down_vel;
    }
}

fn categorize_ground(
    world: &impl TraceWorld,
    hull: HullKind,
    state: &mut CharacterState,
    snap: bool,
) {
    if state.vel.y > 180.0 {
        state.on_ground = false;
        return;
    }
    let tr = world.trace(hull, state.pos, state.pos - Vec3::Y * 2.0);
    if tr.fraction < 1.0 && !tr.start_solid && tr.normal.y > GROUND_NORMAL_Y {
        state.on_ground = true;
        if snap {
            state.pos = tr.end;
        }
    } else {
        state.on_ground = false;
    }
}

/// Advance one fixed step of first-person movement.
pub fn step_character(
    world: &impl TraceWorld,
    hull: HullKind,
    state: &mut CharacterState,
    params: &MoveParams,
    input: &MoveInput,
    dt: f32,
) {
    categorize_ground(world, hull, state, false);

    // Jump consumes ground state before friction.
    if input.jump && state.on_ground {
        state.vel.y = params.jump_speed;
        state.on_ground = false;
    }

    // Friction (ground only).
    if state.on_ground {
        let speed = state.vel.xz_len();
        if speed > 0.0 {
            let control = speed.max(params.stop_speed);
            let drop = control * params.friction * dt;
            let scale = ((speed - drop).max(0.0)) / speed;
            state.vel.x *= scale;
            state.vel.z *= scale;
        }
        state.vel.y = 0.0;
    }

    // Acceleration.
    let wish_speed = params.max_speed * input.speed.clamp(0.0, 1.0);
    let wish_dir = Vec3::new(input.wish_dir.x, 0.0, input.wish_dir.z).normalize_or_zero();
    if wish_dir != Vec3::ZERO {
        let (accel, cap) = if state.on_ground {
            (params.accelerate, wish_speed)
        } else {
            (params.air_accelerate, wish_speed.min(params.air_speed_cap))
        };
        let current = state.vel.dot(wish_dir);
        let add = cap - current;
        if add > 0.0 {
            let accel_speed = (accel * wish_speed * dt).min(add);
            state.vel += wish_dir * accel_speed;
        }
    }

    // Gravity (half before, half after the move for accuracy).
    if !state.on_ground {
        state.vel.y -= params.gravity * 0.5 * dt;
    }

    if state.on_ground {
        step_slide_move(
            world,
            hull,
            &mut state.pos,
            &mut state.vel,
            dt,
            params.step_height,
        );
    } else {
        let mut pos = state.pos;
        let mut vel = state.vel;
        slide_move(world, hull, &mut pos, &mut vel, dt);
        state.pos = pos;
        state.vel = vel;
    }

    if !state.on_ground {
        state.vel.y -= params.gravity * 0.5 * dt;
    }

    categorize_ground(world, hull, state, true);
}

trait XzLen {
    fn xz_len(&self) -> f32;
}
impl XzLen for Vec3 {
    fn xz_len(&self) -> f32 {
        // Via glam so the sqrt resolves in both std and libm builds.
        Vec3::new(self.x, 0.0, self.z).length()
    }
}
