use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use glam::{Quat, Vec3};

use crate::rng::WorldRng;
use crate::types::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnError {
    ReservedId,
    DuplicateId(EntityId),
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReservedId => write!(f, "entity id 0 is reserved"),
            Self::DuplicateId(id) => write!(f, "entity id {} already exists", id.0),
        }
    }
}

impl Error for SpawnError {}

/// Authoritative state advanced at one fixed rate.
pub struct World {
    config: WorldConfig,
    seed: u64,
    rng: WorldRng,
    tick: u64,
    next_id: u64,
    entities: BTreeMap<EntityId, Entity>,
    interactions: Vec<Interaction>,
}

impl World {
    pub fn new(config: WorldConfig) -> Self {
        Self::with_config_seed(config, 1)
    }

    pub fn with_seed(seed: u64) -> Self {
        Self::with_config_seed(WorldConfig::default(), seed)
    }

    pub fn with_config_seed(config: WorldConfig, seed: u64) -> Self {
        assert!(config.fixed_dt.is_finite() && config.fixed_dt > 0.0);
        Self {
            config,
            seed,
            rng: WorldRng::new(seed),
            tick: 0,
            next_id: EntityId::FIRST.0,
            entities: BTreeMap::new(),
            interactions: Vec::new(),
        }
    }

    pub fn config(&self) -> &WorldConfig {
        &self.config
    }

    pub fn config_mut(&mut self) -> &mut WorldConfig {
        &mut self.config
    }

    pub fn seed(&self) -> u64 {
        self.seed
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    pub fn rng_mut(&mut self) -> &mut WorldRng {
        &mut self.rng
    }

    pub fn spawn(&mut self, bundle: EntityBundle) -> EntityId {
        while self.next_id == 0 || self.entities.contains_key(&EntityId(self.next_id)) {
            self.next_id = self.next_id.wrapping_add(1);
        }
        let id = EntityId(self.next_id);
        self.next_id = self.next_id.wrapping_add(1);
        self.entities.insert(id, entity_from_bundle(id, bundle));
        id
    }

    pub fn spawn_with_id(
        &mut self,
        id: EntityId,
        bundle: EntityBundle,
    ) -> Result<EntityId, SpawnError> {
        if id.0 == 0 {
            return Err(SpawnError::ReservedId);
        }
        if self.entities.contains_key(&id) {
            return Err(SpawnError::DuplicateId(id));
        }
        self.next_id = self.next_id.max(id.0.saturating_add(1));
        self.entities.insert(id, entity_from_bundle(id, bundle));
        Ok(id)
    }

    pub fn remove(&mut self, id: EntityId) -> Option<Entity> {
        let removed = self.entities.remove(&id);
        if removed.is_some() {
            for entity in self.entities.values_mut() {
                if entity
                    .attachment
                    .is_some_and(|attachment| attachment.parent == id)
                {
                    entity.attachment = None;
                    if let Some(body) = entity.body.as_mut() {
                        body.wake();
                    }
                }
            }
        }
        removed
    }

    pub fn entity(&self, id: EntityId) -> Option<&Entity> {
        self.entities.get(&id)
    }

    pub fn entity_mut(&mut self, id: EntityId) -> Option<&mut Entity> {
        self.entities.get_mut(&id)
    }

    pub fn entities(&self) -> impl ExactSizeIterator<Item = (&EntityId, &Entity)> {
        self.entities.iter()
    }

    pub fn ids_with_tag<'a>(&'a self, tag: &'a str) -> impl Iterator<Item = EntityId> + 'a {
        self.entities
            .iter()
            .filter(move |(_, entity)| entity.has_tag(tag))
            .map(|(&id, _)| id)
    }

    pub fn clear(&mut self) {
        self.entities.clear();
        self.interactions.clear();
        self.tick = 0;
        self.next_id = EntityId::FIRST.0;
        self.rng = WorldRng::new(self.seed);
    }

    pub fn reset(&mut self, seed: u64) {
        self.seed = seed;
        self.clear();
    }

    pub fn queue_interaction(&mut self, interaction: Interaction) {
        self.interactions.push(interaction);
    }

    /// Alias that emphasizes interactions become authoritative on the next
    /// fixed turn, never in an input or collision callback.
    pub fn apply_interaction(&mut self, interaction: Interaction) {
        self.queue_interaction(interaction);
    }

    pub fn snapshot(&self) -> WorldSnapshot {
        WorldSnapshot {
            config: self.config,
            seed: self.seed,
            rng_state: self.rng.state(),
            tick: self.tick,
            next_id: self.next_id,
            entities: self.entities.clone(),
            queued_interactions: self.interactions.clone(),
        }
    }

    pub fn restore(&mut self, snapshot: WorldSnapshot) {
        self.config = snapshot.config;
        self.seed = snapshot.seed;
        self.rng = WorldRng::new(snapshot.rng_state);
        self.tick = snapshot.tick;
        self.next_id = snapshot.next_id.max(EntityId::FIRST.0);
        self.entities = snapshot.entities;
        // The map key is authoritative. Serialized snapshots are public data,
        // so do not let a stale or hand-edited `Entity::id` disagree with it.
        for (&id, entity) in &mut self.entities {
            entity.id = id;
        }
        self.interactions = snapshot.queued_interactions;
    }

    pub fn step<E: Environment + ?Sized>(&mut self, environment: &E) -> StepReport {
        let mut events = Vec::new();
        let mut fracture_causes: BTreeMap<EntityId, (Vec3, f32)> = BTreeMap::new();

        self.consume_interactions(&mut events, &mut fracture_causes);
        self.sync_attachments();
        self.step_reactions(environment, &mut events);
        self.integrate_bodies();
        let contacts = self.solve_ground(environment);
        let mut pair_contacts = self.solve_pairs();
        let mut contacts = contacts;
        contacts.append(&mut pair_contacts);
        self.apply_contact_damage(&contacts, &mut fracture_causes);
        events.extend(contacts.into_iter().map(WorldEvent::Contact));
        // Physics may have moved a parent. Keep attached presentation and
        // reaction transforms current before any fracture releases children.
        self.sync_attachments();
        self.commit_fractures(fracture_causes, &mut events);

        self.tick = self.tick.wrapping_add(1);
        let state_hash = self.state_hash();
        StepReport {
            tick: self.tick,
            events,
            state_hash,
        }
    }

    fn consume_interactions(
        &mut self,
        events: &mut Vec<WorldEvent>,
        fractures: &mut BTreeMap<EntityId, (Vec3, f32)>,
    ) {
        for interaction in std::mem::take(&mut self.interactions) {
            match interaction {
                Interaction::Cut {
                    target,
                    direction,
                    energy,
                } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    let energy = finite_non_negative(energy);
                    if let Some(structure) = entity.structure.as_mut()
                        && !structure.fractured
                    {
                        structure.integrity = (structure.integrity
                            - energy / structure.cut_resistance.max(0.001))
                        .max(0.0);
                        if structure.integrity <= 0.0 {
                            fractures
                                .entry(target)
                                .or_insert((safe_direction(direction), energy));
                        }
                    }
                }
                Interaction::Impulse {
                    target,
                    impulse,
                    point,
                } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    if !impulse.is_finite() || !point.is_finite() {
                        continue;
                    }
                    if let Some(body) = entity.body.as_mut()
                        && body.mode == BodyMode::Dynamic
                        && entity.attachment.is_none()
                    {
                        let inv_mass = body.mass.max(0.001).recip();
                        body.linear_velocity += impulse * inv_mass;
                        let lever = point - entity.transform.position;
                        body.angular_velocity += lever.cross(impulse) * inv_mass * 0.35;
                        body.wake();
                    }
                }
                Interaction::Ignite { target, energy } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    if let (Some(material), Some(state)) =
                        (entity.reactive_material, entity.reactive_state.as_mut())
                    {
                        state.temperature_c +=
                            finite_non_negative(energy) / material.heat_capacity.max(0.05);
                    }
                }
                Interaction::Douse { target, amount } => {
                    let Some(entity) = self.entities.get_mut(&target) else {
                        continue;
                    };
                    let Some(state) = entity.reactive_state.as_mut() else {
                        continue;
                    };
                    let amount = finite_non_negative(amount);
                    if amount <= 0.0 {
                        continue;
                    }
                    state.moisture = (state.moisture + amount).clamp(0.0, 1.0);
                    state.temperature_c =
                        (state.temperature_c - amount * self.config.douse_cooling_c).max(-50.0);
                    let below_ignition = entity.reactive_material.is_some_and(|material| {
                        state.temperature_c < material.ignition_temperature_c
                    });
                    if state.burning && (state.moisture >= 0.82 || below_ignition) {
                        state.burning = false;
                        events.push(WorldEvent::Extinguished { entity: target });
                    }
                }
            }
        }
    }

    fn sync_attachments(&mut self) {
        let attached: Vec<_> = self
            .entities
            .iter()
            .filter_map(|(&id, entity)| entity.attachment.map(|attachment| (id, attachment)))
            .collect();
        for (id, attachment) in attached {
            let Some(parent) = self.entities.get(&attachment.parent) else {
                if let Some(entity) = self.entities.get_mut(&id) {
                    entity.attachment = None;
                    if let Some(body) = entity.body.as_mut() {
                        body.wake();
                    }
                }
                continue;
            };
            let transform = parent.transform.compose(attachment.local);
            let parent_body = parent.body;
            let parent_position = parent.transform.position;
            if let Some(entity) = self.entities.get_mut(&id) {
                entity.transform = transform;
                if let Some(body) = entity.body.as_mut() {
                    if let Some(parent_body) = parent_body {
                        let arm = transform.position - parent_position;
                        body.linear_velocity =
                            parent_body.linear_velocity + parent_body.angular_velocity.cross(arm);
                        body.angular_velocity = parent_body.angular_velocity;
                    } else {
                        body.linear_velocity = Vec3::ZERO;
                        body.angular_velocity = Vec3::ZERO;
                    }
                    body.sleeping = true;
                    body.quiet_turns = 0;
                }
            }
        }
    }

    fn step_reactions<E: Environment + ?Sized>(
        &mut self,
        environment: &E,
        events: &mut Vec<WorldEvent>,
    ) {
        let dt = self.config.fixed_dt;
        let ids: Vec<_> = self
            .entities
            .iter()
            .filter(|(_, entity)| {
                entity.reactive_material.is_some() && entity.reactive_state.is_some()
            })
            .map(|(&id, _)| id)
            .collect();

        // Ambient exchange and evaporation are local, so apply them first in
        // stable ID order.
        for &id in &ids {
            let position = self.entities[&id].transform.position;
            let sample = environment.sample(position);
            let entity = self.entities.get_mut(&id).expect("id came from map");
            let material = entity.reactive_material.expect("filtered");
            let state = entity.reactive_state.as_mut().expect("filtered");
            let exchange = self.config.ambient_exchange * dt / material.heat_capacity.max(0.05);
            state.temperature_c +=
                (sample.ambient_temperature_c - state.temperature_c) * exchange.clamp(0.0, 1.0);
            if state.temperature_c > 55.0 {
                let heat = ((state.temperature_c - 55.0) / 120.0).clamp(0.0, 4.0);
                state.moisture =
                    (state.moisture - material.drying_rate * heat * dt).clamp(0.0, 1.0);
            } else {
                state.moisture = (state.moisture
                    + sample.ambient_moisture.clamp(0.0, 1.0) * 0.002 * dt)
                    .clamp(0.0, 1.0);
            }
        }

        // Read an immutable snapshot to make pair order irrelevant. Heat
        // deltas accumulate before any target temperature changes.
        let snapshots: Vec<_> = ids
            .iter()
            .map(|&id| {
                let entity = &self.entities[&id];
                let (shape_a, shape_b, radius) = reaction_shape(entity);
                (
                    id,
                    entity.transform.position,
                    shape_a,
                    shape_b,
                    radius,
                    entity.reactive_material.expect("filtered"),
                    entity.reactive_state.expect("filtered"),
                )
            })
            .collect();
        let mut heat_delta: BTreeMap<EntityId, f32> = BTreeMap::new();

        for &(
            source_id,
            _source_pos,
            source_a,
            source_b,
            source_radius,
            source_material,
            source_state,
        ) in &snapshots
        {
            if !source_state.burning || source_state.fuel <= 0.0 {
                continue;
            }
            for &(target_id, target_pos, target_a, target_b, target_radius, target_material, _) in
                &snapshots
            {
                if target_id == source_id {
                    continue;
                }
                let (source_point, target_point) =
                    closest_segment_points(source_a, source_b, target_a, target_b);
                let delta = target_point - source_point;
                let distance = delta.length();
                let reach = self.config.reaction_radius + source_radius + target_radius;
                if !distance.is_finite() || distance >= reach {
                    continue;
                }
                let sample = environment.sample(target_pos);
                let wind_alignment = if distance > 0.001 && sample.wind.length_squared() > 0.001 {
                    sample.wind.normalize().dot(delta / distance).max(0.0)
                } else {
                    0.0
                };
                let attenuation =
                    (1.0 - distance / reach).max(0.0).powi(2) * (1.0 + wind_alignment * 0.35);
                let amount = source_material.heat_output * attenuation * dt
                    / target_material.heat_capacity.max(0.05);
                *heat_delta.entry(target_id).or_default() += amount;
            }
        }

        // Close objects exchange heat in both directions, independently of
        // burning. This is what lets a hot log cook fruit after its flame dies.
        for i in 0..snapshots.len() {
            for j in i + 1..snapshots.len() {
                let (a_id, _, a0, a1, ar, a_mat, a_state) = snapshots[i];
                let (b_id, _, b0, b1, br, b_mat, b_state) = snapshots[j];
                let (point_a, point_b) = closest_segment_points(a0, a1, b0, b1);
                let reach = ar + br + 0.35;
                if point_a.distance_squared(point_b) > reach * reach {
                    continue;
                }
                let conductivity = (a_mat.conductivity + b_mat.conductivity) * 0.5;
                let transfer = (a_state.temperature_c - b_state.temperature_c)
                    * conductivity
                    * self.config.contact_heat_exchange
                    * dt;
                *heat_delta.entry(a_id).or_default() -= transfer / a_mat.heat_capacity.max(0.05);
                *heat_delta.entry(b_id).or_default() += transfer / b_mat.heat_capacity.max(0.05);
            }
        }
        for (id, delta) in heat_delta {
            if let Some(state) = self
                .entities
                .get_mut(&id)
                .and_then(|entity| entity.reactive_state.as_mut())
            {
                state.temperature_c = (state.temperature_c + delta).clamp(-50.0, 2000.0);
            }
        }

        for id in ids {
            let entity = self.entities.get_mut(&id).expect("id came from map");
            let material = entity.reactive_material.expect("filtered");
            let state = entity.reactive_state.as_mut().expect("filtered");
            let ignition = material.ignition_temperature_c
                * (1.0 + state.moisture * material.moisture_resistance.max(0.0));
            if !state.burning
                && !state.burned_out
                && state.fuel > 0.0
                && state.temperature_c >= ignition
            {
                state.burning = true;
                events.push(WorldEvent::Ignited { entity: id });
            }

            if state.burning {
                if state.moisture >= 0.82 {
                    state.burning = false;
                    events.push(WorldEvent::Extinguished { entity: id });
                } else {
                    state.fuel = (state.fuel - material.burn_rate.max(0.0) * dt).max(0.0);
                    state.moisture =
                        (state.moisture - material.drying_rate.max(0.0) * 2.0 * dt).max(0.0);
                    let sustained =
                        material.ignition_temperature_c + material.heat_output.max(0.0) * 0.22;
                    state.temperature_c = state.temperature_c.max(sustained.min(1400.0));
                    if state.fuel <= 0.0 {
                        state.burning = false;
                        if !state.burned_out {
                            state.burned_out = true;
                            events.push(WorldEvent::BurnedOut { entity: id });
                        }
                    }
                }
            }

            if state.temperature_c >= material.cook_temperature_c && !state.cooked {
                state.cook_progress +=
                    (state.temperature_c - material.cook_temperature_c + 1.0) * dt / 180.0;
                if state.cook_progress >= 1.0 {
                    state.cook_progress = 1.0;
                    state.cooked = true;
                    events.push(WorldEvent::Cooked { entity: id });
                }
            }
            if state.temperature_c >= material.char_temperature_c && !state.charred {
                state.char_progress +=
                    (state.temperature_c - material.char_temperature_c + 1.0) * dt / 240.0;
                if state.char_progress >= 1.0 {
                    state.char_progress = 1.0;
                    state.charred = true;
                    events.push(WorldEvent::Charred { entity: id });
                }
            }
        }
    }

    fn integrate_bodies(&mut self) {
        let dt = self.config.fixed_dt;
        for entity in self.entities.values_mut() {
            let attached = entity.attachment.is_some();
            let Some(body) = entity.body.as_mut() else {
                continue;
            };
            if body.mode != BodyMode::Dynamic || attached || body.sleeping {
                continue;
            }
            body.linear_velocity += self.config.gravity * body.gravity_scale * dt;
            body.linear_velocity /= 1.0 + body.linear_damping.max(0.0) * dt;
            body.angular_velocity /= 1.0 + body.angular_damping.max(0.0) * dt;
            entity.transform.position += body.linear_velocity * dt;
            let angular_speed = body.angular_velocity.length();
            if angular_speed > 1e-6 && angular_speed.is_finite() {
                let delta = Quat::from_axis_angle(
                    body.angular_velocity / angular_speed,
                    angular_speed * dt,
                );
                entity.transform.rotation = (delta * entity.transform.rotation).normalize();
            }
        }
    }

    fn solve_ground<E: Environment + ?Sized>(&mut self, environment: &E) -> Vec<ContactEvent> {
        let ids: Vec<_> = self.entities.keys().copied().collect();
        let mut contacts = Vec::new();
        for id in ids {
            let Some(snapshot) = self.entities.get(&id).cloned() else {
                continue;
            };
            let (Some(_collider), Some(body)) = (snapshot.collider, snapshot.body) else {
                continue;
            };
            if body.mode != BodyMode::Dynamic || snapshot.attachment.is_some() {
                continue;
            }
            let sample = environment.sample(snapshot.transform.position);
            let normal = safe_ground_normal(sample.ground_normal);
            let (segment_a, segment_b, radius) = collider_segment(&snapshot);
            let ground_point = Vec3::new(
                snapshot.transform.position.x,
                sample.ground_height,
                snapshot.transform.position.z,
            );
            let support_center = if segment_a.dot(normal) <= segment_b.dot(normal) {
                segment_a
            } else {
                segment_b
            };
            let signed_distance = (support_center - ground_point).dot(normal) - radius;
            let penetration = -signed_distance;
            if penetration <= 0.0 || !penetration.is_finite() {
                continue;
            }
            let entity = self.entities.get_mut(&id).expect("snapshot id exists");
            let body = entity.body.as_mut().expect("snapshot had body");
            entity.transform.position += normal * penetration;
            let normal_speed = body.linear_velocity.dot(normal);
            let mut impulse = 0.0;
            if normal_speed < 0.0 {
                impulse = -(1.0 + clamp_unit(entity.surface.restitution))
                    * normal_speed
                    * body.mass.max(0.001);
                body.linear_velocity -=
                    normal * normal_speed * (1.0 + clamp_unit(entity.surface.restitution));
            }
            let tangent = body.linear_velocity - normal * body.linear_velocity.dot(normal);
            let friction = finite_non_negative(entity.surface.friction);
            body.linear_velocity -= tangent * (friction * self.config.fixed_dt * 8.0).min(1.0);
            body.angular_velocity /= 1.0 + friction * self.config.fixed_dt * 2.0;
            update_sleep(body, &self.config);
            if impulse > 0.02 {
                contacts.push(ContactEvent {
                    a: id,
                    b: None,
                    normal,
                    position: support_center + normal * (penetration - radius),
                    impulse,
                    surface_a: entity.surface,
                    surface_b: PhysicalSurface {
                        friction: 0.86,
                        restitution: 0.04,
                    },
                });
            }
        }
        contacts
    }

    fn solve_pairs(&mut self) -> Vec<ContactEvent> {
        let ids: Vec<_> = self
            .entities
            .iter()
            .filter(|(_, entity)| entity.collider.is_some())
            .map(|(&id, _)| id)
            .collect();
        let mut contacts = Vec::new();
        for i in 0..ids.len() {
            for j in i + 1..ids.len() {
                let a_id = ids[i];
                let b_id = ids[j];
                let a = self.entities[&a_id].clone();
                let b = self.entities[&b_id].clone();
                let inv_a = a
                    .body
                    .map_or(0.0, |body| body.inverse_mass(a.attachment.is_some()));
                let inv_b = b
                    .body
                    .map_or(0.0, |body| body.inverse_mass(b.attachment.is_some()));
                if inv_a + inv_b <= 0.0 {
                    continue;
                }
                let (a0, a1, ar) = collider_segment(&a);
                let (b0, b1, br) = collider_segment(&b);
                let (point_a, point_b) = closest_segment_points(a0, a1, b0, b1);
                let offset = point_a - point_b;
                let distance_squared = offset.length_squared();
                let radius_sum = ar + br;
                if distance_squared >= radius_sum * radius_sum {
                    continue;
                }
                let distance = distance_squared.sqrt();
                let normal = if distance > 1e-5 {
                    offset / distance
                } else if a_id < b_id {
                    Vec3::X
                } else {
                    -Vec3::X
                };
                let penetration = radius_sum - distance;
                let inv_sum = inv_a + inv_b;
                let correction = normal * (penetration.max(0.0) / inv_sum * 0.82);
                if inv_a > 0.0 {
                    let entity = self.entities.get_mut(&a_id).unwrap();
                    entity.transform.position += correction * inv_a;
                    entity.body.as_mut().unwrap().wake();
                }
                if inv_b > 0.0 {
                    let entity = self.entities.get_mut(&b_id).unwrap();
                    entity.transform.position -= correction * inv_b;
                    entity.body.as_mut().unwrap().wake();
                }

                let relative_velocity = body_velocity(&a) - body_velocity(&b);
                let normal_speed = relative_velocity.dot(normal);
                let restitution = clamp_unit(a.surface.restitution.min(b.surface.restitution));
                let impulse = if normal_speed < 0.0 {
                    -(1.0 + restitution) * normal_speed / inv_sum
                } else {
                    0.0
                };
                if impulse > 0.0 {
                    let tangent_velocity = relative_velocity - normal * normal_speed;
                    let friction_impulse = if tangent_velocity.length_squared() > 1e-10 {
                        let tangent = tangent_velocity.normalize();
                        let unconstrained = -relative_velocity.dot(tangent) / inv_sum;
                        let friction = (finite_non_negative(a.surface.friction)
                            * finite_non_negative(b.surface.friction))
                        .sqrt();
                        tangent * unconstrained.clamp(-impulse * friction, impulse * friction)
                    } else {
                        Vec3::ZERO
                    };
                    let impulse_vector = normal * impulse + friction_impulse;
                    if inv_a > 0.0 {
                        let body = self.entities.get_mut(&a_id).unwrap().body.as_mut().unwrap();
                        body.linear_velocity += impulse_vector * inv_a;
                        body.wake();
                    }
                    if inv_b > 0.0 {
                        let body = self.entities.get_mut(&b_id).unwrap().body.as_mut().unwrap();
                        body.linear_velocity -= impulse_vector * inv_b;
                        body.wake();
                    }
                }
                if impulse > 0.02 {
                    let contact_a = point_a - normal * ar;
                    let contact_b = point_b + normal * br;
                    contacts.push(ContactEvent {
                        a: a_id,
                        b: Some(b_id),
                        normal,
                        position: (contact_a + contact_b) * 0.5,
                        impulse,
                        surface_a: a.surface,
                        surface_b: b.surface,
                    });
                }
            }
        }
        contacts
    }

    fn apply_contact_damage(
        &mut self,
        contacts: &[ContactEvent],
        fractures: &mut BTreeMap<EntityId, (Vec3, f32)>,
    ) {
        let mut damage: BTreeMap<EntityId, (Vec3, f32)> = BTreeMap::new();
        for contact in contacts {
            let participants = [
                Some((contact.a, contact.normal)),
                contact.b.map(|id| (id, -contact.normal)),
            ];
            for (id, direction) in participants.into_iter().flatten() {
                let Some(structure) = self.entities.get(&id).and_then(|entity| entity.structure)
                else {
                    continue;
                };
                if contact.impulse > structure.impact_threshold {
                    let amount = (contact.impulse - structure.impact_threshold)
                        * structure.impact_damage_scale;
                    let entry = damage.entry(id).or_insert((direction, 0.0));
                    entry.1 += amount;
                }
            }
        }
        for (id, (direction, amount)) in damage {
            let Some(structure) = self
                .entities
                .get_mut(&id)
                .and_then(|entity| entity.structure.as_mut())
            else {
                continue;
            };
            if structure.fractured {
                continue;
            }
            structure.integrity = (structure.integrity - amount).max(0.0);
            if structure.integrity <= 0.0 {
                fractures.entry(id).or_insert((direction, amount));
            }
        }
    }

    fn commit_fractures(
        &mut self,
        fractures: BTreeMap<EntityId, (Vec3, f32)>,
        events: &mut Vec<WorldEvent>,
    ) {
        for (id, (direction, energy)) in fractures {
            let direction = safe_direction(direction);
            let Some(entity) = self.entities.get_mut(&id) else {
                continue;
            };
            let Some(structure) = entity.structure.as_mut() else {
                continue;
            };
            if structure.fractured || structure.integrity > 0.0 {
                continue;
            }
            structure.fractured = true;
            if let Some(body) = entity.body.as_mut() {
                body.mode = BodyMode::Dynamic;
                body.gravity_scale = 1.0;
                let inv_mass = body.mass.max(0.001).recip();
                body.linear_velocity += direction * energy * inv_mass * 0.08;
                let torque_axis = Vec3::Y.cross(direction).normalize_or(Vec3::X);
                body.angular_velocity += torque_axis * (0.65 + energy * inv_mass * 0.1);
                body.wake();
            }
            events.push(WorldEvent::Fractured {
                entity: id,
                direction,
                energy,
            });

            let parent_transform = entity.transform;
            let parent_body = entity.body.unwrap_or_default();
            let children: Vec<_> = self
                .entities
                .iter()
                .filter(|(_, child)| {
                    child
                        .attachment
                        .is_some_and(|attachment| attachment.parent == id)
                })
                .map(|(&child_id, _)| child_id)
                .collect();
            for child_id in children {
                let child = self.entities.get_mut(&child_id).expect("child id exists");
                let attachment = child.attachment.take().expect("filtered attachment");
                if let Some(body) = child.body.as_mut() {
                    body.mode = BodyMode::Dynamic;
                    body.gravity_scale = 1.0;
                    let arm = child.transform.position - parent_transform.position;
                    let jitter = Vec3::new(
                        self.rng.signed_f32(),
                        self.rng.next_f32(),
                        self.rng.signed_f32(),
                    ) * 0.18;
                    body.linear_velocity = parent_body.linear_velocity
                        + parent_body.angular_velocity.cross(arm)
                        + attachment.release_impulse
                        + jitter;
                    body.wake();
                }
                events.push(WorldEvent::Detached {
                    entity: child_id,
                    parent: id,
                });
            }
        }
    }

    pub fn state_hash(&self) -> u64 {
        let mut hash = StableHash::new();
        hash.u64(self.seed);
        hash.u64(self.rng.state());
        hash.u64(self.tick);
        hash.u64(self.next_id);
        hash.f32(self.config.fixed_dt);
        hash.vec3(self.config.gravity);
        hash.f32(self.config.reaction_radius);
        hash.f32(self.config.ambient_exchange);
        hash.f32(self.config.contact_heat_exchange);
        hash.f32(self.config.douse_cooling_c);
        hash.f32(self.config.sleep_linear_speed);
        hash.f32(self.config.sleep_angular_speed);
        hash.u64(self.config.sleep_turns as u64);
        hash.u64(self.entities.len() as u64);
        for (&id, entity) in &self.entities {
            hash.u64(id.0);
            match &entity.name {
                Some(name) => {
                    hash.u8(1);
                    hash.string(name);
                }
                None => hash.u8(0),
            }
            hash.u64(entity.tags.len() as u64);
            for tag in &entity.tags {
                hash.string(tag);
            }
            hash.transform(entity.transform);
            match entity.body {
                Some(body) => {
                    hash.u8(1);
                    hash.u8(body.mode as u8);
                    hash.f32(body.mass);
                    hash.vec3(body.linear_velocity);
                    hash.vec3(body.angular_velocity);
                    hash.f32(body.gravity_scale);
                    hash.f32(body.linear_damping);
                    hash.f32(body.angular_damping);
                    hash.u8(body.sleeping as u8);
                    hash.u64(body.quiet_turns as u64);
                }
                None => hash.u8(0),
            }
            match entity.collider {
                Some(Collider::Sphere { radius }) => {
                    hash.u8(1);
                    hash.f32(radius);
                }
                Some(Collider::CapsuleY {
                    radius,
                    half_height,
                }) => {
                    hash.u8(2);
                    hash.f32(radius);
                    hash.f32(half_height);
                }
                None => hash.u8(0),
            }
            hash.f32(entity.surface.friction);
            hash.f32(entity.surface.restitution);
            match entity.attachment {
                Some(attachment) => {
                    hash.u8(1);
                    hash.u64(attachment.parent.0);
                    hash.transform(attachment.local);
                    hash.vec3(attachment.release_impulse);
                }
                None => hash.u8(0),
            }
            match entity.structure {
                Some(structure) => {
                    hash.u8(1);
                    hash.f32(structure.integrity);
                    hash.f32(structure.max_integrity);
                    hash.f32(structure.cut_resistance);
                    hash.f32(structure.impact_threshold);
                    hash.f32(structure.impact_damage_scale);
                    hash.u8(structure.fractured as u8);
                }
                None => hash.u8(0),
            }
            match entity.reactive_material {
                Some(material) => {
                    hash.u8(1);
                    hash.f32(material.heat_capacity);
                    hash.f32(material.conductivity);
                    hash.f32(material.ignition_temperature_c);
                    hash.f32(material.burn_rate);
                    hash.f32(material.heat_output);
                    hash.f32(material.drying_rate);
                    hash.f32(material.moisture_resistance);
                    hash.f32(material.cook_temperature_c);
                    hash.f32(material.char_temperature_c);
                }
                None => hash.u8(0),
            }
            match entity.reactive_state {
                Some(state) => {
                    hash.u8(1);
                    hash.f32(state.temperature_c);
                    hash.f32(state.moisture);
                    hash.f32(state.fuel);
                    hash.u8(state.burning as u8);
                    hash.f32(state.cook_progress);
                    hash.f32(state.char_progress);
                    hash.u8(state.cooked as u8);
                    hash.u8(state.charred as u8);
                    hash.u8(state.burned_out as u8);
                }
                None => hash.u8(0),
            }
        }
        hash.u64(self.interactions.len() as u64);
        for interaction in &self.interactions {
            match interaction {
                Interaction::Cut {
                    target,
                    direction,
                    energy,
                } => {
                    hash.u8(1);
                    hash.u64(target.0);
                    hash.vec3(*direction);
                    hash.f32(*energy);
                }
                Interaction::Impulse {
                    target,
                    impulse,
                    point,
                } => {
                    hash.u8(2);
                    hash.u64(target.0);
                    hash.vec3(*impulse);
                    hash.vec3(*point);
                }
                Interaction::Ignite { target, energy } => {
                    hash.u8(3);
                    hash.u64(target.0);
                    hash.f32(*energy);
                }
                Interaction::Douse { target, amount } => {
                    hash.u8(4);
                    hash.u64(target.0);
                    hash.f32(*amount);
                }
            }
        }
        hash.finish()
    }
}

fn entity_from_bundle(id: EntityId, bundle: EntityBundle) -> Entity {
    Entity {
        id,
        name: bundle.name,
        tags: bundle.tags,
        transform: bundle.transform,
        body: bundle.body,
        collider: bundle.collider,
        surface: bundle.surface,
        attachment: bundle.attachment,
        structure: bundle.structure,
        reactive_material: bundle.reactive_material,
        reactive_state: bundle.reactive_state,
    }
}

fn finite_non_negative(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn clamp_unit(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

fn safe_direction(direction: Vec3) -> Vec3 {
    if direction.is_finite() && direction.length_squared() > 1e-8 {
        direction.normalize()
    } else {
        Vec3::X
    }
}

fn safe_ground_normal(normal: Vec3) -> Vec3 {
    if !normal.is_finite() || normal.length_squared() <= 1e-8 {
        return Vec3::Y;
    }
    let normal = normal.normalize();
    if normal.y < 0.0 { -normal } else { normal }
}

fn body_velocity(entity: &Entity) -> Vec3 {
    match entity.body {
        Some(body) if body.mode != BodyMode::Static && body.linear_velocity.is_finite() => {
            body.linear_velocity
        }
        _ => Vec3::ZERO,
    }
}

fn reaction_shape(entity: &Entity) -> (Vec3, Vec3, f32) {
    if entity.collider.is_some() {
        collider_segment(entity)
    } else {
        (entity.transform.position, entity.transform.position, 0.0)
    }
}

fn collider_segment(entity: &Entity) -> (Vec3, Vec3, f32) {
    let collider = entity.collider.expect("caller filters collider");
    match collider {
        Collider::Sphere { .. } => {
            let uniform_scale = entity.transform.scale.abs().max_element().max(0.001);
            let radius = collider.radius() * uniform_scale;
            (entity.transform.position, entity.transform.position, radius)
        }
        Collider::CapsuleY { .. } => {
            let radial_scale = entity
                .transform
                .scale
                .x
                .abs()
                .max(entity.transform.scale.z.abs())
                .max(0.001);
            let radius = collider.radius() * radial_scale;
            let half_height = collider.half_height() * entity.transform.scale.y.abs();
            let axis = entity.transform.rotation * Vec3::Y * half_height;
            (
                entity.transform.position - axis,
                entity.transform.position + axis,
                radius,
            )
        }
    }
}

/// Closest points on two finite segments. Based on the standard clamped
/// two-parameter solution, with explicit degenerate handling for spheres.
fn closest_segment_points(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3) -> (Vec3, Vec3) {
    let d1 = q1 - p1;
    let d2 = q2 - p2;
    let r = p1 - p2;
    let a = d1.dot(d1);
    let e = d2.dot(d2);
    let f = d2.dot(r);
    let epsilon = 1e-8;
    let (mut s, mut t);
    if a <= epsilon && e <= epsilon {
        return (p1, p2);
    }
    if a <= epsilon {
        s = 0.0;
        t = (f / e).clamp(0.0, 1.0);
    } else {
        let c = d1.dot(r);
        if e <= epsilon {
            t = 0.0;
            s = (-c / a).clamp(0.0, 1.0);
        } else {
            let b = d1.dot(d2);
            let denominator = a * e - b * b;
            s = if denominator.abs() > epsilon {
                ((b * f - c * e) / denominator).clamp(0.0, 1.0)
            } else {
                0.0
            };
            t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = (-c / a).clamp(0.0, 1.0);
            } else if t > 1.0 {
                t = 1.0;
                s = ((b - c) / a).clamp(0.0, 1.0);
            }
        }
    }
    (p1 + d1 * s, p2 + d2 * t)
}

fn update_sleep(body: &mut Body, config: &WorldConfig) {
    if body.linear_velocity.length() < config.sleep_linear_speed
        && body.angular_velocity.length() < config.sleep_angular_speed
    {
        body.quiet_turns = body.quiet_turns.saturating_add(1);
        if body.quiet_turns >= config.sleep_turns {
            body.sleeping = true;
            body.linear_velocity = Vec3::ZERO;
            body.angular_velocity = Vec3::ZERO;
        }
    } else {
        body.quiet_turns = 0;
        body.sleeping = false;
    }
}

struct StableHash(u64);

impl StableHash {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn new() -> Self {
        Self(Self::OFFSET)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= byte as u64;
            self.0 = self.0.wrapping_mul(Self::PRIME);
        }
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn f32(&mut self, value: f32) {
        self.bytes(&value.to_bits().to_le_bytes());
    }

    fn vec3(&mut self, value: Vec3) {
        self.f32(value.x);
        self.f32(value.y);
        self.f32(value.z);
    }

    fn transform(&mut self, value: Transform) {
        self.vec3(value.position);
        self.f32(value.rotation.x);
        self.f32(value.rotation.y);
        self.f32(value.rotation.z);
        self.f32(value.rotation.w);
        self.vec3(value.scale);
    }

    fn string(&mut self, value: &str) {
        self.u64(value.len() as u64);
        self.bytes(value.as_bytes());
    }

    fn finish(self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reactive_entity(
        position: Vec3,
        material: ReactiveMaterial,
        state: ReactiveState,
    ) -> EntityBundle {
        let mut entity = EntityBundle::new(Transform::from_translation(position));
        entity.body = Some(Body::dynamic(1.0));
        entity.collider = Some(Collider::Sphere { radius: 0.25 });
        entity.reactive_material = Some(material);
        entity.reactive_state = Some(state);
        entity
    }

    #[test]
    fn same_seed_and_script_have_the_same_hash_and_events() {
        let run = || {
            let mut world = World::with_seed(73);
            let id = world.spawn(reactive_entity(
                Vec3::new(0.0, 2.0, 0.0),
                ReactiveMaterial::fruit(),
                ReactiveState::new(20.0, 0.2, 0.4),
            ));
            world.queue_interaction(Interaction::Impulse {
                target: id,
                impulse: Vec3::new(1.0, 2.0, -0.5),
                point: Vec3::new(0.0, 2.2, 0.0),
            });
            let environment = FlatEnvironment::default();
            let mut reports = Vec::new();
            for turn in 0..180 {
                if turn == 30 {
                    world.queue_interaction(Interaction::Ignite {
                        target: id,
                        energy: 1_400.0,
                    });
                }
                reports.push(world.step(&environment));
            }
            (world.state_hash(), reports)
        };
        assert_eq!(run(), run());
    }

    #[test]
    fn cutting_fractures_parent_and_releases_falling_fruit() {
        let mut world = World::with_seed(9);
        let mut tree = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 2.0, 0.0)))
            .named("tree")
            .tagged("tree");
        tree.body = Some(Body::static_body());
        tree.body.as_mut().unwrap().mass = 18.0;
        tree.collider = Some(Collider::CapsuleY {
            radius: 0.35,
            half_height: 2.0,
        });
        tree.structure = Some(Structure::new(2.0, 1.0));
        let tree_id = world.spawn(tree);

        let mut apple = reactive_entity(
            Vec3::ZERO,
            ReactiveMaterial::fruit(),
            ReactiveState::new(20.0, 0.35, 0.35),
        )
        .named("apple")
        .tagged("apple");
        apple.attachment = Some(Attachment {
            parent: tree_id,
            local: Transform::from_translation(Vec3::new(0.7, 1.9, 0.1)),
            release_impulse: Vec3::new(0.2, 0.4, 0.0),
        });
        let apple_id = world.spawn(apple);
        let environment = FlatEnvironment::default();
        world.step(&environment);
        world.queue_interaction(Interaction::Cut {
            target: tree_id,
            direction: Vec3::X,
            energy: 1.0,
        });
        assert!(
            !world
                .step(&environment)
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Fractured { .. }))
        );
        world.queue_interaction(Interaction::Cut {
            target: tree_id,
            direction: Vec3::X,
            energy: 1.0,
        });
        let report = world.step(&environment);
        assert!(report.events.iter().any(
            |event| matches!(event, WorldEvent::Fractured { entity, .. } if *entity == tree_id)
        ));
        assert!(report.events.iter().any(
            |event| matches!(event, WorldEvent::Detached { entity, parent } if *entity == apple_id && *parent == tree_id)
        ));
        assert!(world.entity(apple_id).unwrap().attachment.is_none());

        let release_y = world.entity(apple_id).unwrap().transform.position.y;
        let mut hit_ground = false;
        for _ in 0..240 {
            let report = world.step(&environment);
            hit_ground |= report.events.iter().any(|event| {
                matches!(event, WorldEvent::Contact(contact) if contact.a == apple_id && contact.b.is_none())
            });
        }
        assert!(world.entity(apple_id).unwrap().transform.position.y < release_y);
        assert!(hit_ground, "released fruit must produce a terrain contact");
    }

    #[test]
    fn moisture_raises_ignition_threshold_without_changing_surface() {
        let mut material = ReactiveMaterial::wood();
        material.ignition_temperature_c = 100.0;
        material.heat_capacity = 1.0;
        let mut world = World::with_seed(1);
        let dry = world.spawn(reactive_entity(
            Vec3::new(-8.0, 0.25, 0.0),
            material,
            ReactiveState::new(20.0, 0.0, 1.0),
        ));
        let wet = world.spawn(reactive_entity(
            Vec3::new(8.0, 0.25, 0.0),
            material,
            ReactiveState::new(20.0, 0.8, 1.0),
        ));
        assert_eq!(
            world.entity(dry).unwrap().surface,
            world.entity(wet).unwrap().surface
        );
        for id in [dry, wet] {
            world.queue_interaction(Interaction::Ignite {
                target: id,
                energy: 110.0,
            });
        }
        world.step(&FlatEnvironment::default());
        assert!(world.entity(dry).unwrap().reactive_state.unwrap().burning);
        assert!(!world.entity(wet).unwrap().reactive_state.unwrap().burning);
    }

    #[test]
    fn flame_spreads_then_water_extinguishes() {
        let mut world = World::with_seed(2);
        let mut flame = reactive_entity(
            Vec3::new(0.0, 0.25, 0.0),
            ReactiveMaterial::flame(),
            ReactiveState::new(720.0, 0.0, 1.0),
        );
        flame.reactive_state.as_mut().unwrap().burning = true;
        flame.body = Some(Body::static_body());
        world.spawn(flame);
        let mut wood_material = ReactiveMaterial::wood();
        wood_material.ignition_temperature_c = 145.0;
        let wood = world.spawn(reactive_entity(
            Vec3::new(0.75, 0.25, 0.0),
            wood_material,
            ReactiveState::new(20.0, 0.0, 1.0),
        ));
        let environment = FlatEnvironment::default();
        let mut ignited = false;
        for _ in 0..180 {
            let report = world.step(&environment);
            ignited |= report
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Ignited { entity } if *entity == wood));
            if ignited {
                break;
            }
        }
        assert!(ignited, "nearby dry fuel should ignite from spatial heat");
        world.queue_interaction(Interaction::Douse {
            target: wood,
            amount: 1.0,
        });
        let report = world.step(&environment);
        assert!(
            report.events.iter().any(
                |event| matches!(event, WorldEvent::Extinguished { entity } if *entity == wood)
            )
        );
        assert!(!world.entity(wood).unwrap().reactive_state.unwrap().burning);
    }

    #[test]
    fn snapshot_restore_recovers_exact_state() {
        let mut world = World::with_seed(55);
        world.spawn(reactive_entity(
            Vec3::new(0.0, 1.0, 0.0),
            ReactiveMaterial::fruit(),
            ReactiveState::new(20.0, 0.2, 0.3),
        ));
        let environment = FlatEnvironment::default();
        for _ in 0..12 {
            world.step(&environment);
        }
        let snapshot = world.snapshot();
        let expected = world.state_hash();
        for _ in 0..10 {
            world.step(&environment);
        }
        assert_ne!(world.state_hash(), expected);
        world.restore(snapshot);
        assert_eq!(world.state_hash(), expected);
    }

    #[test]
    fn segment_solver_handles_spheres_and_crossed_capsules() {
        assert_eq!(
            closest_segment_points(Vec3::ZERO, Vec3::ZERO, Vec3::X, Vec3::X),
            (Vec3::ZERO, Vec3::X)
        );
        let (a, b) = closest_segment_points(-Vec3::X, Vec3::X, -Vec3::Y, Vec3::Y);
        assert!(a.length() < 1e-5 && b.length() < 1e-5);
    }

    #[test]
    fn terrain_contact_applies_structural_damage_once() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let mut bundle = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 0.4, 0.0)));
        let mut body = Body::dynamic(1.0);
        body.linear_velocity = -Vec3::Y;
        body.linear_damping = 0.0;
        bundle.body = Some(body);
        bundle.collider = Some(Collider::Sphere { radius: 0.5 });
        bundle.surface.restitution = 0.0;
        let mut structure = Structure::new(10.0, 1.0);
        structure.impact_threshold = 0.0;
        structure.impact_damage_scale = 1.0;
        bundle.structure = Some(structure);
        let id = world.spawn(bundle);

        let report = world.step(&FlatEnvironment::default());
        let impulse = report
            .events
            .iter()
            .find_map(|event| match event {
                WorldEvent::Contact(contact) if contact.a == id && contact.b.is_none() => {
                    Some(contact.impulse)
                }
                _ => None,
            })
            .expect("penetrating body should contact terrain");
        let integrity = world.entity(id).unwrap().structure.unwrap().integrity;
        assert!((integrity - (10.0 - impulse)).abs() < 1e-5);
    }

    #[test]
    fn zero_or_invalid_douse_does_not_extinguish_a_fire() {
        for amount in [0.0, -1.0, f32::NAN] {
            let mut world = World::with_seed(3);
            let mut material = ReactiveMaterial::wood();
            material.ignition_temperature_c = 100.0;
            let mut state = ReactiveState::new(400.0, 0.0, 1.0);
            state.burning = true;
            let id = world.spawn(reactive_entity(Vec3::ZERO, material, state));
            world.queue_interaction(Interaction::Douse { target: id, amount });

            let report = world.step(&FlatEnvironment::default());
            assert!(world.entity(id).unwrap().reactive_state.unwrap().burning);
            assert!(!report.events.iter().any(
                |event| matches!(event, WorldEvent::Extinguished { entity } if *entity == id)
            ));
        }
    }

    #[test]
    fn state_hash_includes_all_configuration_and_option_discriminants() {
        let mut baseline = World::with_seed(4);
        baseline.spawn(EntityBundle::default());

        let mut changed_config = World::with_seed(4);
        changed_config.spawn(EntityBundle::default());
        changed_config.config_mut().ambient_exchange += 0.01;
        assert_ne!(baseline.state_hash(), changed_config.state_hash());

        let mut empty_name = World::with_seed(4);
        empty_name.spawn(EntityBundle::default().named(""));
        assert_ne!(baseline.state_hash(), empty_name.state_hash());
    }

    #[test]
    fn detached_body_wakes_when_parent_is_removed_or_missing() {
        let mut world = World::with_seed(5);
        let parent = world.spawn(EntityBundle::default());
        let mut attached = EntityBundle {
            body: Some(Body::dynamic(1.0)),
            ..EntityBundle::default()
        };
        attached.body.as_mut().unwrap().sleeping = true;
        attached.attachment = Some(Attachment {
            parent,
            local: Transform::IDENTITY,
            release_impulse: Vec3::ZERO,
        });
        let child = world.spawn(attached);
        world.remove(parent);
        let child_entity = world.entity(child).unwrap();
        assert!(child_entity.attachment.is_none());
        assert!(!child_entity.body.unwrap().sleeping);

        let mut missing_parent = EntityBundle {
            body: Some(Body::dynamic(1.0)),
            ..EntityBundle::default()
        };
        missing_parent.body.as_mut().unwrap().sleeping = true;
        missing_parent.attachment = Some(Attachment {
            parent: EntityId(999),
            local: Transform::IDENTITY,
            release_impulse: Vec3::ZERO,
        });
        let orphan = world.spawn(missing_parent);
        world.step(&FlatEnvironment::default());
        let orphan_entity = world.entity(orphan).unwrap();
        assert!(orphan_entity.attachment.is_none());
        assert!(!orphan_entity.body.unwrap().sleeping);
    }

    #[test]
    fn attachment_tracks_parent_after_same_turn_integration() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let dt = config.fixed_dt;
        let mut world = World::new(config);
        let mut parent_bundle = EntityBundle::default();
        let mut parent_body = Body::dynamic(1.0);
        parent_body.linear_velocity = Vec3::X;
        parent_body.linear_damping = 0.0;
        parent_bundle.body = Some(parent_body);
        let parent = world.spawn(parent_bundle);

        let child_bundle = EntityBundle {
            body: Some(Body::dynamic(1.0)),
            attachment: Some(Attachment {
                parent,
                local: Transform::from_translation(Vec3::Y),
                release_impulse: Vec3::ZERO,
            }),
            ..EntityBundle::default()
        };
        let child = world.spawn(child_bundle);

        world.step(&FlatEnvironment::default());
        assert_eq!(world.entity(parent).unwrap().transform.position.x, dt);
        assert_eq!(world.entity(child).unwrap().transform.position.x, dt);
        assert_eq!(
            world.entity(child).unwrap().body.unwrap().linear_velocity,
            Vec3::X
        );
    }

    #[test]
    fn static_body_velocity_does_not_inject_pair_collision_energy() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let mut wall = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 5.0, 0.0)));
        let mut wall_body = Body::static_body();
        wall_body.linear_velocity = Vec3::X * 100.0;
        wall.body = Some(wall_body);
        wall.collider = Some(Collider::Sphere { radius: 0.5 });
        world.spawn(wall);

        let mut ball = EntityBundle::new(Transform::from_translation(Vec3::new(0.9, 5.0, 0.0)));
        let mut ball_body = Body::dynamic(1.0);
        ball_body.linear_damping = 0.0;
        ball.body = Some(ball_body);
        ball.collider = Some(Collider::Sphere { radius: 0.5 });
        let ball_id = world.spawn(ball);

        world.step(&FlatEnvironment::default());
        assert_eq!(
            world.entity(ball_id).unwrap().body.unwrap().linear_velocity,
            Vec3::ZERO
        );
    }

    #[test]
    fn pair_contact_friction_reduces_tangential_velocity() {
        let config = WorldConfig {
            gravity: Vec3::ZERO,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);
        let mut wall = EntityBundle::new(Transform::from_translation(Vec3::new(0.0, 5.0, 0.0)));
        wall.body = Some(Body::static_body());
        wall.collider = Some(Collider::Sphere { radius: 0.5 });
        wall.surface.friction = 1.0;
        wall.surface.restitution = 0.0;
        world.spawn(wall);

        let mut ball = EntityBundle::new(Transform::from_translation(Vec3::new(0.9, 5.0, 0.0)));
        let mut ball_body = Body::dynamic(1.0);
        ball_body.linear_velocity = Vec3::new(-2.0, 0.0, 1.0);
        ball_body.linear_damping = 0.0;
        ball.body = Some(ball_body);
        ball.collider = Some(Collider::Sphere { radius: 0.5 });
        ball.surface.friction = 1.0;
        ball.surface.restitution = 0.0;
        let ball_id = world.spawn(ball);

        world.step(&FlatEnvironment::default());
        let velocity = world.entity(ball_id).unwrap().body.unwrap().linear_velocity;
        assert!(velocity.x.abs() < 1e-5);
        assert!(velocity.z.abs() < 1e-5);
    }

    #[test]
    fn reaction_distance_uses_capsule_extent_instead_of_only_its_center() {
        let config = WorldConfig {
            fixed_dt: 1.0,
            gravity: Vec3::ZERO,
            reaction_radius: 0.5,
            ambient_exchange: 0.0,
            contact_heat_exchange: 0.0,
            ..WorldConfig::default()
        };
        let mut world = World::new(config);

        let mut flame_material = ReactiveMaterial::flame();
        flame_material.burn_rate = 0.0;
        let mut flame_state = ReactiveState::new(720.0, 0.0, 1.0);
        flame_state.burning = true;
        let mut flame = reactive_entity(Vec3::ZERO, flame_material, flame_state);
        flame.body = Some(Body::static_body());
        flame.collider = Some(Collider::CapsuleY {
            radius: 0.25,
            half_height: 5.0,
        });
        flame.transform.rotation = Quat::from_rotation_z(std::f32::consts::FRAC_PI_2);
        world.spawn(flame);

        let mut wood_material = ReactiveMaterial::wood();
        wood_material.ignition_temperature_c = 50.0;
        wood_material.heat_capacity = 1.0;
        let target = world.spawn(reactive_entity(
            Vec3::new(5.5, 0.0, 0.0),
            wood_material,
            ReactiveState::new(20.0, 0.0, 1.0),
        ));

        let report = world.step(&FlatEnvironment::default());
        assert!(
            world
                .entity(target)
                .unwrap()
                .reactive_state
                .unwrap()
                .burning
        );
        assert!(
            report
                .events
                .iter()
                .any(|event| matches!(event, WorldEvent::Ignited { entity } if *entity == target))
        );
    }

    #[test]
    fn restore_reconciles_public_snapshot_entity_ids_with_map_keys() {
        let mut world = World::with_seed(6);
        let id = world.spawn(EntityBundle::default());
        let mut snapshot = world.snapshot();
        snapshot.entities.get_mut(&id).unwrap().id = EntityId(999);
        world.restore(snapshot);
        assert_eq!(world.entity(id).unwrap().id, id);
    }
}
