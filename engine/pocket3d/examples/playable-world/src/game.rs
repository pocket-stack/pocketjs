use std::collections::{BTreeMap, BTreeSet};
use std::f32::consts::{FRAC_PI_2, PI, TAU};
use std::sync::Arc;

use anyhow::Result;
use glam::{Mat4, Quat, Vec2, Vec3};
use pocket3d::app::Game;
use pocket3d::camera::Camera;
use pocket3d::gpu::Gpu;
use pocket3d::hud::Hud;
use pocket3d::input::Input;
use pocket3d::model::ModelAsset;
use pocket3d::renderer::Renderer;
use pocket3d::scene::{DistanceFog, ModelLighting, RimLighting, Scene, Sky, Sprite, ToonLighting};
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
    body: Arc<ModelAsset>,
    head: Arc<ModelAsset>,
    boot: Arc<ModelAsset>,
    cape: Arc<ModelAsset>,
    axe_handle: Arc<ModelAsset>,
    axe_head: Arc<ModelAsset>,
    flame: Arc<ModelAsset>,
}

impl WorldAssets {
    fn load(gpu: &Gpu, renderer: &Renderer) -> Self {
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
        Self {
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
            body: upload(centered_cylinder(10), "explorer body"),
            head: upload(
                art::irregular_icosphere(1.0, 1, 0x901, 0.035),
                "explorer head",
            ),
            boot: upload(
                art::irregular_icosphere(1.0, 0, 0x902, 0.08),
                "explorer boot",
            ),
            cape: upload(art::cone(1.0, 1.0, 9), "explorer cape"),
            axe_handle: upload(centered_cylinder(8), "axe handle"),
            axe_head: upload(art::rock(1.0, 0xa8e), "axe head"),
            flame: upload(art::cone(1.0, 1.0, 9), "stylized flame"),
        }
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
    walk_phase: f32,
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
            walk_phase: 0.0,
            message: "Approach the old apple tree".into(),
            message_turns: 240,
            receipts: RuntimeReceipts::default(),
            last_target: None,
            seed,
        }
    }

    pub fn runtime_receipt(&self, scenario: impl Into<String>) -> WorldReceipt {
        let acceptance = self.acceptance();
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
            acceptance,
            landmarks: self.receipts.landmarks.clone(),
            entities,
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
        self.held_apple = None;
        self.axe_swing_turns = 0;
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
        position.y =
            OrchardEnvironment::height_at(Vec2::new(position.x, position.z)) + PLAYER_HEIGHT;
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

    fn douse_nearest(&mut self) {
        let player = self.player_position();
        let target = self.nearest_reactive(player, ACTION_REACH, true);
        let Some(target) = target else {
            self.say("No burning material in water range", 90);
            return;
        };
        self.world.queue_interaction(Interaction::Douse {
            target,
            amount: 1.0,
        });
        self.last_target = Some(target);
        self.say("Water raised moisture and removed heat", 110);
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
            let forward = Vec3::new(-self.orbit_yaw.sin(), 0.0, -self.orbit_yaw.cos());
            if let Some(apple) = self.world.entity_mut(apple_id) {
                apple.attachment = None;
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
                local: Transform::from_translation(Vec3::new(0.48, 0.55, -0.12)),
                release_impulse: Vec3::ZERO,
            });
        }
        self.held_apple = Some(apple_id);
        self.say("Picked up apple through Attachment", 95);
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
        let target = self.player_position() + Vec3::Y * 0.72;
        let rotation = Quat::from_rotation_y(self.orbit_yaw)
            * Quat::from_rotation_x(self.orbit_pitch.clamp(-0.72, 0.34));
        let offset = rotation * Vec3::new(0.0, 1.45, 7.6);
        self.camera.pos = target + offset;
        self.camera.look_at(target + Vec3::Y * 0.2);
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
            let matrix = transform_matrix(apple_transform);
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
            if detached {
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
        self.render_player(&assets);
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

    fn render_player(&mut self, assets: &WorldAssets) {
        let Some((player_transform, moving)) = self.world.entity(self.ids.player).map(|player| {
            (
                player.transform,
                player
                    .body
                    .is_some_and(|body| body.linear_velocity.length_squared() > 0.05),
            )
        }) else {
            return;
        };
        let base = transform_matrix(player_transform);
        let bob = if moving {
            self.walk_phase.sin() * 0.035
        } else {
            0.0
        };
        self.push_shadow(
            &assets.shadow,
            player_transform.position,
            0.43,
            [0.14, 0.20, 0.09, 1.0],
        );
        self.scene.models.push(art::instance(
            &assets.body,
            base * Mat4::from_scale_rotation_translation(
                Vec3::new(0.32, 0.82, 0.28),
                Quat::IDENTITY,
                Vec3::new(0.0, 0.47 + bob, 0.0),
            ),
            [0.18, 0.47, 0.55, 1.0],
        ));
        self.scene.models.push(art::instance(
            &assets.head,
            base * Mat4::from_scale_rotation_translation(
                Vec3::new(0.28, 0.31, 0.27),
                Quat::IDENTITY,
                Vec3::new(0.0, 1.08 + bob, -0.015),
            ),
            [0.92, 0.68, 0.42, 1.0],
        ));
        self.scene.models.push(art::instance(
            &assets.cape,
            base * Mat4::from_scale_rotation_translation(
                Vec3::new(0.39, 0.86, 0.28),
                Quat::from_rotation_x(PI),
                Vec3::new(0.0, 0.88 + bob, 0.18),
            ),
            [0.82, 0.60, 0.18, 1.0],
        ));
        let stride = if moving {
            self.walk_phase.sin() * 0.11
        } else {
            0.0
        };
        for side in [-1.0_f32, 1.0] {
            self.scene.models.push(art::instance(
                &assets.boot,
                base * Mat4::from_scale_rotation_translation(
                    Vec3::new(0.16, 0.12, 0.25),
                    Quat::IDENTITY,
                    Vec3::new(side * 0.17, 0.08, stride * side - 0.04),
                ),
                [0.22, 0.14, 0.075, 1.0],
            ));
        }
        let swing_progress = if self.axe_swing_turns > 0 {
            1.0 - self.axe_swing_turns as f32 / AXE_SWING_TURNS as f32
        } else {
            0.0
        };
        let swing = if self.axe_swing_turns > 0 {
            (swing_progress * PI).sin() * -1.75 + 0.55
        } else {
            0.52
        };
        let axe_root = base
            * Mat4::from_scale_rotation_translation(
                Vec3::ONE,
                Quat::from_rotation_z(swing) * Quat::from_rotation_x(-0.22),
                Vec3::new(0.43, 0.72 + bob, -0.04),
            );
        self.scene.models.push(art::instance(
            &assets.axe_handle,
            axe_root * Mat4::from_scale(Vec3::new(0.052, 0.78, 0.052)),
            [0.47, 0.25, 0.10, 1.0],
        ));
        self.scene.models.push(art::instance(
            &assets.axe_head,
            axe_root
                * Mat4::from_scale_rotation_translation(
                    Vec3::new(0.25, 0.18, 0.085),
                    Quat::from_rotation_z(0.22),
                    Vec3::new(0.12, 0.37, 0.0),
                ),
            [0.31, 0.38, 0.39, 1.0],
        ));
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
        self.assets = Some(WorldAssets::load(gpu, renderer));
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
        if std::mem::take(&mut self.pending.douse) {
            self.douse_nearest();
        }
        let report = self.world.step(&self.environment);
        self.observe_report(&report);
        self.axe_swing_turns = self.axe_swing_turns.saturating_sub(1);
        self.message_turns = self.message_turns.saturating_sub(1);
    }

    fn compose(&mut self, _alpha: f32, time: f32, size: (u32, u32)) -> (&Scene, &Camera, &Hud) {
        self.rebuild_scene(time, size);
        (&self.scene, &self.camera, &self.hud)
    }
}

fn build_world(seed: u64, environment: &OrchardEnvironment) -> (World, WorldIds) {
    let mut world = World::with_seed(seed);
    let player_xz = Vec2::new(0.0, 7.0);
    let mut player = EntityBundle::new(Transform::from_translation(Vec3::new(
        player_xz.x,
        OrchardEnvironment::height_at(player_xz) + PLAYER_HEIGHT,
        player_xz.y,
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

pub fn apply_orchard_script(input: &mut Input, turn: u64) {
    input.inject_key(KeyCode::KeyW, turn < 101);
    for action_turn in [108_u64, 138, 168] {
        input.inject_key(KeyCode::Space, turn == action_turn);
        if turn == action_turn + 1 {
            input.inject_key(KeyCode::Space, false);
        }
    }
    input.inject_key(KeyCode::KeyF, turn == 228);
    if turn == 229 {
        input.inject_key(KeyCode::KeyF, false);
    }
}

#[cfg(test)]
mod tests {
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
}
