use std::collections::{BTreeMap, BTreeSet};
use std::f32::consts::{FRAC_PI_2, TAU};
use std::sync::Arc;

use anyhow::{Context, Result, ensure};
use glam::{Mat4, Quat, Vec2, Vec3};
use pocket3d::anim::AnimState;
use pocket3d::app::Game;
use pocket3d::camera::Camera;
use pocket3d::gpu::Gpu;
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::model::{ModelAsset, ModelInstance};
use pocket3d::renderer::Renderer;
use pocket3d::scene::{
    Beam, DistanceFog, ModelLighting, RimLighting, Scene, Sky, Sprite, ToonLighting,
};
use pocket3d_world::{
    Attachment, Body, BodyMode, Collider, EntityBundle, EntityId, Environment, EnvironmentSample,
    Interaction, PhysicalSurface, ReactiveMaterial, ReactiveState, StepReport, Structure,
    Transform, World, WorldEvent,
};
use serde::Serialize;
use winit::keyboard::KeyCode;

use crate::art;

const PLAYER_HEIGHT: f32 = 0.84;
const MOVE_SPEED: f32 = 3.55;
const CHOP_REACH: f32 = 2.55;
const ACTION_REACH: f32 = 4.6;
const AXE_SWING_TURNS: u16 = 18;
const WATER_BURST_TURNS: u16 = 24;
const WATER_JET_LENGTH: f32 = 2.8;
const WATER_NEAR_RADIUS: f32 = 0.12;
const WATER_FAR_RADIUS: f32 = 0.42;
const WATER_FORWARD_SPEED: f32 = 5.0;
const WATER_LIFT_SPEED: f32 = 1.1;
const WATER_GRAVITY: f32 = 9.81;
const WATER_BREAKUP_LENGTH: f32 = 3.2;
const WATER_DOUSE_BUDGET_PER_TURN: f32 = 0.22;
const WATER_SAMPLE_COUNT: usize = 12;
const WATER_POINT_COUNT: usize = WATER_SAMPLE_COUNT + 1;
const WATER_NOZZLE_HEIGHT: f32 = 0.92;
const CAMPFIRE_DOUSE_STABILITY_TURNS: u64 = 180;
const HELD_APPLE_SOCKET_OFFSET: Vec3 = Vec3::new(0.0, 0.12, 0.0);
const HELD_APPLE_ATTACHMENT_OFFSET: Vec3 = Vec3::new(0.37, 0.05, -0.22);
const CAMERA_FOCUS_HEIGHT: f32 = 1.15;
const CAMERA_ORBIT_LIFT: f32 = 1.2;
const CAMERA_ORBIT_DISTANCE: f32 = 6.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExplorerAction {
    Idle,
    Walk,
    Chop,
}

#[derive(Clone, Copy, Debug)]
struct ExplorerAnimations {
    idle: usize,
    walk: usize,
    chop: usize,
    walk_duration: f32,
    chop_duration: f32,
}

#[derive(Clone, Copy, Debug)]
struct ExplorerPose {
    transform: Mat4,
    anim: AnimState,
}

fn explorer_action(moving: bool, chop_turns: u16) -> ExplorerAction {
    if chop_turns > 0 {
        ExplorerAction::Chop
    } else if moving {
        ExplorerAction::Walk
    } else {
        ExplorerAction::Idle
    }
}

fn explorer_animation(
    action: ExplorerAction,
    animations: ExplorerAnimations,
    scene_time: f32,
    walk_phase: f32,
    chop_turns: u16,
) -> AnimState {
    match action {
        ExplorerAction::Idle => AnimState {
            clip: animations.idle,
            time: scene_time,
            speed: 1.0,
            looping: true,
        },
        ExplorerAction::Walk => AnimState {
            clip: animations.walk,
            time: walk_phase.rem_euclid(TAU) / TAU * animations.walk_duration,
            speed: 1.0,
            looping: true,
        },
        ExplorerAction::Chop => {
            let progress =
                1.0 - chop_turns.min(AXE_SWING_TURNS) as f32 / AXE_SWING_TURNS.max(1) as f32;
            AnimState {
                clip: animations.chop,
                time: progress * animations.chop_duration,
                speed: 1.0,
                looping: false,
            }
        }
    }
}

fn explorer_pose(
    player: Transform,
    moving: bool,
    model_min_y: f32,
    animations: ExplorerAnimations,
    scene_time: f32,
    walk_phase: f32,
    chop_turns: u16,
) -> ExplorerPose {
    let action = explorer_action(moving, chop_turns);
    ExplorerPose {
        transform: grounded_explorer_transform(player, model_min_y),
        anim: explorer_animation(action, animations, scene_time, walk_phase, chop_turns),
    }
}

fn held_apple_socket_transform(explorer_transform: Mat4, hand_transform: Mat4) -> Mat4 {
    let palm = explorer_transform
        .transform_point3(hand_transform.transform_point3(HELD_APPLE_SOCKET_OFFSET));
    Mat4::from_translation(palm)
}

fn player_capsule_center(xz: Vec2, ground_height: f32) -> Vec3 {
    Vec3::new(xz.x, ground_height + PLAYER_HEIGHT, xz.y)
}

fn grounded_explorer_transform(player: Transform, model_min_y: f32) -> Mat4 {
    let ground_height = player.position.y - PLAYER_HEIGHT;
    let translation = Vec3::new(
        player.position.x,
        ground_height - model_min_y * player.scale.y,
        player.position.z,
    );
    Mat4::from_scale_rotation_translation(player.scale, player.rotation, translation)
}

fn player_camera_pose(foot: Vec3, orbit_yaw: f32, orbit_pitch: f32) -> (Vec3, Vec3) {
    let focus = foot + Vec3::Y * CAMERA_FOCUS_HEIGHT;
    let rotation =
        Quat::from_rotation_y(orbit_yaw) * Quat::from_rotation_x(orbit_pitch.clamp(-0.72, 0.34));
    let offset = rotation * Vec3::new(0.0, CAMERA_ORBIT_LIFT, CAMERA_ORBIT_DISTANCE);
    (focus + offset, focus)
}

fn camera_relative_movement(axis: Vec2, yaw: f32) -> Vec3 {
    if axis.length_squared() == 0.0 {
        return Vec3::ZERO;
    }
    let axis = axis.normalize();
    let forward = Vec3::new(-yaw.sin(), 0.0, -yaw.cos());
    // `Camera::right` for the same yaw. At yaw 0 the camera faces -Z,
    // therefore screen-right is +X.
    let right = Vec3::new(-forward.z, 0.0, forward.x);
    (right * axis.x + forward * axis.y).normalize_or_zero()
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WaterJet {
    origin: Vec3,
    direction: Vec3,
    length: f32,
    near_radius: f32,
    far_radius: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WaterJetSample {
    center: Vec3,
    distance: f32,
    radius: f32,
    retention: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WaterContact {
    distance: f32,
    coverage: f32,
    retention: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WaterDose {
    target: EntityId,
    amount: f32,
    distance: f32,
    coverage: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WaterHudState {
    spraying: bool,
    progress: f32,
}

/// Place the outlet at the explorer's waist and aim it along the actor's local
/// forward axis. This intentionally depends on the actor transform, not the
/// orbit camera, so turning and spraying cannot disagree.
fn water_nozzle_and_direction(player: Transform) -> (Vec3, Vec3) {
    let direction = (player.rotation * Vec3::NEG_Z)
        .with_y(0.0)
        .normalize_or(Vec3::NEG_Z);
    let foot_y = player.position.y - PLAYER_HEIGHT * player.scale.y;
    let origin = Vec3::new(
        player.position.x,
        foot_y + WATER_NOZZLE_HEIGHT * player.scale.y,
        player.position.z,
    ) + direction * 0.10;
    (origin, direction)
}

fn water_jet(player: Transform) -> WaterJet {
    let (origin, direction) = water_nozzle_and_direction(player);
    WaterJet {
        origin,
        direction,
        length: WATER_JET_LENGTH,
        near_radius: WATER_NEAR_RADIUS,
        far_radius: WATER_FAR_RADIUS,
    }
}

/// Deterministic centerline and cross-section samples shared by rendering and
/// hit testing. Distance, rather than sample index, drives the ballistic arc
/// and breakup loss so changing visual density cannot change gameplay.
fn water_jet_samples(jet: WaterJet) -> [WaterJetSample; WATER_POINT_COUNT] {
    std::array::from_fn(|index| {
        let fraction = index as f32 / WATER_SAMPLE_COUNT as f32;
        let distance = jet.length * fraction;
        let flight_time = distance / WATER_FORWARD_SPEED;
        let lift = WATER_LIFT_SPEED * flight_time - 0.5 * WATER_GRAVITY * flight_time * flight_time;
        WaterJetSample {
            center: jet.origin + jet.direction * distance + Vec3::Y * lift,
            distance,
            radius: jet.near_radius + (jet.far_radius - jet.near_radius) * fraction,
            retention: (-distance / WATER_BREAKUP_LENGTH).exp(),
        }
    })
}

/// Return the strongest overlap between the sampled curved jet and a target's
/// oriented capsule. Spheres are represented by a zero-length segment.
fn water_jet_contact(
    jet: WaterJet,
    transform: Transform,
    collider: Option<Collider>,
) -> Option<WaterContact> {
    let collider = collider.unwrap_or(Collider::Sphere { radius: 0.20 });
    let axis = transform.rotation * Vec3::Y;
    let half_height = collider.half_height() * transform.scale.y.abs();
    let target_radius = collider.radius() * transform.scale.abs().max_element().max(f32::EPSILON);
    let target_a = transform.position - axis * half_height;
    let target_b = transform.position + axis * half_height;

    // The tube has a rounded outlet, but it cannot reach an object whose whole
    // capsule lies behind the actor-facing nozzle plane.
    let target_forward = (target_a - jet.origin)
        .dot(jet.direction)
        .max((target_b - jet.origin).dot(jet.direction));
    if target_forward <= 0.0 {
        return None;
    }

    let samples = water_jet_samples(jet);
    samples
        .windows(2)
        .filter_map(|segment| {
            let (fraction, distance_squared) = segment_distance_from_first(
                segment[0].center,
                segment[1].center,
                target_a,
                target_b,
            );
            let spray_radius =
                segment[0].radius + (segment[1].radius - segment[0].radius) * fraction;
            let reach = spray_radius + target_radius;
            if distance_squared > reach * reach {
                return None;
            }
            let radial_fraction = distance_squared.sqrt() / reach.max(f32::EPSILON);
            let coverage = (1.0 - radial_fraction * radial_fraction).clamp(0.0, 1.0);
            let distance =
                segment[0].distance + (segment[1].distance - segment[0].distance) * fraction;
            let retention =
                segment[0].retention + (segment[1].retention - segment[0].retention) * fraction;
            Some(WaterContact {
                distance,
                coverage,
                retention,
            })
        })
        .max_by(|a, b| (a.coverage * a.retention).total_cmp(&(b.coverage * b.retention)))
}

fn allocate_water_doses(
    contacts: impl IntoIterator<Item = (EntityId, WaterContact)>,
    budget: f32,
) -> Vec<WaterDose> {
    let contacts: Vec<_> = contacts
        .into_iter()
        .filter_map(|(target, contact)| {
            let weight = contact.coverage * contact.retention;
            (weight.is_finite() && weight > 0.0).then_some((target, contact, weight))
        })
        .collect();
    let total_weight: f32 = contacts.iter().map(|(_, _, weight)| weight).sum();
    let scale = budget.max(0.0) / total_weight.max(1.0);
    contacts
        .into_iter()
        .map(|(target, contact, weight)| WaterDose {
            target,
            amount: weight * scale,
            distance: contact.distance,
            coverage: contact.coverage,
        })
        .collect()
}

fn water_curtain_point(
    sample: WaterJetSample,
    right: Vec3,
    up: Vec3,
    side: f32,
    sample_index: usize,
    burst_age: u16,
) -> Vec3 {
    let phase = burst_age as f32 * 0.53 + sample_index as f32 * 1.37;
    let lateral = sample.radius * (0.66 + phase.sin() * 0.12);
    let vertical = sample.radius * phase.cos() * 0.10;
    sample.center + right * side.signum() * lateral + up * vertical
}

/// Return the normalized position on the first segment and the squared
/// distance between the two closest points.
fn segment_distance_from_first(a0: Vec3, a1: Vec3, b0: Vec3, b1: Vec3) -> (f32, f32) {
    const EPSILON: f32 = 1e-8;
    let d1 = a1 - a0;
    let d2 = b1 - b0;
    let r = a0 - b0;
    let a = d1.length_squared();
    let e = d2.length_squared();
    let f = d2.dot(r);

    let (mut s, t) = if a <= EPSILON && e <= EPSILON {
        (0.0, 0.0)
    } else if a <= EPSILON {
        (0.0, (f / e).clamp(0.0, 1.0))
    } else {
        let c = d1.dot(r);
        if e <= EPSILON {
            ((-c / a).clamp(0.0, 1.0), 0.0)
        } else {
            let b = d1.dot(d2);
            let denominator = a * e - b * b;
            let mut s = if denominator.abs() > EPSILON {
                ((b * f - c * e) / denominator).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let mut t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
            (s, t)
        }
    };
    s = s.clamp(0.0, 1.0);
    let point_a = a0 + d1 * s;
    let point_b = b0 + d2 * t;
    (s, point_a.distance_squared(point_b))
}

fn water_hud_state(remaining_turns: u16) -> WaterHudState {
    WaterHudState {
        spraying: remaining_turns > 0,
        progress: if remaining_turns > 0 {
            remaining_turns.min(WATER_BURST_TURNS) as f32 / WATER_BURST_TURNS as f32
        } else {
            1.0
        },
    }
}

#[derive(Clone, Copy, Debug)]
pub struct OrchardEnvironment {
    pub temperature_c: f32,
    pub humidity: f32,
    pub wind: Vec3,
}

impl Default for OrchardEnvironment {
    fn default() -> Self {
        Self {
            temperature_c: 24.0,
            humidity: 0.025,
            wind: Vec3::new(-0.7, 0.0, 0.28),
        }
    }
}

impl OrchardEnvironment {
    pub fn height_at(position: Vec2) -> f32 {
        let broad = (position.x * 0.105).sin() * 0.28 + (position.y * 0.082 + 0.7).cos() * 0.22;
        let detail = (position.x * 0.31 + position.y * 0.23).sin() * 0.065;
        broad + detail - 0.12
    }

    pub fn normal_at(position: Vec2) -> Vec3 {
        let epsilon = 0.08;
        let left = Self::height_at(position - Vec2::X * epsilon);
        let right = Self::height_at(position + Vec2::X * epsilon);
        let back = Self::height_at(position - Vec2::Y * epsilon);
        let front = Self::height_at(position + Vec2::Y * epsilon);
        Vec3::new(left - right, epsilon * 2.0, back - front).normalize_or(Vec3::Y)
    }
}

impl Environment for OrchardEnvironment {
    fn sample(&self, position: Vec3) -> EnvironmentSample {
        let xz = Vec2::new(position.x, position.z);
        EnvironmentSample {
            ambient_temperature_c: self.temperature_c,
            ambient_moisture: self.humidity,
            wind: self.wind,
            ground_height: Self::height_at(xz),
            ground_normal: Self::normal_at(xz),
        }
    }
}

#[derive(Clone)]
struct TreeVisual {
    trunk: EntityId,
    apples: Vec<EntityId>,
    root: Vec3,
    seed: u64,
    size: f32,
}

#[derive(Clone)]
struct WorldIds {
    player: EntityId,
    fire: EntityId,
    trees: Vec<TreeVisual>,
    camp_logs: Vec<EntityId>,
    damp_log: EntityId,
}

#[derive(Clone)]
struct WorldAssets {
    ground: Arc<ModelAsset>,
    trunk: Arc<ModelAsset>,
    branch: Arc<ModelAsset>,
    stump: Arc<ModelAsset>,
    canopy: Arc<ModelAsset>,
    apple: Arc<ModelAsset>,
    leaf: Arc<ModelAsset>,
    grass: Arc<ModelAsset>,
    rock: Arc<ModelAsset>,
    shadow: Arc<ModelAsset>,
    explorer: Arc<ModelAsset>,
    explorer_animations: ExplorerAnimations,
    explorer_left_hand: usize,
    flame: Arc<ModelAsset>,
}

impl WorldAssets {
    fn load(gpu: &Gpu, renderer: &Renderer) -> Result<Self> {
        let layout = &renderer.model_material_layout;
        let samplers = &renderer.samplers;
        let white = [255_u8, 255, 255, 255];
        let upload = |mesh: art::Mesh, label: &str| {
            mesh.upload(gpu, layout, samplers, label, Some((1, 1, &white)))
        };
        let ground_mesh = art::terrain_patch(Vec2::splat(44.0), [48, 48], |xz| {
            OrchardEnvironment::height_at(xz)
        });
        let ground_pixels = art::palette_texture(
            64,
            64,
            0x77a1_4c09,
            &[
                [112, 151, 77, 255],
                [129, 164, 83, 255],
                [145, 174, 91, 255],
                [102, 143, 72, 255],
                [158, 178, 102, 255],
            ],
        );
        let ground = ground_mesh.upload(
            gpu,
            layout,
            samplers,
            "playable-world ground",
            Some((64, 64, &ground_pixels)),
        );
        let centered_cylinder = |segments| {
            art::cylinder(1.0, 1.0, segments).transformed(Mat4::from_translation(Vec3::NEG_Y * 0.5))
        };
        let explorer = ModelAsset::load_glb_bytes(
            gpu,
            layout,
            samplers,
            include_bytes!("../assets/character/explorer.glb"),
            "playable-world explorer.glb",
        )?;
        ensure!(
            explorer.clips.len() == 3
                && ["Idle", "Walk", "Chop"]
                    .iter()
                    .all(|name| explorer.clip_named(name).is_some()),
            "explorer.glb must contain exactly the Idle, Walk, and Chop clips"
        );
        ensure!(
            explorer.aabb.0.y.abs() <= 0.01,
            "explorer.glb rest-pose AABB must meet the authored foot plane at Y=0; got min Y {}",
            explorer.aabb.0.y
        );
        let clip = |name: &str| {
            let index = explorer
                .clip_named(name)
                .with_context(|| format!("explorer.glb is missing the {name} clip"))?;
            Ok::<_, anyhow::Error>((index, explorer.clips[index].duration.max(0.001)))
        };
        let (idle, _) = clip("Idle")?;
        let (walk, walk_duration) = clip("Walk")?;
        let (chop, chop_duration) = clip("Chop")?;
        let explorer_animations = ExplorerAnimations {
            idle,
            walk,
            chop,
            walk_duration,
            chop_duration,
        };
        let explorer_left_hand = explorer
            .node_named("hand.L")
            .context("explorer.glb is missing the hand.L pickup socket")?;
        Ok(Self {
            ground,
            trunk: upload(centered_cylinder(12), "world trunk"),
            branch: upload(centered_cylinder(9), "world branch"),
            stump: upload(centered_cylinder(12), "world stump"),
            canopy: upload(art::tree_canopy(1.0, 0x55a9), "world canopy"),
            apple: upload(
                art::irregular_icosphere(1.0, 1, 0xa991, 0.055),
                "world apple",
            ),
            leaf: upload(art::cone(1.0, 1.0, 7), "world leaf"),
            grass: upload(art::grass_tuft_seeded(1.0, 1.0, 7, 0x1177), "world grass"),
            rock: upload(art::rock(1.0, 0x8118), "world rock"),
            shadow: upload(art::disc(1.0, 28), "world contact shadow"),
            explorer,
            explorer_animations,
            explorer_left_hand,
            flame: upload(art::cone(1.0, 1.0, 9), "stylized flame"),
        })
    }
}

#[derive(Clone)]
enum DecorationKind {
    Grass,
    Rock,
}

#[derive(Clone)]
struct Decoration {
    kind: DecorationKind,
    transform: Mat4,
    tint: [f32; 4],
}

#[derive(Default)]
struct PendingActions {
    chop: bool,
    ignite: bool,
    pickup: bool,
    douse: bool,
    reset: bool,
}

#[derive(Default)]
struct RuntimeReceipts {
    fractured: BTreeSet<EntityId>,
    detached: BTreeSet<EntityId>,
    terrain_contacts: BTreeSet<EntityId>,
    ignited: BTreeSet<EntityId>,
    extinguished: BTreeSet<EntityId>,
    cooked: BTreeSet<EntityId>,
    charred: BTreeSet<EntityId>,
    peak_temperature: BTreeMap<EntityId, f32>,
    last_ignited_tick: BTreeMap<EntityId, u64>,
    water_emitted: f32,
    water_delivered: BTreeMap<EntityId, f32>,
    last_water_tick: Option<u64>,
    contact_count: u64,
    landmarks: Vec<TimedEvent>,
}

impl RuntimeReceipts {
    fn observe(&mut self, report: &StepReport, world: &World) {
        for event in &report.events {
            match event {
                WorldEvent::Contact(contact) => {
                    self.contact_count += 1;
                    if contact.b.is_none() {
                        self.terrain_contacts.insert(contact.a);
                    }
                }
                WorldEvent::Fractured { entity, .. } => {
                    self.fractured.insert(*entity);
                    self.push_landmark(report.tick, event.clone());
                }
                WorldEvent::Detached { entity, .. } => {
                    self.detached.insert(*entity);
                    self.push_landmark(report.tick, event.clone());
                }
                WorldEvent::Ignited { entity } => {
                    self.ignited.insert(*entity);
                    self.last_ignited_tick.insert(*entity, report.tick);
                    self.push_landmark(report.tick, event.clone());
                }
                WorldEvent::Extinguished { entity } => {
                    self.extinguished.insert(*entity);
                    self.push_landmark(report.tick, event.clone());
                }
                WorldEvent::Cooked { entity } => {
                    self.cooked.insert(*entity);
                    self.push_landmark(report.tick, event.clone());
                }
                WorldEvent::Charred { entity } => {
                    self.charred.insert(*entity);
                    self.push_landmark(report.tick, event.clone());
                }
                WorldEvent::BurnedOut { .. } => self.push_landmark(report.tick, event.clone()),
            }
        }
        for (&id, entity) in world.entities() {
            if let Some(state) = entity.reactive_state {
                self.peak_temperature
                    .entry(id)
                    .and_modify(|peak| *peak = peak.max(state.temperature_c))
                    .or_insert(state.temperature_c);
            }
        }
    }

    fn push_landmark(&mut self, tick: u64, event: WorldEvent) {
        if self.landmarks.len() < 128 {
            self.landmarks.push(TimedEvent { tick, event });
        }
    }

    fn observe_water(&mut self, tick: u64, budget: f32, doses: &[WaterDose]) {
        self.water_emitted += budget.max(0.0);
        self.last_water_tick = Some(tick);
        for dose in doses {
            *self.water_delivered.entry(dose.target).or_default() += dose.amount;
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TimedEvent {
    pub tick: u64,
    pub event: WorldEvent,
}

#[derive(Clone, Debug, Serialize)]
pub struct EntityReceipt {
    pub id: u64,
    pub name: Option<String>,
    pub tags: Vec<String>,
    pub position: [f32; 3],
    pub rotation: [f32; 4],
    pub body_mode: Option<BodyMode>,
    pub linear_velocity: Option<[f32; 3]>,
    pub attached_to: Option<u64>,
    pub structure_fraction: Option<f32>,
    pub temperature_c: Option<f32>,
    pub moisture: Option<f32>,
    pub fuel: Option<f32>,
    pub burning: Option<bool>,
    pub cooked: Option<bool>,
    pub charred: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AcceptanceReceipt {
    pub tree_fractured: bool,
    pub fruit_detached: bool,
    pub detached_fruit_hit_terrain: bool,
    pub fire_changed_reactive_state: bool,
    pub spatial_fire_propagated: bool,
    pub damp_fuel_resisted_ignition: bool,
    pub playable_chain_complete: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WaterDoseReceipt {
    pub entity: u64,
    pub amount: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct CampfireDouseReceipt {
    pub entities: Vec<u64>,
    pub all_extinguished: bool,
    pub all_not_burning: bool,
    pub reignited_after_spray: Vec<u64>,
    pub post_spray_turns: u64,
    pub required_stability_turns: u64,
    pub passed: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct WaterReceipt {
    pub emitted: f32,
    pub delivered: f32,
    pub delivered_by_entity: Vec<WaterDoseReceipt>,
    pub last_spray_tick: Option<u64>,
    pub campfire_douse: CampfireDouseReceipt,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorldReceipt {
    pub schema: &'static str,
    pub scenario: String,
    pub seed: u64,
    pub ticks: u64,
    pub state_hash: String,
    pub contact_count: u64,
    pub fractured_entities: Vec<u64>,
    pub detached_entities: Vec<u64>,
    pub ignited_entities: Vec<u64>,
    pub extinguished_entities: Vec<u64>,
    pub cooked_entities: Vec<u64>,
    pub charred_entities: Vec<u64>,
    pub water: WaterReceipt,
    pub acceptance: AcceptanceReceipt,
    pub landmarks: Vec<TimedEvent>,
    pub entities: Vec<EntityReceipt>,
}

pub struct WorldGame {
    pub world: World,
    environment: OrchardEnvironment,
    ids: WorldIds,
    assets: Option<WorldAssets>,
    decorations: Vec<Decoration>,
    scene: Scene,
    camera: Camera,
    hud: Hud,
    orbit_yaw: f32,
    orbit_pitch: f32,
    pending: PendingActions,
    held_apple: Option<EntityId>,
    axe_swing_turns: u16,
    water_burst_turns: u16,
    walk_phase: f32,
    presentation_time: f32,
    message: String,
    message_turns: u16,
    receipts: RuntimeReceipts,
    last_target: Option<EntityId>,
    seed: u64,
}

impl WorldGame {
    pub fn new(seed: u64) -> Self {
        let environment = OrchardEnvironment::default();
        let (world, ids) = build_world(seed, &environment);
        let scene = Scene {
            sky: Sky {
                zenith: Vec3::new(0.22, 0.53, 0.68),
                horizon: Vec3::new(0.88, 0.78, 0.57),
                sun_dir: Vec3::new(-0.38, 0.72, 0.32).normalize(),
                sun_color: Vec3::new(1.0, 0.83, 0.55),
            },
            draw_sky: true,
            lighting: ModelLighting {
                sun_dir: Vec3::new(-0.38, 0.72, 0.32).normalize(),
                sun_color: Vec3::new(1.0, 0.78, 0.48),
                ambient: Vec3::new(0.31, 0.37, 0.29),
                toon: Some(ToonLighting::new(3, 0.24)),
                rim: Some(RimLighting::new(Vec3::new(0.72, 0.91, 0.94), 0.20, 3.2)),
                fog: Some(DistanceFog::new(Vec3::new(0.78, 0.76, 0.61), 25.0, 52.0)),
            },
            ..Default::default()
        };
        let mut camera = Camera {
            fov_y: 52.0_f32.to_radians(),
            znear: 0.08,
            zfar: 90.0,
            ..Default::default()
        };
        camera.pos = Vec3::new(8.0, 5.5, 12.0);
        camera.look_at(Vec3::new(0.0, 2.0, 4.0));
        Self {
            world,
            environment,
            ids,
            assets: None,
            decorations: build_decorations(seed),
            scene,
            camera,
            hud: Hud::default(),
            orbit_yaw: 0.0,
            orbit_pitch: -0.16,
            pending: PendingActions::default(),
            held_apple: None,
            axe_swing_turns: 0,
            water_burst_turns: 0,
            walk_phase: 0.0,
            presentation_time: 0.0,
            message: "Approach the old apple tree".into(),
            message_turns: 240,
            receipts: RuntimeReceipts::default(),
            last_target: None,
            seed,
        }
    }

    pub fn runtime_receipt(&self, scenario: impl Into<String>) -> WorldReceipt {
        let acceptance = self.acceptance();
        let water = self.water_receipt();
        let entities = self
            .world
            .entities()
            .map(|(_, entity)| EntityReceipt {
                id: entity.id.0,
                name: entity.name.clone(),
                tags: entity.tags.iter().cloned().collect(),
                position: entity.transform.position.to_array(),
                rotation: entity.transform.rotation.to_array(),
                body_mode: entity.body.map(|body| body.mode),
                linear_velocity: entity.body.map(|body| body.linear_velocity.to_array()),
                attached_to: entity.attachment.map(|attachment| attachment.parent.0),
                structure_fraction: entity.structure.map(Structure::fraction),
                temperature_c: entity.reactive_state.map(|state| state.temperature_c),
                moisture: entity.reactive_state.map(|state| state.moisture),
                fuel: entity.reactive_state.map(|state| state.fuel),
                burning: entity.reactive_state.map(|state| state.burning),
                cooked: entity.reactive_state.map(|state| state.cooked),
                charred: entity.reactive_state.map(|state| state.charred),
            })
            .collect();
        WorldReceipt {
            schema: "pocket3d.playable-world.receipt.v1",
            scenario: scenario.into(),
            seed: self.seed,
            ticks: self.world.tick(),
            state_hash: format!("{:016x}", self.world.state_hash()),
            contact_count: self.receipts.contact_count,
            fractured_entities: ids(&self.receipts.fractured),
            detached_entities: ids(&self.receipts.detached),
            ignited_entities: ids(&self.receipts.ignited),
            extinguished_entities: ids(&self.receipts.extinguished),
            cooked_entities: ids(&self.receipts.cooked),
            charred_entities: ids(&self.receipts.charred),
            water,
            acceptance,
            landmarks: self.receipts.landmarks.clone(),
            entities,
        }
    }

    pub fn is_holding_apple(&self) -> bool {
        self.held_apple.is_some_and(|apple_id| {
            self.world.entity(apple_id).is_some_and(|apple| {
                apple
                    .attachment
                    .is_some_and(|attachment| attachment.parent == self.ids.player)
            })
        })
    }

    pub fn water_burst_active(&self) -> bool {
        self.water_burst_turns > 0
    }

    pub fn prepare_campfire_douse_scenario(&mut self) {
        let Some(fire_position) = self
            .world
            .entity(self.ids.fire)
            .map(|fire| fire.transform.position)
        else {
            return;
        };
        let player_xz = Vec2::new(fire_position.x, fire_position.z + 2.30);
        if let Some(player) = self.world.entity_mut(self.ids.player) {
            player.transform.position =
                player_capsule_center(player_xz, OrchardEnvironment::height_at(player_xz));
            player.transform.rotation = Quat::IDENTITY;
            if let Some(body) = player.body.as_mut() {
                body.linear_velocity = Vec3::ZERO;
                body.angular_velocity = Vec3::ZERO;
            }
        }
        self.orbit_yaw = 0.72;
        self.orbit_pitch = -0.16;
        self.message = "Let the logs catch, then soak the whole campfire".into();
        self.message_turns = 120;
    }

    fn water_receipt(&self) -> WaterReceipt {
        let delivered_by_entity: Vec<_> = self
            .receipts
            .water_delivered
            .iter()
            .map(|(&entity, &amount)| WaterDoseReceipt {
                entity: entity.0,
                amount,
            })
            .collect();
        let delivered = delivered_by_entity
            .iter()
            .map(|dose| dose.amount)
            .sum::<f32>()
            .max(0.0)
            .min(self.receipts.water_emitted.max(0.0));
        WaterReceipt {
            emitted: self.receipts.water_emitted,
            delivered,
            delivered_by_entity,
            last_spray_tick: self.receipts.last_water_tick,
            campfire_douse: self.campfire_douse_receipt(),
        }
    }

    fn campfire_douse_receipt(&self) -> CampfireDouseReceipt {
        let entities: Vec<_> = std::iter::once(self.ids.fire)
            .chain(self.ids.camp_logs.iter().copied())
            .collect();
        let last_spray_tick = self.receipts.last_water_tick;
        // With the world chemistry contract, a cooled/saturated non-burning
        // entity has no active combustion left. Requiring a legacy transition
        // event would exclude logs that were in their ignition hysteresis band
        // when the burst began but were quenched before a burning frame.
        let all_extinguished = entities.iter().all(|entity| {
            self.receipts.water_delivered.contains_key(entity)
                && self.world.entity(*entity).is_some_and(|entity| {
                    entity
                        .reactive_state
                        .is_some_and(|state| !state.burning && state.moisture > 0.0)
                })
        });
        let all_not_burning = entities.iter().all(|entity| {
            self.world
                .entity(*entity)
                .and_then(|entity| entity.reactive_state)
                .is_some_and(|state| !state.burning)
        });
        let reignited_after_spray: Vec<_> = entities
            .iter()
            .filter(|entity| {
                last_spray_tick.is_some_and(|last_spray| {
                    self.receipts
                        .last_ignited_tick
                        .get(entity)
                        .is_some_and(|last_ignited| *last_ignited > last_spray)
                })
            })
            .map(|entity| entity.0)
            .collect();
        let post_spray_turns = last_spray_tick
            .map(|last_spray| self.world.tick().saturating_sub(last_spray))
            .unwrap_or(0);
        let passed = all_extinguished
            && all_not_burning
            && reignited_after_spray.is_empty()
            && self.receipts.water_emitted > 0.0
            && self.receipts.water_delivered.values().copied().sum::<f32>()
                <= self.receipts.water_emitted + 1e-5
            && post_spray_turns >= CAMPFIRE_DOUSE_STABILITY_TURNS;
        CampfireDouseReceipt {
            entities: entities.into_iter().map(|entity| entity.0).collect(),
            all_extinguished,
            all_not_burning,
            reignited_after_spray,
            post_spray_turns,
            required_stability_turns: CAMPFIRE_DOUSE_STABILITY_TURNS,
            passed,
        }
    }

    pub fn acceptance(&self) -> AcceptanceReceipt {
        let tree_fractured = self
            .ids
            .trees
            .iter()
            .any(|tree| self.receipts.fractured.contains(&tree.trunk));
        let detached_apples: BTreeSet<_> = self
            .ids
            .trees
            .iter()
            .flat_map(|tree| tree.apples.iter().copied())
            .filter(|id| self.receipts.detached.contains(id))
            .collect();
        let fruit_detached = detached_apples.len() >= 3;
        let detached_fruit_hit_terrain = detached_apples
            .iter()
            .any(|id| self.receipts.terrain_contacts.contains(id));
        let hot_tree = self.ids.trees.iter().any(|tree| {
            self.receipts
                .peak_temperature
                .get(&tree.trunk)
                .is_some_and(|temperature| *temperature > 180.0)
        });
        let fire_changed_reactive_state =
            hot_tree || !self.receipts.cooked.is_empty() || !self.receipts.charred.is_empty();
        let spatial_fire_propagated = self
            .ids
            .camp_logs
            .iter()
            .any(|id| self.receipts.ignited.contains(id));
        let damp_fuel_resisted_ignition = self
            .world
            .entity(self.ids.damp_log)
            .and_then(|entity| entity.reactive_state)
            .is_some_and(|state| !state.burning && state.moisture > 0.45);
        let playable_chain_complete = tree_fractured
            && fruit_detached
            && detached_fruit_hit_terrain
            && fire_changed_reactive_state
            && spatial_fire_propagated
            && damp_fuel_resisted_ignition;
        AcceptanceReceipt {
            tree_fractured,
            fruit_detached,
            detached_fruit_hit_terrain,
            fire_changed_reactive_state,
            spatial_fire_propagated,
            damp_fuel_resisted_ignition,
            playable_chain_complete,
        }
    }

    fn reset_world(&mut self) {
        let (world, ids) = build_world(self.seed, &self.environment);
        self.world = world;
        self.ids = ids;
        self.receipts = RuntimeReceipts::default();
        self.pending = PendingActions::default();
        self.held_apple = None;
        self.axe_swing_turns = 0;
        self.water_burst_turns = 0;
        self.last_target = None;
        self.message = "World reset from seed".into();
        self.message_turns = 150;
    }

    fn player_position(&self) -> Vec3 {
        self.world
            .entity(self.ids.player)
            .map(|entity| entity.transform.position)
            .unwrap_or(Vec3::ZERO)
    }

    fn move_player(&mut self, input: &Input, dt: f32) {
        let axis = Vec2::new(
            (input.key_down(KeyCode::KeyD) as i32 - input.key_down(KeyCode::KeyA) as i32) as f32,
            (input.key_down(KeyCode::KeyW) as i32 - input.key_down(KeyCode::KeyS) as i32) as f32,
        );
        let movement = camera_relative_movement(axis, self.orbit_yaw);
        let mut position = self.player_position();
        let previous = position;
        position += movement * MOVE_SPEED * dt;
        position.x = position.x.clamp(-19.5, 19.5);
        position.z = position.z.clamp(-19.5, 19.5);
        for tree in &self.ids.trees {
            let root = tree.root;
            let delta = Vec2::new(position.x - root.x, position.z - root.z);
            let minimum = 0.72 * tree.size;
            if delta.length_squared() < minimum * minimum {
                let push = delta.normalize_or(Vec2::X) * minimum;
                position.x = root.x + push.x;
                position.z = root.z + push.y;
            }
        }
        let xz = Vec2::new(position.x, position.z);
        position = player_capsule_center(xz, OrchardEnvironment::height_at(xz));
        if let Some(player) = self.world.entity_mut(self.ids.player) {
            let velocity = (position - previous) / dt.max(0.0001);
            player.transform.position = position;
            if movement.length_squared() > 0.0 {
                let yaw = (-movement.x).atan2(-movement.z);
                player.transform.rotation = Quat::from_rotation_y(yaw);
            }
            if let Some(body) = player.body.as_mut() {
                body.linear_velocity = velocity;
            }
        }
        if movement.length_squared() > 0.0 {
            self.walk_phase += dt * 8.5;
        }
    }

    fn sync_held_apple_to_hand(&mut self) {
        let Some(apple_id) = self.held_apple else {
            return;
        };
        let Some(position) = self
            .assets
            .as_ref()
            .and_then(|assets| self.held_apple_socket_position(assets, self.presentation_time))
        else {
            return;
        };
        let Some(player_transform) = self
            .world
            .entity(self.ids.player)
            .map(|player| player.transform)
        else {
            return;
        };
        let local_position = inverse_transform_point(player_transform, position);
        if let Some(apple) = self.world.entity_mut(apple_id) {
            apple.transform.position = position;
            apple.transform.rotation = Quat::IDENTITY;
            apple.transform.scale = Vec3::ONE;
            if let Some(attachment) = apple
                .attachment
                .as_mut()
                .filter(|attachment| attachment.parent == self.ids.player)
            {
                attachment.local.position = local_position;
                attachment.local.rotation = Quat::IDENTITY;
                attachment.local.scale = Vec3::ONE;
            }
        }
    }

    fn chop_nearest(&mut self) {
        let player = self.player_position();
        let target = self
            .ids
            .trees
            .iter()
            .filter(|tree| {
                self.world
                    .entity(tree.trunk)
                    .and_then(|entity| entity.structure)
                    .is_some_and(|structure| !structure.fractured)
            })
            .min_by(|a, b| {
                horizontal_distance_squared(player, a.root)
                    .total_cmp(&horizontal_distance_squared(player, b.root))
            })
            .filter(|tree| horizontal_distance_squared(player, tree.root) <= CHOP_REACH.powi(2))
            .map(|tree| tree.trunk);
        let Some(target) = target else {
            self.say("No standing tree in axe range", 90);
            return;
        };
        let direction = self
            .world
            .entity(target)
            .map(|entity| {
                (entity.transform.position - player)
                    .with_y(0.0)
                    .normalize_or(Vec3::X)
            })
            .unwrap_or(Vec3::X);
        self.world.queue_interaction(Interaction::Cut {
            target,
            direction,
            energy: 1.15,
        });
        self.axe_swing_turns = AXE_SWING_TURNS;
        self.say("Axe impact: structure integrity reduced", 85);
    }

    fn ignite_nearest(&mut self) {
        let player = self.player_position();
        let fractured_tree = self
            .ids
            .trees
            .iter()
            .filter(|tree| {
                self.world
                    .entity(tree.trunk)
                    .and_then(|entity| entity.structure)
                    .is_some_and(|structure| structure.fractured)
            })
            .min_by(|a, b| {
                horizontal_distance_squared(player, a.root)
                    .total_cmp(&horizontal_distance_squared(player, b.root))
            })
            .filter(|tree| {
                self.world.entity(tree.trunk).is_some_and(|entity| {
                    entity.transform.position.distance(player) <= ACTION_REACH
                })
            })
            .map(|tree| tree.trunk);
        let target = fractured_tree.or_else(|| self.nearest_reactive(player, ACTION_REACH, false));
        let Some(target) = target else {
            self.say("No reactive material in ember range", 90);
            return;
        };
        self.world.queue_interaction(Interaction::Ignite {
            target,
            energy: 1_050.0,
        });
        self.last_target = Some(target);
        self.say("Ember transferred heat into the material", 110);
    }

    fn begin_water_burst(&mut self) {
        self.water_burst_turns = WATER_BURST_TURNS;
    }

    fn current_water_jet(&self) -> Option<WaterJet> {
        let player = self.world.entity(self.ids.player)?;
        Some(water_jet(player.transform))
    }

    fn water_contacts(&self, jet: WaterJet) -> Vec<(EntityId, WaterContact)> {
        self.world
            .entities()
            .filter_map(|(&id, entity)| {
                (!entity.has_tag("player")
                    && entity.reactive_material.is_some()
                    && entity.reactive_state.is_some())
                .then(|| water_jet_contact(jet, entity.transform, entity.collider))
                .flatten()
                .map(|contact| (id, contact))
            })
            .collect()
    }

    fn queue_water_douse(&mut self) -> Vec<WaterDose> {
        let Some(jet) = self.current_water_jet() else {
            return Vec::new();
        };
        let doses = allocate_water_doses(self.water_contacts(jet), WATER_DOUSE_BUDGET_PER_TURN);
        for dose in &doses {
            self.world.queue_interaction(Interaction::Douse {
                target: dose.target,
                amount: dose.amount,
            });
        }
        self.receipts.observe_water(
            self.world.tick().saturating_add(1),
            WATER_DOUSE_BUDGET_PER_TURN,
            &doses,
        );
        self.last_target = doses.first().map(|dose| dose.target).or(self.last_target);
        doses
    }

    fn nearest_reactive(
        &self,
        origin: Vec3,
        reach: f32,
        require_burning: bool,
    ) -> Option<EntityId> {
        self.world
            .entities()
            .filter(|(_, entity)| {
                entity
                    .reactive_state
                    .is_some_and(|state| !require_burning || state.burning)
                    && !entity.has_tag("player")
            })
            .filter_map(|(&id, entity)| {
                let distance = entity.transform.position.distance(origin);
                (distance <= reach).then_some((id, distance))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(id, _)| id)
    }

    fn pickup_or_drop(&mut self) {
        if let Some(apple_id) = self.held_apple.take() {
            let forward = self
                .world
                .entity(self.ids.player)
                .map(|player| player.transform.rotation * Vec3::NEG_Z)
                .unwrap_or(Vec3::NEG_Z)
                .with_y(0.0)
                .normalize_or(Vec3::NEG_Z);
            let socket_position = self
                .assets
                .as_ref()
                .and_then(|assets| self.held_apple_socket_position(assets, self.presentation_time));
            if let Some(apple) = self.world.entity_mut(apple_id) {
                apple.attachment = None;
                if let Some(position) = socket_position {
                    apple.transform.position = position;
                    apple.transform.rotation = Quat::IDENTITY;
                    apple.transform.scale = Vec3::ONE;
                }
                if let Some(body) = apple.body.as_mut() {
                    body.mode = BodyMode::Dynamic;
                    body.linear_velocity = forward * 2.2 + Vec3::Y * 1.1;
                    body.wake();
                }
            }
            self.say("Dropped apple: rigid body restored", 90);
            return;
        }
        let player = self.player_position();
        let apple = self
            .ids
            .trees
            .iter()
            .flat_map(|tree| tree.apples.iter().copied())
            .filter(|id| {
                self.world
                    .entity(*id)
                    .is_some_and(|entity| entity.attachment.is_none())
            })
            .filter_map(|id| {
                self.world
                    .entity(id)
                    .map(|entity| (id, entity.transform.position.distance(player)))
            })
            .filter(|(_, distance)| *distance <= 1.55)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(id, _)| id);
        let Some(apple_id) = apple else {
            self.say("No loose apple close enough to pick up", 90);
            return;
        };
        if let Some(apple) = self.world.entity_mut(apple_id) {
            apple.attachment = Some(Attachment {
                parent: self.ids.player,
                // Keep the simulation proxy close to the authored left hand.
                // Rendering uses the sampled hand.L socket below, including
                // the active Idle/Walk/Chop animation.
                local: Transform::from_translation(HELD_APPLE_ATTACHMENT_OFFSET),
                release_impulse: Vec3::ZERO,
            });
        }
        self.held_apple = Some(apple_id);
        self.say("Picked up apple in the explorer's left hand", 95);
    }

    fn say(&mut self, message: impl Into<String>, turns: u16) {
        self.message = message.into();
        self.message_turns = turns;
    }

    fn observe_report(&mut self, report: &StepReport) {
        self.receipts.observe(report, &self.world);
        for event in &report.events {
            match event {
                WorldEvent::Fractured { .. } => {
                    self.say("Tree fractured: trunk, stump, and fruit separated", 180)
                }
                WorldEvent::Ignited { entity } => {
                    let name = self
                        .world
                        .entity(*entity)
                        .and_then(|entity| entity.name.as_deref())
                        .unwrap_or("material");
                    self.say(format!("{name} reached ignition temperature"), 140);
                }
                WorldEvent::Extinguished { .. } => {
                    self.say("Combustion stopped by moisture and cooling", 140)
                }
                WorldEvent::Cooked { .. } => self.say("Apple cooked from accumulated heat", 140),
                WorldEvent::Charred { .. } => self.say("Material crossed its char threshold", 140),
                _ => {}
            }
        }
    }

    fn update_camera(&mut self) {
        let foot = self.player_position() - Vec3::Y * PLAYER_HEIGHT;
        let (position, focus) = player_camera_pose(foot, self.orbit_yaw, self.orbit_pitch);
        self.camera.pos = position;
        self.camera.look_at(focus);
    }

    fn rebuild_scene(&mut self, time: f32, size: (u32, u32)) {
        let Some(assets) = self.assets.clone() else {
            return;
        };
        self.scene.models.clear();
        self.scene.sprites.clear();
        self.scene.beams.clear();
        self.scene.time = time;
        self.scene.models.push(art::instance(
            &assets.ground,
            Mat4::IDENTITY,
            [1.0, 1.0, 1.0, 1.0],
        ));
        for decoration in &self.decorations {
            let asset = match decoration.kind {
                DecorationKind::Grass => &assets.grass,
                DecorationKind::Rock => &assets.rock,
            };
            self.scene
                .models
                .push(art::instance(asset, decoration.transform, decoration.tint));
        }

        for tree in self.ids.trees.clone() {
            let Some((entity_transform, reaction, fractured)) =
                self.world.entity(tree.trunk).map(|entity| {
                    (
                        entity.transform,
                        entity.reactive_state.unwrap_or_default(),
                        entity
                            .structure
                            .is_some_and(|structure| structure.fractured),
                    )
                })
            else {
                continue;
            };
            let world = transform_matrix(entity_transform);
            let char_amount = reaction
                .char_progress
                .max(if reaction.charred { 1.0 } else { 0.0 });
            let heat = ((reaction.temperature_c - 80.0) / 450.0).clamp(0.0, 1.0);
            let bark = mix4(
                [0.47, 0.25, 0.105, 1.0],
                [0.12, 0.085, 0.065, 1.0],
                char_amount,
            );
            let leaf = mix4(
                mix4(
                    [0.28, 0.57, 0.20, 1.0],
                    [0.68, 0.38, 0.12, 1.0],
                    heat * 0.65,
                ),
                [0.09, 0.10, 0.07, 1.0],
                char_amount,
            );
            self.scene.models.push(art::instance(
                &assets.trunk,
                world * Mat4::from_scale(Vec3::new(0.46, 4.8, 0.46) * tree.size),
                bark,
            ));
            for (a, b, radius) in branch_layout(tree.size) {
                self.scene.models.push(art::instance(
                    &assets.branch,
                    world * between_y(a, b, radius),
                    bark,
                ));
            }
            self.scene.models.push(art::instance(
                &assets.canopy,
                world
                    * Mat4::from_scale_rotation_translation(
                        Vec3::new(2.15, 1.62, 2.0) * tree.size,
                        Quat::from_rotation_y((tree.seed as f32 * 0.17).sin()),
                        Vec3::Y * 1.72 * tree.size,
                    ),
                leaf,
            ));
            if fractured {
                self.scene.models.push(art::instance(
                    &assets.stump,
                    Mat4::from_scale_rotation_translation(
                        Vec3::new(0.62, 0.48, 0.62) * tree.size,
                        Quat::IDENTITY,
                        tree.root + Vec3::Y * 0.24 * tree.size,
                    ),
                    [0.49, 0.27, 0.12, 1.0],
                ));
                self.push_shadow(
                    &assets.shadow,
                    entity_transform.position,
                    1.6 * tree.size,
                    [0.17, 0.23, 0.10, 1.0],
                );
            }
        }

        let apples: Vec<_> = self
            .ids
            .trees
            .iter()
            .flat_map(|tree| tree.apples.iter().copied())
            .collect();
        let held_apple_matrix = self
            .held_apple
            .zip(self.held_apple_render_transform(&assets, time));
        for apple_id in apples {
            let Some((apple_transform, state, detached)) =
                self.world.entity(apple_id).map(|apple| {
                    (
                        apple.transform,
                        apple.reactive_state.unwrap_or_default(),
                        apple.attachment.is_none(),
                    )
                })
            else {
                continue;
            };
            let tint = if state.charred {
                [0.11, 0.075, 0.045, 1.0]
            } else if state.cooked {
                [0.96, 0.44, 0.075, 1.0]
            } else {
                mix4(
                    [0.78, 0.055, 0.035, 1.0],
                    [1.0, 0.36, 0.06, 1.0],
                    ((state.temperature_c - 40.0) / 240.0).clamp(0.0, 1.0),
                )
            };
            let held = held_apple_matrix.is_some_and(|(held_id, _)| held_id == apple_id);
            let matrix = held_apple_matrix
                .filter(|(held_id, _)| *held_id == apple_id)
                .map_or_else(|| transform_matrix(apple_transform), |(_, matrix)| matrix);
            self.scene.models.push(art::instance(
                &assets.apple,
                matrix * Mat4::from_scale(Vec3::new(0.205, 0.225, 0.205)),
                tint,
            ));
            self.scene.models.push(art::instance(
                &assets.leaf,
                matrix
                    * Mat4::from_scale_rotation_translation(
                        Vec3::new(0.07, 0.18, 0.05),
                        Quat::from_rotation_z(-0.72),
                        Vec3::new(0.02, 0.21, 0.0),
                    ),
                [0.20, 0.42, 0.12, 1.0],
            ));
            if detached && !held {
                self.push_shadow(
                    &assets.shadow,
                    apple_transform.position,
                    0.27,
                    [0.17, 0.22, 0.10, 1.0],
                );
            }
        }

        for &log_id in self
            .ids
            .camp_logs
            .iter()
            .chain(std::iter::once(&self.ids.damp_log))
        {
            let Some(log) = self.world.entity(log_id) else {
                continue;
            };
            let state = log.reactive_state.unwrap_or_default();
            let tint = mix4(
                [0.39, 0.19, 0.075, 1.0],
                [0.10, 0.075, 0.055, 1.0],
                state.char_progress,
            );
            self.scene.models.push(art::instance(
                &assets.trunk,
                transform_matrix(log.transform) * Mat4::from_scale(Vec3::new(0.19, 1.35, 0.19)),
                tint,
            ));
        }
        self.render_campfire(&assets);
        self.render_player(&assets, time);
        self.render_water_burst();
        self.render_combustion(&assets, time);
        self.update_camera();
        self.update_hud(size);
    }

    fn render_campfire(&mut self, assets: &WorldAssets) {
        let Some(fire) = self.world.entity(self.ids.fire) else {
            return;
        };
        let center = fire.transform.position.with_y(
            OrchardEnvironment::height_at(Vec2::new(
                fire.transform.position.x,
                fire.transform.position.z,
            )) + 0.08,
        );
        for index in 0..9 {
            let angle = index as f32 / 9.0 * TAU;
            let position = center + Vec3::new(angle.cos() * 0.58, 0.04, angle.sin() * 0.58);
            self.scene.models.push(art::instance(
                &assets.rock,
                Mat4::from_scale_rotation_translation(
                    Vec3::new(0.34, 0.23, 0.30),
                    Quat::from_rotation_y(angle * 1.7),
                    position,
                ),
                [0.39, 0.41, 0.36, 1.0],
            ));
        }
    }

    fn render_player(&mut self, assets: &WorldAssets, time: f32) {
        let Some(player_transform) = self
            .world
            .entity(self.ids.player)
            .map(|player| player.transform)
        else {
            return;
        };
        self.push_shadow(
            &assets.shadow,
            player_transform.position,
            0.43,
            [0.14, 0.20, 0.09, 1.0],
        );
        let Some(pose) = self.current_explorer_pose(assets, time) else {
            return;
        };
        let mut explorer = ModelInstance::new(assets.explorer.clone());
        explorer.transform = pose.transform;
        explorer.anim = pose.anim;
        self.scene.models.push(explorer);
    }

    fn current_explorer_pose(&self, assets: &WorldAssets, time: f32) -> Option<ExplorerPose> {
        let player = self.world.entity(self.ids.player)?;
        let moving = player
            .body
            .is_some_and(|body| body.linear_velocity.length_squared() > 0.05);
        Some(explorer_pose(
            player.transform,
            moving,
            assets.explorer.aabb.0.y,
            assets.explorer_animations,
            time,
            self.walk_phase,
            self.axe_swing_turns,
        ))
    }

    fn held_apple_socket_position(&self, assets: &WorldAssets, time: f32) -> Option<Vec3> {
        let pose = self.current_explorer_pose(assets, time)?;
        let hand = assets
            .explorer
            .sampled_node_transform(assets.explorer_left_hand, &pose.anim)?;
        Some(held_apple_socket_transform(pose.transform, hand).transform_point3(Vec3::ZERO))
    }

    fn held_apple_render_transform(&self, assets: &WorldAssets, time: f32) -> Option<Mat4> {
        self.held_apple?;
        self.held_apple_socket_position(assets, time)
            .map(Mat4::from_translation)
    }

    fn render_water_burst(&mut self) {
        if self.water_burst_turns == 0 {
            return;
        }
        let Some(jet) = self.current_water_jet() else {
            return;
        };
        let burst_age = WATER_BURST_TURNS.saturating_sub(self.water_burst_turns);
        let samples = water_jet_samples(jet);
        let right = jet.direction.cross(Vec3::Y).normalize_or(Vec3::X);
        let up = right.cross(jet.direction).normalize_or(Vec3::Y);
        for segment in samples.windows(2) {
            let sample = segment[1];
            let fade = 0.34 + sample.retention * 0.66;
            self.scene.beams.push(Beam {
                a: segment[0].center,
                b: sample.center,
                width: 0.10 - sample.distance / jet.length * 0.035,
                color: [0.12, 0.68, 1.0, 0.94 * fade],
            });
            self.scene.sprites.push(Sprite {
                pos: sample.center,
                size: 0.13 + sample.radius * 0.10,
                color: [0.30, 0.84, 1.0, 0.86 * fade],
            });
        }
        // Two deterministic curtains stay within the same sampled
        // cross-sections used by hit testing. They make the short burst read
        // from a rear camera without inventing a second gameplay trajectory.
        for side in [-1.0_f32, 1.0] {
            let mut previous = jet.origin;
            for (index, sample) in samples.iter().copied().enumerate().skip(1) {
                let fraction = sample.distance / jet.length;
                let point = water_curtain_point(sample, right, up, side, index, burst_age);
                let fade = (0.34 + sample.retention * 0.66) * (1.0 - fraction * 0.18);
                self.scene.beams.push(Beam {
                    a: previous,
                    b: point,
                    width: 0.058 - fraction * 0.018,
                    color: [0.16, 0.72, 1.0, 0.78 * fade],
                });
                if index % 2 == 1 {
                    self.scene.sprites.push(Sprite {
                        pos: point,
                        size: 0.10 + sample.radius * 0.16,
                        color: [0.42, 0.88, 1.0, 0.75 * fade],
                    });
                }
                previous = point;
            }
        }
        self.scene.sprites.push(Sprite {
            pos: jet.origin,
            size: 0.22,
            color: [0.52, 0.94, 1.0, 0.96],
        });
    }

    fn render_combustion(&mut self, assets: &WorldAssets, time: f32) {
        for (&id, entity) in self.world.entities() {
            let Some(state) = entity.reactive_state else {
                continue;
            };
            if !state.burning {
                continue;
            }
            let scale = entity
                .collider
                .map_or(0.35, Collider::radius)
                .clamp(0.25, 1.2);
            let flame_count = if entity.has_tag("tree") {
                5
            } else if entity.has_tag("fire") {
                3
            } else {
                2
            };
            let axis = entity.transform.rotation * Vec3::Y;
            for index in 0..flame_count {
                let phase =
                    time * (4.1 + index as f32 * 0.17) + id.0 as f32 * 0.91 + index as f32 * 2.4;
                let along = if entity.has_tag("tree") {
                    // The capsule origin sits at the trunk midpoint. Bias
                    // flames towards the lower half so fracture heat reads at
                    // the cut instead of behind the crown.
                    -0.9 + index as f32 / (flame_count - 1) as f32 * 0.95
                } else {
                    (index as f32 - (flame_count - 1) as f32 * 0.5) * 0.38
                };
                let radial = Vec3::new(phase.sin(), 0.0, (phase * 1.31).cos()) * scale * 0.26;
                let position = entity.transform.position + axis * along + radial + Vec3::Y * 0.04;
                let pulse = 0.88 + (phase * 1.7).sin() * 0.12;
                let mut flame = art::instance(
                    &assets.flame,
                    Mat4::from_scale_rotation_translation(
                        Vec3::new(scale * 0.48 * pulse, scale * 1.65, scale * 0.48 * pulse),
                        Quat::from_rotation_y(phase),
                        position,
                    ),
                    if index % 3 == 0 {
                        [1.0, 0.78, 0.09, 1.0]
                    } else {
                        [1.0, 0.25, 0.025, 1.0]
                    },
                );
                flame.lit = 0.0;
                self.scene.models.push(flame);
            }
            let count = if entity.has_tag("tree") { 14 } else { 8 };
            for index in 0..count {
                let phase =
                    time * (2.8 + index as f32 * 0.11) + id.0 as f32 * 0.73 + index as f32 * 2.17;
                let height = 0.18 + (index as f32 / count as f32) * (1.4 + scale);
                let radius = scale * (0.65 - index as f32 / count as f32 * 0.38);
                let position = entity.transform.position
                    + Vec3::new(phase.sin() * radius, height, (phase * 1.37).cos() * radius);
                let hot = index % 3 == 0;
                self.scene.sprites.push(Sprite {
                    pos: position,
                    size: scale * if hot { 0.95 } else { 0.72 },
                    color: if hot {
                        [1.0, 0.90, 0.24, 0.92]
                    } else {
                        [1.0, 0.25, 0.025, 0.76]
                    },
                });
            }
            for index in 0..4 {
                let phase = time * (1.4 + index as f32 * 0.2) + id.0 as f32;
                self.scene.sprites.push(Sprite {
                    pos: entity.transform.position
                        + Vec3::new(
                            phase.sin() * scale,
                            1.5 + (phase * 0.7 + index as f32).rem_euclid(2.4),
                            phase.cos() * scale,
                        ),
                    size: 0.09 + index as f32 * 0.015,
                    color: [1.0, 0.48, 0.05, 0.72],
                });
            }
        }
    }

    fn push_shadow(
        &mut self,
        shadow: &Arc<ModelAsset>,
        position: Vec3,
        radius: f32,
        tint: [f32; 4],
    ) {
        let ground = OrchardEnvironment::height_at(Vec2::new(position.x, position.z));
        self.scene.models.push(art::instance(
            shadow,
            Mat4::from_scale_rotation_translation(
                Vec3::splat(radius),
                Quat::IDENTITY,
                Vec3::new(position.x, ground + 0.018, position.z),
            ),
            tint,
        ));
    }

    fn update_hud(&mut self, size: (u32, u32)) {
        self.hud.clear();
        let width = size.0 as f32;
        let height = size.1 as f32;
        self.hud
            .rect(20.0, 20.0, 425.0, 102.0, [0.035, 0.075, 0.07, 0.78]);
        self.hud
            .text(36.0, 34.0, 2.0, [0.92, 0.84, 0.58, 1.0], "REACTIVE ORCHARD");
        self.hud.text(
            36.0,
            63.0,
            1.0,
            [0.87, 0.94, 0.84, 1.0],
            "WASD move  SPACE chop  F ember  Q water",
        );
        self.hud.text(
            36.0,
            80.0,
            1.0,
            [0.75, 0.87, 0.78, 1.0],
            "E pick/drop apple  mouse/arrow orbit  R reset",
        );
        self.hud.text(
            36.0,
            98.0,
            1.0,
            [0.62, 0.78, 0.69, 1.0],
            &format!(
                "turn {:05}  state {:016x}",
                self.world.tick(),
                self.world.state_hash()
            ),
        );

        let water = water_hud_state(self.water_burst_turns);
        self.hud
            .rect(20.0, 132.0, 224.0, 55.0, [0.025, 0.075, 0.105, 0.82]);
        self.hud.text(
            36.0,
            141.0,
            1.25,
            if water.spraying {
                [0.45, 0.90, 1.0, 1.0]
            } else {
                [0.64, 0.82, 0.86, 1.0]
            },
            if water.spraying {
                "WATER SPRAYING"
            } else {
                "WATER READY"
            },
        );
        self.hud
            .rect(36.0, 169.0, 192.0, 7.0, [0.025, 0.12, 0.16, 0.92]);
        self.hud.rect(
            36.0,
            169.0,
            192.0 * water.progress,
            7.0,
            if water.spraying {
                [0.12, 0.68, 0.98, 0.95]
            } else {
                [0.20, 0.48, 0.62, 0.78]
            },
        );

        let target_id = self
            .last_target
            .or_else(|| self.nearest_reactive(self.player_position(), 6.0, false));
        let target = target_id.and_then(|id| {
            let entity = self.world.entity(id)?;
            Some((id, entity.name.clone(), entity.reactive_state?))
        });
        if let Some((id, name, state)) = target {
            let panel_width = 300.0;
            self.hud.rect(
                width - panel_width - 20.0,
                20.0,
                panel_width,
                104.0,
                [0.035, 0.075, 0.07, 0.76],
            );
            let name = name.as_deref().unwrap_or("material");
            self.hud.text(
                width - panel_width - 4.0,
                34.0,
                1.5,
                [0.95, 0.82, 0.49, 1.0],
                &format!("{} #{}", name, id.0),
            );
            self.hud.text(
                width - panel_width - 4.0,
                59.0,
                1.0,
                [0.86, 0.92, 0.82, 1.0],
                &format!(
                    "TEMP {:>5.1} C   MOIST {:>3.0}%",
                    state.temperature_c,
                    state.moisture * 100.0
                ),
            );
            self.hud.text(
                width - panel_width - 4.0,
                76.0,
                1.0,
                [0.86, 0.92, 0.82, 1.0],
                &format!(
                    "FUEL {:>3.0}%   BURN {}",
                    state.fuel * 100.0,
                    if state.burning { "YES" } else { "NO" }
                ),
            );
            self.hud.text(
                width - panel_width - 4.0,
                93.0,
                1.0,
                [0.72, 0.84, 0.73, 1.0],
                &format!(
                    "COOK {:>3.0}%   CHAR {:>3.0}%",
                    state.cook_progress * 100.0,
                    state.char_progress * 100.0
                ),
            );
        }
        if self.message_turns > 0 {
            let panel_width = (self.message.len() as f32 * 8.0 + 38.0).min(width - 40.0);
            let x = (width - panel_width) * 0.5;
            self.hud.rect(
                x,
                height - 74.0,
                panel_width,
                38.0,
                [0.035, 0.065, 0.055, 0.84],
            );
            self.hud.text_centered(
                width * 0.5,
                height - 61.0,
                1.0,
                [0.94, 0.88, 0.66, 1.0],
                &self.message,
            );
        }
        self.hud.crosshair(
            width * 0.5,
            height * 0.5,
            5.0,
            6.0,
            1.5,
            [0.94, 0.89, 0.67, 0.7],
        );
    }
}

impl Game for WorldGame {
    fn init(&mut self, gpu: &Gpu, renderer: &mut Renderer) -> Result<()> {
        self.assets = Some(WorldAssets::load(gpu, renderer)?);
        Ok(())
    }

    fn frame(&mut self, dt: f32, input: &Input) {
        let mouse = input.mouse_delta();
        self.orbit_yaw = (self.orbit_yaw - mouse.x * 0.0028).rem_euclid(TAU);
        self.orbit_pitch = (self.orbit_pitch - mouse.y * 0.0024).clamp(-0.72, 0.34);
        let orbit_speed = 1.35 * dt.min(0.05);
        if input.key_down(KeyCode::ArrowLeft) {
            self.orbit_yaw += orbit_speed;
        }
        if input.key_down(KeyCode::ArrowRight) {
            self.orbit_yaw -= orbit_speed;
        }
        if input.key_down(KeyCode::ArrowUp) {
            self.orbit_pitch = (self.orbit_pitch + orbit_speed).min(0.34);
        }
        if input.key_down(KeyCode::ArrowDown) {
            self.orbit_pitch = (self.orbit_pitch - orbit_speed).max(-0.72);
        }
        self.pending.chop |= input.key_pressed(KeyCode::Space);
        self.pending.ignite |= input.key_pressed(KeyCode::KeyF);
        self.pending.pickup |= input.key_pressed(KeyCode::KeyE);
        self.pending.douse |= input.key_pressed(KeyCode::KeyQ);
        self.pending.reset |= input.key_pressed(KeyCode::KeyR);
    }

    fn tick(&mut self, dt: f32, input: &Input) {
        if std::mem::take(&mut self.pending.reset) {
            self.reset_world();
        }
        self.move_player(input, dt);
        if std::mem::take(&mut self.pending.chop) {
            self.chop_nearest();
        }
        if std::mem::take(&mut self.pending.ignite) {
            self.ignite_nearest();
        }
        if std::mem::take(&mut self.pending.pickup) {
            self.pickup_or_drop();
        }
        self.sync_held_apple_to_hand();
        let water_started = std::mem::take(&mut self.pending.douse);
        if water_started {
            self.begin_water_burst();
        }
        let water_targets = if self.water_burst_turns > 0 {
            self.queue_water_douse()
        } else {
            Vec::new()
        };
        if water_started {
            if water_targets.is_empty() {
                self.say("Water burst sprayed across the open ground", 90);
            } else {
                self.say(
                    format!(
                        "Water burst soaked {} reactive material{}",
                        water_targets.len(),
                        if water_targets.len() == 1 { "" } else { "s" }
                    ),
                    110,
                );
            }
        }
        let report = self.world.step(&self.environment);
        self.observe_report(&report);
        self.axe_swing_turns = self.axe_swing_turns.saturating_sub(1);
        self.water_burst_turns = self.water_burst_turns.saturating_sub(1);
        self.message_turns = self.message_turns.saturating_sub(1);
    }

    fn compose(&mut self, _alpha: f32, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud) {
        self.presentation_time = time;
        self.rebuild_scene(time, size);
        (&self.scene, &self.camera, &self.hud)
    }
}

fn build_world(seed: u64, environment: &OrchardEnvironment) -> (World, WorldIds) {
    let mut world = World::with_seed(seed);
    let player_xz = Vec2::new(0.0, 7.0);
    let mut player = EntityBundle::new(Transform::from_translation(player_capsule_center(
        player_xz,
        OrchardEnvironment::height_at(player_xz),
    )))
    .named("explorer")
    .tagged("player");
    let mut player_body = Body::static_body();
    player_body.mode = BodyMode::Kinematic;
    player_body.mass = 72.0;
    player.body = Some(player_body);
    player.collider = Some(Collider::CapsuleY {
        radius: 0.28,
        half_height: 0.55,
    });
    let player_id = world.spawn(player);

    let tree_roots = [
        (Vec2::new(0.0, 0.0), 1.0_f32, 0x101_u64, 5_usize),
        (Vec2::new(-6.3, -3.8), 0.86, 0x202, 4),
        (Vec2::new(6.2, -5.5), 0.92, 0x303, 4),
    ];
    let mut trees = Vec::new();
    for (index, (xz, size, tree_seed, apple_count)) in tree_roots.into_iter().enumerate() {
        let ground = OrchardEnvironment::height_at(xz);
        let root = Vec3::new(xz.x, ground, xz.y);
        let tree_transform = Transform::from_translation(root + Vec3::Y * 2.4 * size);
        let mut tree = EntityBundle::new(tree_transform)
            .named(format!("apple tree {}", index + 1))
            .tagged("tree")
            .tagged("wood");
        let mut body = Body::static_body();
        body.mass = 28.0 * size;
        tree.body = Some(body);
        tree.collider = Some(Collider::CapsuleY {
            radius: 0.46 * size,
            half_height: 2.0 * size,
        });
        tree.surface = PhysicalSurface {
            friction: 0.82,
            restitution: 0.04,
        };
        let mut structure = Structure::new(3.0, 1.0);
        structure.impact_threshold = 32.0;
        structure.impact_damage_scale = 0.025;
        tree.structure = Some(structure);
        tree.reactive_material = Some(ReactiveMaterial::wood());
        tree.reactive_state = Some(ReactiveState::new(
            environment.temperature_c,
            0.08 + index as f32 * 0.035,
            1.0,
        ));
        let trunk = world.spawn(tree);
        let mut apples = Vec::new();
        for apple_index in 0..apple_count {
            let angle = apple_index as f32 / apple_count as f32 * TAU
                + hash01(tree_seed, apple_index as u64) * 0.7;
            // Place fruit on the crown's outer shell so it reads as an apple
            // tree instead of disappearing inside the procedural canopy.
            let radius = (1.62 + hash01(tree_seed, apple_index as u64 + 10) * 0.42) * size;
            let local = Vec3::new(
                angle.cos() * radius,
                (1.10 + hash01(tree_seed, apple_index as u64 + 20) * 1.12) * size,
                angle.sin() * radius,
            );
            let local_transform = Transform::from_translation(local);
            let mut apple = EntityBundle::new(tree_transform.compose(local_transform))
                .named(format!("apple {}-{}", index + 1, apple_index + 1))
                .tagged("apple")
                .tagged("fruit");
            let mut body = Body::dynamic(0.16);
            body.linear_damping = 0.22;
            body.angular_damping = 0.3;
            apple.body = Some(body);
            apple.collider = Some(Collider::Sphere {
                radius: 0.205 * size,
            });
            apple.surface = PhysicalSurface {
                friction: 0.62,
                restitution: 0.38,
            };
            apple.attachment = Some(Attachment {
                parent: trunk,
                local: local_transform,
                release_impulse: Vec3::new(angle.cos(), 0.7, angle.sin()) * 0.22,
            });
            apple.reactive_material = Some(ReactiveMaterial::fruit());
            apple.reactive_state = Some(ReactiveState::new(environment.temperature_c, 0.38, 0.32));
            apples.push(world.spawn(apple));
        }
        trees.push(TreeVisual {
            trunk,
            apples,
            root,
            seed: tree_seed,
            size,
        });
    }

    let fire_xz = Vec2::new(4.25, 2.25);
    let fire_pos = Vec3::new(
        fire_xz.x,
        OrchardEnvironment::height_at(fire_xz) + 0.28,
        fire_xz.y,
    );
    let mut fire = EntityBundle::new(Transform::from_translation(fire_pos))
        .named("campfire flame")
        .tagged("fire");
    fire.body = Some(Body::static_body());
    fire.collider = Some(Collider::Sphere { radius: 0.32 });
    let mut fire_material = ReactiveMaterial::flame();
    fire_material.burn_rate = 0.011;
    fire.reactive_material = Some(fire_material);
    let mut fire_state = ReactiveState::new(760.0, 0.0, 1.0);
    fire_state.burning = true;
    fire.reactive_state = Some(fire_state);
    let fire_id = world.spawn(fire);

    let mut camp_logs = Vec::new();
    for (index, angle) in [0.52_f32, -0.52].into_iter().enumerate() {
        let offset = Vec3::new(angle.cos() * 0.25, 0.08, angle.sin() * 0.25);
        let mut log = EntityBundle::new(Transform {
            position: fire_pos + offset,
            rotation: Quat::from_rotation_z(FRAC_PI_2) * Quat::from_rotation_y(angle),
            scale: Vec3::ONE,
        })
        .named(format!("camp log {}", index + 1))
        .tagged("log")
        .tagged("wood");
        log.body = Some(Body::static_body());
        log.collider = Some(Collider::CapsuleY {
            radius: 0.19,
            half_height: 0.66,
        });
        log.reactive_material = Some(ReactiveMaterial::wood());
        log.reactive_state = Some(ReactiveState::new(environment.temperature_c, 0.03, 0.75));
        camp_logs.push(world.spawn(log));
    }

    // The soaked control sits inside the fire's nominal influence radius but
    // outside direct collider contact. It receives heat while moisture still
    // keeps it below ignition, making the resistance receipt meaningful.
    let damp_xz = Vec2::new(8.9, 2.25);
    let mut damp_log = EntityBundle::new(Transform {
        position: Vec3::new(
            damp_xz.x,
            OrchardEnvironment::height_at(damp_xz) + 0.22,
            damp_xz.y,
        ),
        rotation: Quat::from_rotation_z(FRAC_PI_2),
        scale: Vec3::ONE,
    })
    .named("rain-soaked log")
    .tagged("log")
    .tagged("wood")
    .tagged("wet");
    damp_log.body = Some(Body::static_body());
    damp_log.collider = Some(Collider::CapsuleY {
        radius: 0.19,
        half_height: 0.66,
    });
    let mut damp_material = ReactiveMaterial::wood();
    damp_material.drying_rate = 0.012;
    damp_material.moisture_resistance = 3.4;
    damp_log.reactive_material = Some(damp_material);
    damp_log.reactive_state = Some(ReactiveState::new(environment.temperature_c, 0.92, 0.8));
    let damp_log_id = world.spawn(damp_log);

    (
        world,
        WorldIds {
            player: player_id,
            fire: fire_id,
            trees,
            camp_logs,
            damp_log: damp_log_id,
        },
    )
}

fn build_decorations(seed: u64) -> Vec<Decoration> {
    let mut decorations = Vec::new();
    for index in 0..78_u64 {
        let x = hash_signed(seed ^ 0x71, index * 3) * 20.0;
        let z = hash_signed(seed ^ 0x72, index * 3 + 1) * 20.0;
        let position = Vec2::new(x, z);
        let clearings = [
            Vec2::new(0.0, 7.0),
            Vec2::ZERO,
            Vec2::new(-6.3, -3.8),
            Vec2::new(6.2, -5.5),
            Vec2::new(4.25, 2.25),
        ];
        if clearings
            .iter()
            .any(|center| center.distance(position) < 1.8)
        {
            continue;
        }
        let y = OrchardEnvironment::height_at(position);
        let scale = 0.42 + hash01(seed, index * 3 + 2) * 0.5;
        let tint_mix = hash01(seed ^ 0x88, index);
        decorations.push(Decoration {
            kind: DecorationKind::Grass,
            transform: Mat4::from_scale_rotation_translation(
                Vec3::new(scale, scale * (0.85 + tint_mix * 0.5), scale),
                Quat::from_rotation_y(hash01(seed ^ 0x99, index) * TAU),
                Vec3::new(x, y, z),
            ),
            tint: mix4([0.24, 0.49, 0.16, 1.0], [0.48, 0.62, 0.20, 1.0], tint_mix),
        });
    }
    for index in 0..17_u64 {
        let x = hash_signed(seed ^ 0xb1, index * 2) * 19.0;
        let z = hash_signed(seed ^ 0xb2, index * 2 + 1) * 19.0;
        let position = Vec2::new(x, z);
        let y = OrchardEnvironment::height_at(position);
        let scale = 0.26 + hash01(seed ^ 0xb3, index) * 0.58;
        decorations.push(Decoration {
            kind: DecorationKind::Rock,
            transform: Mat4::from_scale_rotation_translation(
                Vec3::splat(scale),
                Quat::from_rotation_y(hash01(seed ^ 0xb4, index) * TAU),
                Vec3::new(x, y, z),
            ),
            tint: mix4(
                [0.42, 0.46, 0.40, 1.0],
                [0.57, 0.54, 0.43, 1.0],
                hash01(seed ^ 0xb5, index),
            ),
        });
    }
    decorations
}

fn branch_layout(size: f32) -> [(Vec3, Vec3, f32); 5] {
    [
        (
            Vec3::new(0.0, 0.35, 0.0) * size,
            Vec3::new(1.05, 1.42, 0.20) * size,
            0.15 * size,
        ),
        (
            Vec3::new(0.0, 0.65, 0.0) * size,
            Vec3::new(-1.0, 1.58, -0.18) * size,
            0.14 * size,
        ),
        (
            Vec3::new(0.0, 0.82, 0.0) * size,
            Vec3::new(0.20, 1.64, 0.95) * size,
            0.12 * size,
        ),
        (
            Vec3::new(0.0, 1.08, 0.0) * size,
            Vec3::new(-0.22, 1.75, -0.82) * size,
            0.11 * size,
        ),
        (
            Vec3::new(0.0, 1.25, 0.0) * size,
            Vec3::new(0.62, 1.94, -0.42) * size,
            0.10 * size,
        ),
    ]
}

fn between_y(a: Vec3, b: Vec3, radius: f32) -> Mat4 {
    let delta = b - a;
    let length = delta.length().max(0.001);
    Mat4::from_scale_rotation_translation(
        Vec3::new(radius, length, radius),
        Quat::from_rotation_arc(Vec3::Y, delta / length),
        (a + b) * 0.5,
    )
}

fn transform_matrix(transform: Transform) -> Mat4 {
    Mat4::from_scale_rotation_translation(transform.scale, transform.rotation, transform.position)
}

fn inverse_transform_point(transform: Transform, world: Vec3) -> Vec3 {
    let scale = transform.scale.map(|component| {
        if component.abs() > f32::EPSILON {
            component
        } else {
            1.0
        }
    });
    (transform.rotation.inverse() * (world - transform.position)) / scale
}

fn horizontal_distance_squared(a: Vec3, b: Vec3) -> f32 {
    Vec2::new(a.x - b.x, a.z - b.z).length_squared()
}

fn mix4(a: [f32; 4], b: [f32; 4], amount: f32) -> [f32; 4] {
    let amount = amount.clamp(0.0, 1.0);
    std::array::from_fn(|index| a[index] + (b[index] - a[index]) * amount)
}

fn hash01(seed: u64, salt: u64) -> f32 {
    let mut value = seed ^ salt.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    (value >> 40) as f32 / (1_u32 << 24) as f32
}

fn hash_signed(seed: u64, salt: u64) -> f32 {
    hash01(seed, salt) * 2.0 - 1.0
}

fn ids(set: &BTreeSet<EntityId>) -> Vec<u64> {
    set.iter().map(|id| id.0).collect()
}

fn apply_tree_fall_script(input: &mut Input, turn: u64) {
    input.inject_key(KeyCode::KeyW, turn < 101);
    for action_turn in [108_u64, 138, 168] {
        input.inject_key(KeyCode::Space, turn == action_turn);
        if turn == action_turn + 1 {
            input.inject_key(KeyCode::Space, false);
        }
    }
}

pub fn apply_orchard_script(input: &mut Input, turn: u64) {
    apply_tree_fall_script(input, turn);
    input.inject_key(KeyCode::KeyF, turn == 228);
    if turn == 229 {
        input.inject_key(KeyCode::KeyF, false);
    }
}

pub fn apply_carry_script(input: &mut Input, turn: u64) {
    apply_tree_fall_script(input, turn);
    input.inject_key(KeyCode::KeyE, turn == 300);
    if turn == 301 {
        input.inject_key(KeyCode::KeyE, false);
    }
}

pub fn apply_campfire_douse_script(input: &mut Input, turn: u64) {
    input.inject_key(KeyCode::KeyQ, turn == 120);
    if turn == 121 {
        input.inject_key(KeyCode::KeyQ, false);
    }
}

#[cfg(test)]
mod tests {
    use std::f32::consts::PI;

    use super::*;

    fn scripted_run(seed: u64, turns: u64) -> WorldGame {
        let mut game = WorldGame::new(seed);
        let mut input = Input::default();
        for turn in 0..turns {
            apply_orchard_script(&mut input, turn);
            game.frame(1.0 / 60.0, &input);
            game.tick(1.0 / 60.0, &input);
            input.end_frame();
        }
        game
    }

    #[test]
    fn orchard_recipe_is_replayable() {
        let a = scripted_run(7, 720);
        let b = scripted_run(7, 720);
        assert_eq!(a.world.state_hash(), b.world.state_hash());
        assert_eq!(
            serde_json::to_value(a.runtime_receipt("test")).unwrap(),
            serde_json::to_value(b.runtime_receipt("test")).unwrap()
        );
    }

    #[test]
    fn scripted_orchard_completes_the_systemic_chain() {
        let game = scripted_run(7, 720);
        let receipt = game.runtime_receipt("orchard-fire");
        assert!(receipt.acceptance.playable_chain_complete, "{receipt:#?}");
    }

    #[test]
    fn environment_height_and_normal_are_finite() {
        for z in -20..=20 {
            for x in -20..=20 {
                let position = Vec2::new(x as f32, z as f32);
                assert!(OrchardEnvironment::height_at(position).is_finite());
                let normal = OrchardEnvironment::normal_at(position);
                assert!(normal.is_finite());
                assert!((normal.length() - 1.0).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn lateral_input_uses_the_camera_right_basis() {
        for yaw in [0.0, FRAC_PI_2, PI, -FRAC_PI_2, 0.713] {
            let camera = Camera {
                yaw,
                ..Camera::default()
            };
            let d_movement = camera_relative_movement(Vec2::X, yaw);
            let a_movement = camera_relative_movement(-Vec2::X, yaw);

            assert!(d_movement.distance(camera.right()) < 1e-6);
            assert!(a_movement.distance(-camera.right()) < 1e-6);
            assert!(d_movement.dot(camera.forward_flat()).abs() < 1e-6);
        }
        assert_eq!(camera_relative_movement(Vec2::X, 0.0), Vec3::X);
    }

    #[test]
    fn explorer_feet_stay_on_ground_for_every_facing_yaw() {
        let xz = Vec2::new(3.25, -4.5);
        let ground = -0.37;
        let center = player_capsule_center(xz, ground);
        assert_eq!(center.y - PLAYER_HEIGHT, ground);

        let model_min_y = -0.025;
        for yaw in [0.0, FRAC_PI_2, PI, -FRAC_PI_2, 0.713] {
            let player = Transform {
                position: center,
                rotation: Quat::from_rotation_y(yaw),
                scale: Vec3::ONE,
            };
            let render = grounded_explorer_transform(player, model_min_y);
            let rendered_foot = render.transform_point3(Vec3::new(0.0, model_min_y, 0.0));
            assert!((rendered_foot.y - ground).abs() < 1e-6);
            assert!(Vec2::new(rendered_foot.x, rendered_foot.z).distance(xz) < 1e-6);
        }
    }

    #[test]
    fn explorer_action_is_idle_walk_or_chop_with_chop_priority() {
        assert_eq!(explorer_action(false, 0), ExplorerAction::Idle);
        assert_eq!(explorer_action(true, 0), ExplorerAction::Walk);
        assert_eq!(explorer_action(false, 1), ExplorerAction::Chop);
        assert_eq!(explorer_action(true, 1), ExplorerAction::Chop);

        let animations = ExplorerAnimations {
            idle: 3,
            walk: 5,
            chop: 7,
            walk_duration: 0.8,
            chop_duration: 0.6,
        };
        let idle = explorer_animation(ExplorerAction::Idle, animations, 2.25, 0.0, 0);
        assert_eq!(idle.clip, 3);
        assert_eq!(idle.time, 2.25);
        assert!(idle.looping);

        let walk = explorer_animation(ExplorerAction::Walk, animations, 0.0, PI, 0);
        assert_eq!(walk.clip, 5);
        assert!((walk.time - 0.4).abs() < 1e-6);
        assert!(walk.looping);

        let chop = explorer_animation(
            ExplorerAction::Chop,
            animations,
            99.0,
            99.0,
            AXE_SWING_TURNS / 2,
        );
        assert_eq!(chop.clip, 7);
        assert!((chop.time - 0.3).abs() < 1e-6);
        assert!(!chop.looping);
    }

    #[test]
    fn held_apple_socket_composes_instance_hand_and_palm_offset() {
        let explorer = Mat4::from_scale_rotation_translation(
            Vec3::splat(1.2),
            Quat::from_rotation_y(0.7),
            Vec3::new(3.0, -0.2, 5.0),
        );
        let hand = Mat4::from_rotation_translation(
            Quat::from_rotation_x(-0.45),
            Vec3::new(0.36, 0.96, -0.04),
        );
        let socket = held_apple_socket_transform(explorer, hand);
        let expected = explorer.transform_point3(hand.transform_point3(HELD_APPLE_SOCKET_OFFSET));
        assert!(socket.transform_point3(Vec3::ZERO).distance(expected) < 1e-6);
        let (scale, _, _) = socket.to_scale_rotation_translation();
        assert!(scale.distance(Vec3::ONE) < 1e-6);

        let reached_hand = Mat4::from_translation(Vec3::new(0.0, 0.0, -0.3)) * hand;
        let reached = held_apple_socket_transform(explorer, reached_hand);
        assert!(
            reached
                .transform_point3(Vec3::ZERO)
                .distance(socket.transform_point3(Vec3::ZERO))
                > 0.25
        );

        let parent = Transform {
            position: Vec3::new(-4.0, 0.7, 2.0),
            rotation: Quat::from_rotation_y(-0.9),
            scale: Vec3::new(1.2, 0.8, 1.5),
        };
        let local = inverse_transform_point(parent, expected);
        assert!(parent.transform_point(local).distance(expected) < 1e-5);
    }

    #[test]
    fn picking_up_a_loose_apple_anchors_its_proxy_at_the_left_hand() {
        let mut game = WorldGame::new(7);
        let apple_id = game.ids.trees[0].apples[0];
        let player_position = game.player_position();
        let apple = game.world.entity_mut(apple_id).unwrap();
        apple.attachment = None;
        apple.transform.position = player_position;

        game.pickup_or_drop();

        assert_eq!(game.held_apple, Some(apple_id));
        let attachment = game
            .world
            .entity(apple_id)
            .and_then(|apple| apple.attachment)
            .unwrap();
        assert_eq!(attachment.parent, game.ids.player);
        assert_eq!(attachment.local.position, HELD_APPLE_ATTACHMENT_OFFSET);
        assert!(attachment.local.position.y.abs() < 0.1);

        let player_forward = game
            .world
            .entity(game.ids.player)
            .unwrap()
            .transform
            .rotation
            * Vec3::NEG_Z;
        game.orbit_yaw = PI;
        game.pickup_or_drop();
        let dropped = game.world.entity(apple_id).unwrap();
        assert!(dropped.attachment.is_none());
        assert!(
            dropped
                .body
                .unwrap()
                .linear_velocity
                .with_y(0.0)
                .normalize()
                .dot(player_forward.with_y(0.0).normalize())
                > 0.999
        );
    }

    #[test]
    fn third_person_camera_tracks_the_visual_foot_position() {
        let foot = Vec3::new(4.0, -0.2, -3.0);
        for yaw in [0.0, FRAC_PI_2, PI, -FRAC_PI_2] {
            let (position, focus) = player_camera_pose(foot, yaw, -0.16);
            assert_eq!(focus, foot + Vec3::Y * CAMERA_FOCUS_HEIGHT);
            let expected_distance =
                (CAMERA_ORBIT_LIFT.powi(2) + CAMERA_ORBIT_DISTANCE.powi(2)).sqrt();
            assert!((position.distance(focus) - expected_distance).abs() < 1e-5);
        }
    }

    #[test]
    fn water_nozzle_tracks_facing_and_samples_are_deterministic() {
        let player = Transform {
            position: Vec3::new(2.0, 1.0, -3.0),
            rotation: Quat::from_rotation_y(FRAC_PI_2),
            scale: Vec3::ONE,
        };
        let (origin, direction) = water_nozzle_and_direction(player);
        assert!(direction.distance(Vec3::NEG_X) < 1e-6);
        let foot_y = player.position.y - PLAYER_HEIGHT * player.scale.y;
        assert!((origin.y - (foot_y + WATER_NOZZLE_HEIGHT)).abs() < 1e-6);
        assert!(
            origin.y > player.position.y,
            "nozzle should sit at the waist"
        );

        let jet = water_jet(player);
        let first = water_jet_samples(jet);
        let second = water_jet_samples(jet);
        assert_eq!(first, second);
        assert!(first.iter().all(|sample| sample.center.is_finite()));
        assert_eq!(first[0].center, origin);
        assert!((first[WATER_SAMPLE_COUNT].distance - WATER_JET_LENGTH).abs() < 1e-6);
        assert!(first[1].center.y > origin.y, "the short stream first rises");
        assert!(
            first[WATER_SAMPLE_COUNT].center.y < origin.y,
            "the shared ballistic centerline lands below its outlet"
        );
        assert!(
            first
                .windows(2)
                .all(|pair| pair[0].distance < pair[1].distance)
        );
        assert!(first.windows(2).all(|pair| pair[0].radius < pair[1].radius));
        assert!(
            first
                .windows(2)
                .all(|pair| pair[0].retention > pair[1].retention)
        );

        let right = jet.direction.cross(Vec3::Y).normalize_or(Vec3::X);
        let up = right.cross(jet.direction).normalize_or(Vec3::Y);
        for side in [-1.0, 1.0] {
            for (index, sample) in first.iter().copied().enumerate().skip(1) {
                let point = water_curtain_point(sample, right, up, side, index, 7);
                assert!(
                    point.distance(sample.center) <= sample.radius + 1e-5,
                    "visible curtains must stay inside the gameplay cross-section"
                );
            }
        }
    }

    #[test]
    fn curved_water_tube_hits_near_and_far_but_not_side_or_back_targets() {
        let jet = water_jet(Transform::from_translation(Vec3::Y * PLAYER_HEIGHT));
        let samples = water_jet_samples(jet);
        let sphere = Some(Collider::Sphere { radius: 0.18 });
        let near = Transform::from_translation(samples[5].center);
        let far = Transform::from_translation(samples[10].center);
        let side = Transform::from_translation(samples[8].center + Vec3::X * 1.1);
        let back = Transform::from_translation(jet.origin - jet.direction * 0.15);
        assert!(water_jet_contact(jet, near, sphere).is_some());
        assert!(water_jet_contact(jet, far, sphere).is_some());
        assert!(water_jet_contact(jet, side, sphere).is_none());
        assert!(water_jet_contact(jet, back, sphere).is_none());
    }

    #[test]
    fn q_starts_a_visible_burst_even_over_empty_ground() {
        let mut game = WorldGame::new(7);
        let player_xz = Vec2::new(-18.0, 18.0);
        let player = game.world.entity_mut(game.ids.player).unwrap();
        player.transform.position =
            player_capsule_center(player_xz, OrchardEnvironment::height_at(player_xz));
        player.transform.rotation = Quat::IDENTITY;

        let mut input = Input::default();
        input.inject_key(KeyCode::KeyQ, true);
        game.frame(1.0 / 60.0, &input);
        game.tick(1.0 / 60.0, &input);

        assert_eq!(game.water_burst_turns, WATER_BURST_TURNS - 1);
        assert!(game.message.contains("open ground"));
        let hud = water_hud_state(game.water_burst_turns);
        assert!(hud.spraying);
        assert!(hud.progress > 0.0 && hud.progress < 1.0);
    }

    #[test]
    fn water_budget_is_conserved_and_near_centered_targets_receive_more() {
        let mut game = WorldGame::new(7);
        let jet = game.current_water_jet().unwrap();
        let samples = water_jet_samples(jet);
        let mut spawn_target = |position: Vec3| {
            let mut target = EntityBundle::new(Transform::from_translation(position))
                .named("water test target")
                .tagged("water-test");
            target.body = Some(Body::static_body());
            target.collider = Some(Collider::Sphere { radius: 0.18 });
            target.reactive_material = Some(ReactiveMaterial::wood());
            target.reactive_state = Some(ReactiveState::new(24.0, 0.0, 1.0));
            game.world.spawn(target)
        };
        let near = spawn_target(samples[5].center);
        let far = spawn_target(samples[10].center);
        let outside = spawn_target(samples[8].center + Vec3::X * 1.1);
        let behind = spawn_target(jet.origin - jet.direction * 0.2);

        game.begin_water_burst();
        let doses = game.queue_water_douse();
        let amount = |id| {
            doses
                .iter()
                .find(|dose| dose.target == id)
                .map(|dose| dose.amount)
                .unwrap_or(0.0)
        };
        assert!(amount(near) > amount(far));
        assert!(amount(far) > 0.0);
        assert_eq!(amount(outside), 0.0);
        assert_eq!(amount(behind), 0.0);
        assert!(
            doses.iter().map(|dose| dose.amount).sum::<f32>() <= WATER_DOUSE_BUDGET_PER_TURN + 1e-6
        );
        assert!(doses.iter().all(|dose| dose.coverage > 0.0));
        assert!(
            doses
                .iter()
                .find(|dose| dose.target == near)
                .unwrap()
                .distance
                < doses
                    .iter()
                    .find(|dose| dose.target == far)
                    .unwrap()
                    .distance
        );
        game.world.step(&game.environment);
        let moisture = |id| {
            game.world
                .entity(id)
                .unwrap()
                .reactive_state
                .unwrap()
                .moisture
        };
        assert!(moisture(near) > moisture(far));
        assert!(moisture(outside) < 1e-5);
        assert!(moisture(behind) < 1e-5);
    }

    #[test]
    fn scripted_campfire_douse_extinguishes_all_three_and_stays_out() {
        let mut game = WorldGame::new(7);
        game.prepare_campfire_douse_scenario();
        let mut input = Input::default();
        for turn in 0..390 {
            apply_campfire_douse_script(&mut input, turn);
            game.frame(1.0 / 60.0, &input);
            game.tick(1.0 / 60.0, &input);
            input.end_frame();
        }
        let receipt = game.water_receipt();
        assert!(receipt.delivered <= receipt.emitted + 1e-5);
        assert_eq!(receipt.campfire_douse.entities.len(), 3);
        assert!(
            receipt.campfire_douse.passed,
            "{:#?}",
            receipt.campfire_douse
        );
    }

    #[test]
    fn water_hud_and_reset_return_to_ready() {
        let ready = water_hud_state(0);
        assert_eq!(
            ready,
            WaterHudState {
                spraying: false,
                progress: 1.0,
            }
        );
        let halfway = water_hud_state(WATER_BURST_TURNS / 2);
        assert!(halfway.spraying);
        assert!((halfway.progress - 0.5).abs() < 1e-6);

        let mut game = WorldGame::new(7);
        game.begin_water_burst();
        game.last_target = Some(game.ids.fire);
        game.reset_world();
        assert_eq!(game.water_burst_turns, 0);
        assert_eq!(game.last_target, None);
        assert!(!water_hud_state(game.water_burst_turns).spraying);
    }
}
