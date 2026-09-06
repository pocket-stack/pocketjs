use std::collections::{BTreeMap, BTreeSet};

use glam::Vec3;
use serde::{Deserialize, Serialize};

use crate::EntityId;

/// A renderer-independent hidden value owned by a world-law pack.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum HiddenValue {
    Flag(bool),
    Scalar(f32),
    Symbol(String),
    Entity(EntityId),
}

impl HiddenValue {
    fn sort_key(&self) -> (u8, String) {
        match self {
            Self::Flag(value) => (0, (*value as u8).to_string()),
            Self::Scalar(value) => (1, format!("{:08x}", value.to_bits())),
            Self::Symbol(value) => (2, value.clone()),
            Self::Entity(value) => (3, format!("{:016x}", value.0)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct HiddenStateKey {
    pub entity: EntityId,
    pub name: String,
}

impl HiddenStateKey {
    pub fn new(entity: EntityId, name: impl Into<String>) -> Self {
        Self {
            entity,
            name: name.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HiddenState {
    pub key: HiddenStateKey,
    pub value: HiddenValue,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct RelationKey {
    pub kind: String,
    pub from: EntityId,
    pub to: EntityId,
}

impl RelationKey {
    pub fn new(kind: impl Into<String>, from: EntityId, to: EntityId) -> Self {
        Self {
            kind: kind.into(),
            from,
            to,
        }
    }
}

/// A persistent, non-spatial connection between two entities.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HiddenRelation {
    pub key: RelationKey,
    pub strength: f32,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct FieldKey {
    pub channel: String,
    pub source: EntityId,
}

impl FieldKey {
    pub fn new(channel: impl Into<String>, source: EntityId) -> Self {
        Self {
            channel: channel.into(),
            source,
        }
    }
}

/// A spherical projection from hidden state into visible space.
///
/// `intensity` is an application-defined finite budget. Opposing fields on
/// the same channel cancel only where both volumes contain the sampled point.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpatialField {
    pub key: FieldKey,
    pub center: Vec3,
    pub radius: f32,
    pub intensity: f32,
    pub polarity: f32,
}

impl SpatialField {
    pub fn new(
        channel: impl Into<String>,
        source: EntityId,
        center: Vec3,
        radius: f32,
        intensity: f32,
        polarity: f32,
    ) -> Self {
        Self {
            key: FieldKey::new(channel, source),
            center,
            radius: finite_non_negative(radius),
            intensity: finite_non_negative(intensity),
            polarity: finite_or_zero(polarity).clamp(-1.0, 1.0),
        }
    }

    pub fn contains(&self, point: Vec3) -> bool {
        point.is_finite() && point.distance_squared(self.center) <= self.radius * self.radius
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedField {
    pub key: FieldKey,
    pub base_intensity: f32,
    pub cancelled_intensity: f32,
    pub effective_intensity: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LawProjection {
    pub law: String,
    pub source: EntityId,
    pub target: Option<EntityId>,
    pub kind: String,
    pub magnitude: f32,
    pub position: Vec3,
    pub direction: Vec3,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LawEvent {
    StateChanged {
        entity: EntityId,
        name: String,
        value: HiddenValue,
    },
    RelationBound {
        relation: HiddenRelation,
    },
    RelationUnbound {
        key: RelationKey,
    },
    FieldChanged {
        field: SpatialField,
    },
    FieldRemoved {
        key: FieldKey,
    },
    Transition {
        law: String,
        entity: EntityId,
        from: String,
        to: String,
    },
    Projection {
        law: String,
        source: EntityId,
        target: Option<EntityId>,
        kind: String,
        magnitude: f32,
        position: Vec3,
        direction: Vec3,
    },
    Materialized {
        law: String,
        source: EntityId,
        entity: EntityId,
        form: String,
        progress: f32,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LawCommand {
    SetState {
        key: HiddenStateKey,
        value: HiddenValue,
    },
    Bind(HiddenRelation),
    Unbind(RelationKey),
    EmitField(SpatialField),
    RemoveField(FieldKey),
    Transition {
        law: String,
        entity: EntityId,
        from: String,
        to: String,
    },
    Project(LawProjection),
    Materialize {
        law: String,
        source: EntityId,
        entity: EntityId,
        form: String,
        progress: f32,
    },
}

impl LawCommand {
    fn sort_key(&self) -> (u8, u64, u64, String, String) {
        match self {
            Self::SetState { key, value } => (
                0,
                key.entity.0,
                0,
                key.name.clone(),
                format!("{:?}", value.sort_key()),
            ),
            Self::Bind(relation) => (
                1,
                relation.key.from.0,
                relation.key.to.0,
                relation.key.kind.clone(),
                format!("{:08x}", relation.strength.to_bits()),
            ),
            Self::Unbind(key) => (2, key.from.0, key.to.0, key.kind.clone(), String::new()),
            Self::EmitField(field) => (
                3,
                field.key.source.0,
                0,
                field.key.channel.clone(),
                format!(
                    "{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}",
                    field.center.x.to_bits(),
                    field.center.y.to_bits(),
                    field.center.z.to_bits(),
                    field.radius.to_bits(),
                    field.intensity.to_bits(),
                    field.polarity.to_bits()
                ),
            ),
            Self::RemoveField(key) => (4, key.source.0, 0, key.channel.clone(), String::new()),
            Self::Transition {
                law,
                entity,
                from,
                to,
            } => (5, entity.0, 0, law.clone(), format!("{from}\0{to}")),
            Self::Project(projection) => (
                6,
                projection.source.0,
                projection.target.map_or(0, |target| target.0),
                projection.law.clone(),
                format!(
                    "{}\0{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}{:08x}",
                    projection.kind,
                    projection.magnitude.to_bits(),
                    projection.position.x.to_bits(),
                    projection.position.y.to_bits(),
                    projection.position.z.to_bits(),
                    projection.direction.x.to_bits(),
                    projection.direction.y.to_bits(),
                    projection.direction.z.to_bits()
                ),
            ),
            Self::Materialize {
                law,
                source,
                entity,
                form,
                progress,
            } => (
                7,
                source.0,
                entity.0,
                law.clone(),
                format!("{}\0{:08x}", form, progress.to_bits()),
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LawStepReport {
    pub tick: u64,
    pub events: Vec<LawEvent>,
    pub state_hash: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WorldLawSnapshot {
    pub tick: u64,
    pub states: Vec<HiddenState>,
    pub relations: Vec<HiddenRelation>,
    pub fields: Vec<SpatialField>,
    pub queued_commands: Vec<LawCommand>,
}

/// Deterministic hidden-world state plus deferred law commands.
///
/// The runtime deliberately does not know character names, recipes, or
/// scenarios. Law packs define those constitutions and translate projections
/// into the visible simulation.
#[derive(Default)]
pub struct WorldLawRuntime {
    tick: u64,
    states: BTreeMap<HiddenStateKey, HiddenValue>,
    relations: BTreeMap<RelationKey, HiddenRelation>,
    fields: BTreeMap<FieldKey, SpatialField>,
    queued: Vec<LawCommand>,
}

impl WorldLawRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    pub fn queue(&mut self, command: LawCommand) {
        self.queued.push(command);
    }

    pub fn queue_state(&mut self, entity: EntityId, name: impl Into<String>, value: HiddenValue) {
        self.queue(LawCommand::SetState {
            key: HiddenStateKey::new(entity, name),
            value,
        });
    }

    pub fn queue_relation(
        &mut self,
        kind: impl Into<String>,
        from: EntityId,
        to: EntityId,
        strength: f32,
    ) {
        self.queue(LawCommand::Bind(HiddenRelation {
            key: RelationKey::new(kind, from, to),
            strength: finite_non_negative(strength),
        }));
    }

    pub fn queue_field(&mut self, field: SpatialField) {
        self.queue(LawCommand::EmitField(field));
    }

    pub fn queue_transition(
        &mut self,
        law: impl Into<String>,
        entity: EntityId,
        from: impl Into<String>,
        to: impl Into<String>,
    ) {
        self.queue(LawCommand::Transition {
            law: law.into(),
            entity,
            from: from.into(),
            to: to.into(),
        });
    }

    pub fn queue_projection(&mut self, mut projection: LawProjection) {
        projection.magnitude = finite_non_negative(projection.magnitude);
        projection.position = finite_vec_or_zero(projection.position);
        projection.direction = projection.direction.normalize_or_zero();
        self.queue(LawCommand::Project(projection));
    }

    pub fn queue_materialization(
        &mut self,
        law: impl Into<String>,
        source: EntityId,
        entity: EntityId,
        form: impl Into<String>,
        progress: f32,
    ) {
        self.queue(LawCommand::Materialize {
            law: law.into(),
            source,
            entity,
            form: form.into(),
            progress: finite_non_negative(progress).clamp(0.0, 1.0),
        });
    }

    pub fn state(&self, entity: EntityId, name: &str) -> Option<&HiddenValue> {
        self.states.get(&HiddenStateKey::new(entity, name))
    }

    pub fn flag(&self, entity: EntityId, name: &str) -> bool {
        matches!(self.state(entity, name), Some(HiddenValue::Flag(true)))
    }

    pub fn scalar(&self, entity: EntityId, name: &str) -> Option<f32> {
        match self.state(entity, name) {
            Some(HiddenValue::Scalar(value)) => Some(*value),
            _ => None,
        }
    }

    pub fn symbol(&self, entity: EntityId, name: &str) -> Option<&str> {
        match self.state(entity, name) {
            Some(HiddenValue::Symbol(value)) => Some(value),
            _ => None,
        }
    }

    pub fn relation(&self, kind: &str, from: EntityId, to: EntityId) -> Option<&HiddenRelation> {
        self.relations.get(&RelationKey::new(kind, from, to))
    }

    pub fn field(&self, channel: &str, source: EntityId) -> Option<&SpatialField> {
        self.fields.get(&FieldKey::new(channel, source))
    }

    pub fn states(&self) -> impl ExactSizeIterator<Item = HiddenState> + '_ {
        self.states.iter().map(|(key, value)| HiddenState {
            key: key.clone(),
            value: value.clone(),
        })
    }

    pub fn relations(&self) -> impl ExactSizeIterator<Item = &HiddenRelation> {
        self.relations.values()
    }

    pub fn fields(&self) -> impl ExactSizeIterator<Item = &SpatialField> {
        self.fields.values()
    }

    pub fn resolved_field_at(
        &self,
        channel: &str,
        source: EntityId,
        point: Vec3,
    ) -> Option<ResolvedField> {
        let field = self.field(channel, source)?;
        if !field.contains(point) {
            return None;
        }
        let cancelled_intensity = self
            .fields
            .values()
            .filter(|other| {
                other.key.channel == field.key.channel
                    && other.key.source != field.key.source
                    && other.polarity * field.polarity < 0.0
                    && other.contains(point)
            })
            .map(|other| other.intensity * other.polarity.abs())
            .sum::<f32>()
            .min(field.intensity);
        Some(ResolvedField {
            key: field.key.clone(),
            base_intensity: field.intensity,
            cancelled_intensity,
            effective_intensity: (field.intensity - cancelled_intensity).max(0.0),
        })
    }

    /// Apply all queued commands at one deterministic transaction boundary.
    /// At most one transition may be published for an entity in a turn; if
    /// packs submit competing transitions, the lexicographically first law
    /// wins independently of submission order.
    pub fn step(&mut self) -> LawStepReport {
        let mut commands = std::mem::take(&mut self.queued);
        commands.sort_by_key(LawCommand::sort_key);
        let mut events = Vec::new();
        let mut transitioned = BTreeSet::new();
        for command in commands {
            match command {
                LawCommand::SetState { key, value } => {
                    if self.states.get(&key) != Some(&value) {
                        self.states.insert(key.clone(), value.clone());
                        events.push(LawEvent::StateChanged {
                            entity: key.entity,
                            name: key.name,
                            value,
                        });
                    }
                }
                LawCommand::Bind(mut relation) => {
                    relation.strength = finite_non_negative(relation.strength);
                    if self.relations.get(&relation.key) != Some(&relation) {
                        self.relations
                            .insert(relation.key.clone(), relation.clone());
                        events.push(LawEvent::RelationBound { relation });
                    }
                }
                LawCommand::Unbind(key) => {
                    if self.relations.remove(&key).is_some() {
                        events.push(LawEvent::RelationUnbound { key });
                    }
                }
                LawCommand::EmitField(mut field) => {
                    field.radius = finite_non_negative(field.radius);
                    field.intensity = finite_non_negative(field.intensity);
                    field.polarity = finite_or_zero(field.polarity).clamp(-1.0, 1.0);
                    field.center = finite_vec_or_zero(field.center);
                    if self.fields.get(&field.key) != Some(&field) {
                        self.fields.insert(field.key.clone(), field.clone());
                        events.push(LawEvent::FieldChanged { field });
                    }
                }
                LawCommand::RemoveField(key) => {
                    if self.fields.remove(&key).is_some() {
                        events.push(LawEvent::FieldRemoved { key });
                    }
                }
                LawCommand::Transition {
                    law,
                    entity,
                    from,
                    to,
                } => {
                    if transitioned.insert(entity) {
                        events.push(LawEvent::Transition {
                            law,
                            entity,
                            from,
                            to,
                        });
                    }
                }
                LawCommand::Project(projection) => events.push(LawEvent::Projection {
                    law: projection.law,
                    source: projection.source,
                    target: projection.target,
                    kind: projection.kind,
                    magnitude: finite_non_negative(projection.magnitude),
                    position: finite_vec_or_zero(projection.position),
                    direction: projection.direction.normalize_or_zero(),
                }),
                LawCommand::Materialize {
                    law,
                    source,
                    entity,
                    form,
                    progress,
                } => events.push(LawEvent::Materialized {
                    law,
                    source,
                    entity,
                    form,
                    progress: finite_non_negative(progress).clamp(0.0, 1.0),
                }),
            }
        }
        self.tick = self.tick.wrapping_add(1);
        LawStepReport {
            tick: self.tick,
            events,
            state_hash: self.state_hash(),
        }
    }

    pub fn snapshot(&self) -> WorldLawSnapshot {
        WorldLawSnapshot {
            tick: self.tick,
            states: self.states().collect(),
            relations: self.relations.values().cloned().collect(),
            fields: self.fields.values().cloned().collect(),
            queued_commands: self.queued.clone(),
        }
    }

    pub fn restore(&mut self, snapshot: WorldLawSnapshot) {
        self.tick = snapshot.tick;
        self.states = snapshot
            .states
            .into_iter()
            .map(|state| (state.key, state.value))
            .collect();
        self.relations = snapshot
            .relations
            .into_iter()
            .map(|relation| (relation.key.clone(), relation))
            .collect();
        self.fields = snapshot
            .fields
            .into_iter()
            .map(|field| (field.key.clone(), field))
            .collect();
        self.queued = snapshot.queued_commands;
    }

    pub fn state_hash(&self) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325_u64;
        hash_u64(&mut hash, self.tick);
        for (key, value) in &self.states {
            hash_u64(&mut hash, key.entity.0);
            hash_bytes(&mut hash, key.name.as_bytes());
            hash_hidden_value(&mut hash, value);
        }
        for relation in self.relations.values() {
            hash_bytes(&mut hash, relation.key.kind.as_bytes());
            hash_u64(&mut hash, relation.key.from.0);
            hash_u64(&mut hash, relation.key.to.0);
            hash_u64(&mut hash, relation.strength.to_bits() as u64);
        }
        for field in self.fields.values() {
            hash_bytes(&mut hash, field.key.channel.as_bytes());
            hash_u64(&mut hash, field.key.source.0);
            for value in [field.center.x, field.center.y, field.center.z] {
                hash_u64(&mut hash, value.to_bits() as u64);
            }
            hash_u64(&mut hash, field.radius.to_bits() as u64);
            hash_u64(&mut hash, field.intensity.to_bits() as u64);
            hash_u64(&mut hash, field.polarity.to_bits() as u64);
        }
        for command in &self.queued {
            hash_bytes(&mut hash, format!("{:?}", command.sort_key()).as_bytes());
        }
        hash
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FieldBodyProbe {
    pub position: Vec3,
    pub velocity: Vec3,
    pub mass: f32,
    /// Conservative radial extent of the visible collider.
    pub bound_radius: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarrierProjection {
    pub impulse: Vec3,
    pub contact_point: Vec3,
    pub incoming_energy: f32,
    pub absorbed_energy: f32,
    pub blocked: bool,
}

/// Project a finite spherical field budget into an approaching body's normal
/// motion for the next fixed turn.
///
/// Invariant: the projection never increases kinetic energy, and it removes
/// no more than either the incoming normal kinetic energy or the supplied
/// field budget. Tangential motion is unchanged.
pub fn spherical_barrier_projection(
    center: Vec3,
    radius: f32,
    field_budget: f32,
    body: FieldBodyProbe,
    fixed_dt: f32,
) -> Option<BarrierProjection> {
    if !center.is_finite()
        || !body.position.is_finite()
        || !body.velocity.is_finite()
        || !radius.is_finite()
        || !field_budget.is_finite()
        || !body.mass.is_finite()
        || !body.bound_radius.is_finite()
        || !fixed_dt.is_finite()
    {
        return None;
    }
    let radius = radius.max(0.0);
    let bound_radius = body.bound_radius.max(0.0);
    let mass = body.mass.max(0.001);
    let fixed_dt = fixed_dt.max(0.0);
    let offset = body.position - center;
    let distance = offset.length();
    let normal = offset.normalize_or(Vec3::X);
    let inward_speed = -body.velocity.dot(normal);
    if inward_speed <= 0.0 {
        return None;
    }
    let boundary = radius + bound_radius;
    let predicted_distance = distance - inward_speed * fixed_dt;
    if distance < boundary || predicted_distance > boundary {
        return None;
    }
    let incoming_energy = 0.5 * mass * inward_speed * inward_speed;
    let absorbed_energy = finite_non_negative(field_budget).min(incoming_energy);
    if absorbed_energy <= 0.0 {
        return None;
    }
    let remaining_energy = (incoming_energy - absorbed_energy).max(0.0);
    let remaining_speed = (2.0 * remaining_energy / mass).sqrt();
    let impulse = normal * mass * (inward_speed - remaining_speed);
    Some(BarrierProjection {
        impulse,
        contact_point: center + normal * radius,
        incoming_energy,
        absorbed_energy,
        blocked: remaining_energy <= f32::EPSILON,
    })
}

fn finite_non_negative(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn finite_or_zero(value: f32) -> f32 {
    if value.is_finite() { value } else { 0.0 }
}

fn finite_vec_or_zero(value: Vec3) -> Vec3 {
    if value.is_finite() { value } else { Vec3::ZERO }
}

fn hash_u64(hash: &mut u64, value: u64) {
    for byte in value.to_le_bytes() {
        *hash ^= byte as u64;
        *hash = hash.wrapping_mul(0x100_0000_01b3);
    }
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    hash_u64(hash, bytes.len() as u64);
    for byte in bytes {
        *hash ^= *byte as u64;
        *hash = hash.wrapping_mul(0x100_0000_01b3);
    }
}

fn hash_hidden_value(hash: &mut u64, value: &HiddenValue) {
    match value {
        HiddenValue::Flag(value) => {
            hash_u64(hash, 0);
            hash_u64(hash, *value as u64);
        }
        HiddenValue::Scalar(value) => {
            hash_u64(hash, 1);
            hash_u64(hash, value.to_bits() as u64);
        }
        HiddenValue::Symbol(value) => {
            hash_u64(hash, 2);
            hash_bytes(hash, value.as_bytes());
        }
        HiddenValue::Entity(value) => {
            hash_u64(hash, 3);
            hash_u64(hash, value.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_with_opposing_fields(order_reversed: bool) -> WorldLawRuntime {
        let mut runtime = WorldLawRuntime::new();
        let a = SpatialField::new("identity", EntityId(2), Vec3::ZERO, 4.0, 90.0, 1.0);
        let b = SpatialField::new(
            "identity",
            EntityId(3),
            Vec3::new(3.0, 0.0, 0.0),
            4.0,
            35.0,
            -1.0,
        );
        if order_reversed {
            runtime.queue_field(b);
            runtime.queue_field(a);
        } else {
            runtime.queue_field(a);
            runtime.queue_field(b);
        }
        runtime.step();
        runtime
    }

    #[test]
    fn hidden_state_relations_fields_and_hash_ignore_submission_order() {
        let mut a = runtime_with_opposing_fields(false);
        let mut b = runtime_with_opposing_fields(true);
        for runtime in [&mut a, &mut b] {
            runtime.queue_state(EntityId(7), "soul.identity", HiddenValue::Scalar(0.82));
            runtime.queue_relation("synchronized_with", EntityId(8), EntityId(7), 0.76);
            runtime.step();
        }
        assert_eq!(a.snapshot(), b.snapshot());
        assert_eq!(a.state_hash(), b.state_hash());
        assert_eq!(a.scalar(EntityId(7), "soul.identity"), Some(0.82));
        assert!(
            a.relation("synchronized_with", EntityId(8), EntityId(7))
                .is_some()
        );
    }

    #[test]
    fn opposing_fields_cancel_only_in_their_shared_volume() {
        let runtime = runtime_with_opposing_fields(false);
        let clear = runtime
            .resolved_field_at("identity", EntityId(2), Vec3::new(-3.0, 0.0, 0.0))
            .unwrap();
        let overlap = runtime
            .resolved_field_at("identity", EntityId(2), Vec3::new(1.0, 0.0, 0.0))
            .unwrap();
        assert_eq!(clear.effective_intensity, 90.0);
        assert_eq!(overlap.cancelled_intensity, 35.0);
        assert_eq!(overlap.effective_intensity, 55.0);
    }

    #[test]
    fn transition_commit_allows_only_one_transition_per_entity() {
        let mut runtime = WorldLawRuntime::new();
        runtime.queue_transition("z-law", EntityId(4), "human", "form-z");
        runtime.queue_transition("a-law", EntityId(4), "human", "form-a");
        let report = runtime.step();
        let transitions: Vec<_> = report
            .events
            .iter()
            .filter_map(|event| match event {
                LawEvent::Transition { law, .. } => Some(law.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(transitions, ["a-law"]);
    }

    #[test]
    fn barrier_projection_conserves_the_energy_bound_for_two_body_configurations() {
        for probe in [
            FieldBodyProbe {
                position: Vec3::new(5.1, 0.0, 0.0),
                velocity: Vec3::new(-12.0, 0.0, 3.0),
                mass: 0.8,
                bound_radius: 0.20,
            },
            FieldBodyProbe {
                position: Vec3::new(5.7, 0.0, 0.0),
                velocity: Vec3::new(-9.0, 0.0, -2.0),
                mass: 6.5,
                // Conservative radial extent for a rotated capsule.
                bound_radius: 0.80,
            },
        ] {
            let result = spherical_barrier_projection(Vec3::ZERO, 4.8, 42.0, probe, 1.0 / 60.0)
                .expect("body should cross the projected boundary this turn");
            let before = 0.5 * probe.mass * probe.velocity.length_squared();
            let after_velocity = probe.velocity + result.impulse / probe.mass;
            let after = 0.5 * probe.mass * after_velocity.length_squared();
            assert!(after <= before + 1e-4);
            assert!(result.absorbed_energy <= result.incoming_energy + 1e-4);
            assert!(result.absorbed_energy <= 42.0 + 1e-4);
            assert!((before - after - result.absorbed_energy).abs() < 1e-3);
        }
    }

    #[test]
    fn snapshot_round_trip_preserves_queued_transaction() {
        let mut runtime = runtime_with_opposing_fields(false);
        runtime.queue_state(EntityId(5), "intent", HiddenValue::Flag(true));
        let snapshot = runtime.snapshot();
        let mut restored = WorldLawRuntime::new();
        restored.restore(snapshot.clone());
        assert_eq!(restored.snapshot(), snapshot);
        assert_eq!(restored.step(), runtime.step());
    }
}
