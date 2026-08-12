//! Original procedural geometry used by the playable-world example.
//!
//! All primitives are Y-up and use metres. Grounded primitives such as
//! frustums, rocks, and grass start at `y = 0`; spheres and canopies are
//! centred on the origin. Geometry stays on the CPU as [`Mesh`] until the
//! example uploads it through [`Mesh::upload`].

use std::collections::HashMap;
use std::f32::consts::{PI, TAU};
use std::fmt;
use std::sync::Arc;

use pocket3d::glam::{Mat3, Mat4, Vec2, Vec3};
use pocket3d::gpu::Gpu;
use pocket3d::model::{ModelAsset, ModelInstance, ModelVertex};
use pocket3d::texture::Samplers;

const NORMAL_EPSILON: f32 = 1.0e-12;

#[derive(Clone, Default)]
pub struct Mesh {
    pub vertices: Vec<ModelVertex>,
    pub indices: Vec<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MeshValidationError {
    Empty,
    NonTriangleIndexCount(usize),
    IndexOutOfBounds { index: u32, vertex_count: usize },
    NonFiniteVertex(usize),
    MissingNormal(usize),
}

impl fmt::Display for MeshValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "mesh has no geometry"),
            Self::NonTriangleIndexCount(count) => {
                write!(f, "mesh index count {count} is not divisible by three")
            }
            Self::IndexOutOfBounds {
                index,
                vertex_count,
            } => write!(
                f,
                "mesh index {index} is outside its {vertex_count} vertices"
            ),
            Self::NonFiniteVertex(index) => {
                write!(f, "mesh vertex {index} contains a non-finite value")
            }
            Self::MissingNormal(index) => write!(f, "mesh vertex {index} has no normal"),
        }
    }
}

impl std::error::Error for MeshValidationError {}

impl Mesh {
    pub fn new(vertices: Vec<ModelVertex>, indices: Vec<u32>) -> Self {
        Self { vertices, indices }
    }

    #[allow(dead_code)]
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    #[allow(dead_code)]
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        let first = Vec3::from(self.vertices.first()?.pos);
        let mut min = first;
        let mut max = first;
        for vertex in &self.vertices[1..] {
            let point = Vec3::from(vertex.pos);
            min = min.min(point);
            max = max.max(point);
        }
        Some((min, max))
    }

    pub fn validate(&self) -> Result<(), MeshValidationError> {
        if self.vertices.is_empty() || self.indices.is_empty() {
            return Err(MeshValidationError::Empty);
        }
        if !self.indices.len().is_multiple_of(3) {
            return Err(MeshValidationError::NonTriangleIndexCount(
                self.indices.len(),
            ));
        }
        for &index in &self.indices {
            if index as usize >= self.vertices.len() {
                return Err(MeshValidationError::IndexOutOfBounds {
                    index,
                    vertex_count: self.vertices.len(),
                });
            }
        }
        for (index, vertex) in self.vertices.iter().enumerate() {
            let position = Vec3::from(vertex.pos);
            let normal = Vec3::from(vertex.normal);
            if !position.is_finite()
                || !normal.is_finite()
                || vertex.uv.iter().any(|component| !component.is_finite())
            {
                return Err(MeshValidationError::NonFiniteVertex(index));
            }
            if normal.length_squared() <= NORMAL_EPSILON {
                return Err(MeshValidationError::MissingNormal(index));
            }
        }
        Ok(())
    }

    /// Upload the mesh as one Pocket3D primitive.
    ///
    /// `image` is `(width, height, rgba8)`. Passing `None` uses Pocket3D's
    /// white texture, so [`ModelInstance::tint`] supplies the visible colour.
    pub fn upload(
        &self,
        gpu: &Gpu,
        material_layout: &pocket3d::wgpu::BindGroupLayout,
        samplers: &Samplers,
        label: &str,
        image: Option<(u32, u32, &[u8])>,
    ) -> Arc<ModelAsset> {
        if let Err(error) = self.validate() {
            panic!("cannot upload {label:?}: {error}");
        }
        ModelAsset::from_geometry(
            gpu,
            material_layout,
            samplers,
            label,
            &self.vertices,
            &self.indices,
            image,
        )
    }

    pub fn transformed(&self, transform: Mat4) -> Self {
        let linear = Mat3::from_mat4(transform);
        let determinant = linear.determinant();
        let normal_matrix = if determinant.abs() > NORMAL_EPSILON {
            linear.inverse().transpose()
        } else {
            Mat3::IDENTITY
        };
        let mut result = self.clone();
        for vertex in &mut result.vertices {
            vertex.pos = transform
                .transform_point3(Vec3::from(vertex.pos))
                .to_array();
            vertex.normal = normalize_or(Vec3::from(vertex.normal), Vec3::Y, normal_matrix);
        }
        if determinant < 0.0 {
            for triangle in result.indices.as_chunks_mut::<3>().0 {
                triangle.swap(1, 2);
            }
        }
        result
    }

    pub fn recalculate_smooth_normals(&mut self) {
        let mut accumulated = vec![Vec3::ZERO; self.vertices.len()];
        for triangle in self.indices.as_chunks::<3>().0 {
            let a = Vec3::from(self.vertices[triangle[0] as usize].pos);
            let b = Vec3::from(self.vertices[triangle[1] as usize].pos);
            let c = Vec3::from(self.vertices[triangle[2] as usize].pos);
            let face = (b - a).cross(c - a);
            if face.is_finite() && face.length_squared() > NORMAL_EPSILON {
                accumulated[triangle[0] as usize] += face;
                accumulated[triangle[1] as usize] += face;
                accumulated[triangle[2] as usize] += face;
            }
        }
        for (vertex, normal) in self.vertices.iter_mut().zip(accumulated) {
            vertex.normal = normal.normalize_or_zero().to_array();
            if Vec3::from(vertex.normal).length_squared() <= NORMAL_EPSILON {
                vertex.normal = Vec3::Y.to_array();
            }
        }
    }

    pub fn smooth_shaded(mut self) -> Self {
        self.recalculate_smooth_normals();
        self
    }

    /// Duplicate vertices per triangle and assign one geometric face normal.
    pub fn flat_shaded(&self) -> Self {
        let mut builder = MeshBuilder::with_capacity(self.indices.len(), self.indices.len());
        for triangle in self.indices.as_chunks::<3>().0 {
            let source = [
                self.vertices[triangle[0] as usize],
                self.vertices[triangle[1] as usize],
                self.vertices[triangle[2] as usize],
            ];
            let a = Vec3::from(source[0].pos);
            let b = Vec3::from(source[1].pos);
            let c = Vec3::from(source[2].pos);
            let fallback = source
                .iter()
                .map(|vertex| Vec3::from(vertex.normal))
                .fold(Vec3::ZERO, |sum, normal| sum + normal)
                .normalize_or_zero();
            let normal = face_normal(a, b, c, fallback);
            let base = builder.vertices.len() as u32;
            for mut vertex in source {
                vertex.normal = normal.to_array();
                builder.vertices.push(vertex);
            }
            builder
                .indices
                .extend_from_slice(&[base, base + 1, base + 2]);
        }
        builder.build()
    }
}

pub struct MeshBuilder {
    vertices: Vec<ModelVertex>,
    indices: Vec<u32>,
}

impl Default for MeshBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl MeshBuilder {
    pub fn new() -> Self {
        Self {
            vertices: Vec::new(),
            indices: Vec::new(),
        }
    }

    pub fn with_capacity(vertices: usize, indices: usize) -> Self {
        Self {
            vertices: Vec::with_capacity(vertices),
            indices: Vec::with_capacity(indices),
        }
    }

    pub fn vertex(&mut self, position: Vec3, normal: Vec3, uv: Vec2) -> u32 {
        let index = self.vertices.len() as u32;
        self.vertices.push(model_vertex(position, normal, uv));
        index
    }

    pub fn triangle(&mut self, a: u32, b: u32, c: u32) {
        self.indices.extend_from_slice(&[a, b, c]);
    }

    pub fn triangle_flat(&mut self, positions: [Vec3; 3], uvs: [Vec2; 3]) {
        let normal = face_normal(positions[0], positions[1], positions[2], Vec3::Y);
        let a = self.vertex(positions[0], normal, uvs[0]);
        let b = self.vertex(positions[1], normal, uvs[1]);
        let c = self.vertex(positions[2], normal, uvs[2]);
        self.triangle(a, b, c);
    }

    /// Add a planar quad whose points already follow counter-clockwise order.
    #[allow(dead_code)]
    pub fn quad_flat(&mut self, positions: [Vec3; 4], uvs: [Vec2; 4]) {
        let normal = face_normal(positions[0], positions[1], positions[2], Vec3::Y);
        let base = self.vertices.len() as u32;
        for (position, uv) in positions.into_iter().zip(uvs) {
            self.vertices.push(model_vertex(position, normal, uv));
        }
        self.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }

    pub fn append(&mut self, mesh: &Mesh, transform: Mat4) {
        let transformed = mesh.transformed(transform);
        let base = self.vertices.len() as u32;
        self.vertices.extend_from_slice(&transformed.vertices);
        self.indices
            .extend(transformed.indices.into_iter().map(|index| base + index));
    }

    pub fn build(self) -> Mesh {
        Mesh::new(self.vertices, self.indices)
    }

    pub fn build_smooth(self) -> Mesh {
        self.build().smooth_shaded()
    }
}

/// Create a render instance while keeping placement separate from geometry.
pub fn instance(asset: &Arc<ModelAsset>, transform: Mat4, tint: [f32; 4]) -> ModelInstance {
    let mut instance = ModelInstance::new(asset.clone());
    instance.transform = transform;
    instance.tint = tint;
    instance
}

pub fn uv_sphere(radius: f32, rings: u32, segments: u32) -> Mesh {
    assert!(radius > 0.0, "sphere radius must be positive");
    let rings = rings.max(3);
    let segments = segments.max(3);
    let mut builder = MeshBuilder::with_capacity(
        ((rings + 1) * (segments + 1)) as usize,
        (rings * segments * 6) as usize,
    );

    for ring in 0..=rings {
        let v = ring as f32 / rings as f32;
        let phi = v * PI;
        let (sin_phi, cos_phi) = phi.sin_cos();
        for segment in 0..=segments {
            let u = segment as f32 / segments as f32;
            let theta = u * TAU;
            let (sin_theta, cos_theta) = theta.sin_cos();
            let normal = Vec3::new(sin_phi * cos_theta, cos_phi, sin_phi * sin_theta);
            builder.vertex(normal * radius, normal, Vec2::new(u, v));
        }
    }

    let stride = segments + 1;
    for ring in 0..rings {
        for segment in 0..segments {
            let a = ring * stride + segment;
            let b = a + 1;
            let c = a + stride;
            let d = c + 1;
            if ring != 0 {
                builder.triangle(a, b, c);
            }
            if ring + 1 != rings {
                builder.triangle(b, d, c);
            }
        }
    }
    builder.build()
}

#[allow(dead_code)]
pub fn unit_sphere(rings: u32, segments: u32) -> Mesh {
    uv_sphere(1.0, rings, segments)
}

pub fn icosphere(radius: f32, subdivisions: u32) -> Mesh {
    assert!(radius > 0.0, "icosphere radius must be positive");
    let golden = (1.0 + 5.0_f32.sqrt()) * 0.5;
    let mut positions = vec![
        Vec3::new(-1.0, golden, 0.0),
        Vec3::new(1.0, golden, 0.0),
        Vec3::new(-1.0, -golden, 0.0),
        Vec3::new(1.0, -golden, 0.0),
        Vec3::new(0.0, -1.0, golden),
        Vec3::new(0.0, 1.0, golden),
        Vec3::new(0.0, -1.0, -golden),
        Vec3::new(0.0, 1.0, -golden),
        Vec3::new(golden, 0.0, -1.0),
        Vec3::new(golden, 0.0, 1.0),
        Vec3::new(-golden, 0.0, -1.0),
        Vec3::new(-golden, 0.0, 1.0),
    ];
    for position in &mut positions {
        *position = position.normalize();
    }
    let mut faces = vec![
        [0, 11, 5],
        [0, 5, 1],
        [0, 1, 7],
        [0, 7, 10],
        [0, 10, 11],
        [1, 5, 9],
        [5, 11, 4],
        [11, 10, 2],
        [10, 7, 6],
        [7, 1, 8],
        [3, 9, 4],
        [3, 4, 2],
        [3, 2, 6],
        [3, 6, 8],
        [3, 8, 9],
        [4, 9, 5],
        [2, 4, 11],
        [6, 2, 10],
        [8, 6, 7],
        [9, 8, 1],
    ];
    orient_faces_outward(&positions, &mut faces);

    for _ in 0..subdivisions.min(5) {
        let mut midpoint_cache = HashMap::new();
        let mut refined = Vec::with_capacity(faces.len() * 4);
        for [a, b, c] in faces {
            let ab = midpoint(&mut positions, &mut midpoint_cache, a, b);
            let bc = midpoint(&mut positions, &mut midpoint_cache, b, c);
            let ca = midpoint(&mut positions, &mut midpoint_cache, c, a);
            refined.extend_from_slice(&[[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]);
        }
        faces = refined;
    }

    let vertices = positions
        .into_iter()
        .map(|normal| {
            let uv = spherical_uv(normal);
            model_vertex(normal * radius, normal, uv)
        })
        .collect();
    let indices = faces.into_iter().flatten().collect();
    Mesh::new(vertices, indices)
}

#[allow(dead_code)]
pub fn unit_icosphere(subdivisions: u32) -> Mesh {
    icosphere(1.0, subdivisions)
}

/// A faceted icosphere with stable seed-based radial displacement.
pub fn irregular_icosphere(radius: f32, subdivisions: u32, seed: u64, roughness: f32) -> Mesh {
    let mut mesh = icosphere(radius, subdivisions);
    let roughness = roughness.clamp(0.0, 0.8);
    let phase = hash01(seed, 0) * TAU;
    for (index, vertex) in mesh.vertices.iter_mut().enumerate() {
        let direction = Vec3::from(vertex.pos).normalize_or_zero();
        let broad = (direction.x * 3.7 + direction.y * 2.3 + phase).sin()
            * (direction.z * 4.1 - direction.y * 1.9 - phase * 0.7).cos();
        let grain = hash01(seed, index as u64 + 1) * 2.0 - 1.0;
        let scale = 1.0 + roughness * (broad * 0.62 + grain * 0.38);
        vertex.pos = (direction * radius * scale.max(0.35)).to_array();
    }
    mesh.flat_shaded()
}

/// A smooth-sided frustum extending from `y = 0` to `y = height`.
pub fn frustum(
    bottom_radius: f32,
    top_radius: f32,
    height: f32,
    segments: u32,
    capped: bool,
) -> Mesh {
    assert!(height > 0.0, "frustum height must be positive");
    assert!(
        bottom_radius >= 0.0 && top_radius >= 0.0,
        "frustum radii cannot be negative"
    );
    assert!(
        bottom_radius > 0.0 || top_radius > 0.0,
        "at least one frustum radius must be positive"
    );
    let segments = segments.max(3);
    let mut builder =
        MeshBuilder::with_capacity((segments * 4 + 6) as usize, 12 * segments as usize);
    let slope = (bottom_radius - top_radius) / height;
    let mut bottom = Vec::with_capacity((segments + 1) as usize);
    let mut top = Vec::with_capacity((segments + 1) as usize);

    for segment in 0..=segments {
        let u = segment as f32 / segments as f32;
        let theta = u * TAU;
        let (sin, cos) = theta.sin_cos();
        let normal = Vec3::new(cos, slope, sin).normalize();
        bottom.push(builder.vertex(
            Vec3::new(cos * bottom_radius, 0.0, sin * bottom_radius),
            normal,
            Vec2::new(u, 1.0),
        ));
        top.push(builder.vertex(
            Vec3::new(cos * top_radius, height, sin * top_radius),
            normal,
            Vec2::new(u, 0.0),
        ));
    }
    for segment in 0..segments as usize {
        if bottom_radius > f32::EPSILON {
            builder.triangle(bottom[segment], top[segment], bottom[segment + 1]);
        }
        if top_radius > f32::EPSILON {
            builder.triangle(bottom[segment + 1], top[segment], top[segment + 1]);
        }
    }

    if capped && bottom_radius > f32::EPSILON {
        add_cap(&mut builder, 0.0, bottom_radius, segments, false);
    }
    if capped && top_radius > f32::EPSILON {
        add_cap(&mut builder, height, top_radius, segments, true);
    }
    builder.build()
}

pub fn cylinder(radius: f32, height: f32, segments: u32) -> Mesh {
    frustum(radius, radius, height, segments, true)
}

pub fn cone(radius: f32, height: f32, segments: u32) -> Mesh {
    frustum(radius, 0.0, height, segments, true)
}

/// A single-sided horizontal disc with an upward-facing normal.
pub fn disc(radius: f32, segments: u32) -> Mesh {
    assert!(radius > 0.0, "disc radius must be positive");
    let segments = segments.max(3);
    let mut builder = MeshBuilder::with_capacity((segments + 2) as usize, (segments * 3) as usize);
    let center = builder.vertex(Vec3::ZERO, Vec3::Y, Vec2::splat(0.5));
    let mut rim = Vec::with_capacity((segments + 1) as usize);
    for segment in 0..=segments {
        let theta = segment as f32 / segments as f32 * TAU;
        let (sin, cos) = theta.sin_cos();
        rim.push(builder.vertex(
            Vec3::new(cos * radius, 0.0, sin * radius),
            Vec3::Y,
            Vec2::new(cos, sin) * 0.5 + Vec2::splat(0.5),
        ));
    }
    for segment in 0..segments as usize {
        builder.triangle(center, rim[segment + 1], rim[segment]);
    }
    builder.build()
}

/// A tessellated XZ patch. The height callback receives local `(x, z)`.
pub fn terrain_patch(size: Vec2, cells: [u32; 2], mut height_at: impl FnMut(Vec2) -> f32) -> Mesh {
    assert!(
        size.x > 0.0 && size.y > 0.0,
        "terrain size must be positive"
    );
    let cells_x = cells[0].max(1);
    let cells_z = cells[1].max(1);
    let mut builder = MeshBuilder::with_capacity(
        ((cells_x + 1) * (cells_z + 1)) as usize,
        (cells_x * cells_z * 6) as usize,
    );
    for z in 0..=cells_z {
        let v = z as f32 / cells_z as f32;
        for x in 0..=cells_x {
            let u = x as f32 / cells_x as f32;
            let local = Vec2::new((u - 0.5) * size.x, (v - 0.5) * size.y);
            builder.vertex(
                Vec3::new(local.x, height_at(local), local.y),
                Vec3::Y,
                Vec2::new(u, v),
            );
        }
    }
    let stride = cells_x + 1;
    for z in 0..cells_z {
        for x in 0..cells_x {
            let a = z * stride + x;
            let b = a + 1;
            let c = a + stride;
            let d = c + 1;
            builder.triangle(a, c, b);
            builder.triangle(b, c, d);
        }
    }
    builder.build_smooth()
}

#[allow(dead_code)]
pub fn plane(size: Vec2, cells: [u32; 2]) -> Mesh {
    terrain_patch(size, cells, |_| 0.0)
}

/// Several double-sided tapered blades. It is suitable for opaque tinting and
/// does not require alpha blending or a cutout texture.
#[allow(dead_code)]
pub fn grass_tuft(radius: f32, height: f32, blades: u32) -> Mesh {
    grass_tuft_seeded(radius, height, blades, 0)
}

pub fn grass_tuft_seeded(radius: f32, height: f32, blades: u32, seed: u64) -> Mesh {
    assert!(
        radius > 0.0 && height > 0.0,
        "grass dimensions must be positive"
    );
    let blades = blades.max(3);
    let mut builder = MeshBuilder::with_capacity((blades * 18) as usize, (blades * 18) as usize);
    for blade in 0..blades {
        let random_a = hash01(seed, blade as u64 * 4 + 1);
        let random_b = hash01(seed, blade as u64 * 4 + 2);
        let random_c = hash01(seed, blade as u64 * 4 + 3);
        let angle = blade as f32 / blades as f32 * TAU + (random_a - 0.5) * 0.8;
        let (sin, cos) = angle.sin_cos();
        let root_radius = radius * 0.66 * random_b.sqrt();
        let root = Vec3::new(cos * root_radius, 0.0, sin * root_radius);
        let across = Vec3::new(cos, 0.0, sin);
        let bend = Vec3::new(-sin, 0.0, cos) * radius * (random_c - 0.35) * 0.7;
        let blade_height = height * (0.72 + random_a * 0.34);
        let half_width = radius * (0.07 + random_b * 0.065);
        let shoulder = root + Vec3::Y * blade_height * 0.62 + bend * 0.35;
        let tip = root + Vec3::Y * blade_height + bend;
        let left = root - across * half_width;
        let right = root + across * half_width;
        let upper_left = shoulder - across * half_width * 0.58;
        let upper_right = shoulder + across * half_width * 0.58;

        add_double_sided_triangle(
            &mut builder,
            [left, right, upper_right],
            [
                Vec2::new(0.0, 1.0),
                Vec2::new(1.0, 1.0),
                Vec2::new(1.0, 0.38),
            ],
        );
        add_double_sided_triangle(
            &mut builder,
            [left, upper_right, upper_left],
            [
                Vec2::new(0.0, 1.0),
                Vec2::new(1.0, 0.38),
                Vec2::new(0.0, 0.38),
            ],
        );
        add_double_sided_triangle(
            &mut builder,
            [upper_left, upper_right, tip],
            [
                Vec2::new(0.0, 0.38),
                Vec2::new(1.0, 0.38),
                Vec2::new(0.5, 0.0),
            ],
        );
    }
    builder.build()
}

/// A grounded, flat-shaded rock with deterministic asymmetry.
pub fn rock(radius: f32, seed: u64) -> Mesh {
    let mut mesh = irregular_icosphere(radius, 1, seed, 0.28);
    for vertex in &mut mesh.vertices {
        let mut point = Vec3::from(vertex.pos);
        point.x *= 0.92 + hash01(seed, 31) * 0.26;
        point.z *= 0.86 + hash01(seed, 32) * 0.34;
        point.y *= 0.68 + hash01(seed, 33) * 0.16;
        vertex.pos = point.to_array();
    }
    let min_y = mesh
        .vertices
        .iter()
        .map(|vertex| vertex.pos[1])
        .fold(f32::INFINITY, f32::min);
    for vertex in &mut mesh.vertices {
        vertex.pos[1] -= min_y;
    }
    mesh.flat_shaded()
}

/// A broad crown assembled from overlapping, seed-varied faceted lobes.
pub fn tree_canopy(radius: f32, seed: u64) -> Mesh {
    assert!(radius > 0.0, "canopy radius must be positive");
    let lobes = [
        (
            Vec3::new(0.0, 0.08, 0.0),
            Vec3::new(0.95, 0.84, 0.92),
            0_u64,
        ),
        (
            Vec3::new(-0.48, -0.08, 0.03),
            Vec3::new(0.70, 0.65, 0.72),
            1,
        ),
        (Vec3::new(0.45, -0.05, 0.10), Vec3::new(0.73, 0.68, 0.66), 2),
        (Vec3::new(0.05, -0.10, 0.44), Vec3::new(0.68, 0.64, 0.70), 3),
        (
            Vec3::new(-0.08, 0.02, -0.40),
            Vec3::new(0.65, 0.70, 0.68),
            4,
        ),
        (Vec3::new(0.02, 0.40, -0.02), Vec3::new(0.64, 0.58, 0.62), 5),
    ];
    let mut builder = MeshBuilder::new();
    for (offset, scale, salt) in lobes {
        let jitter = Vec3::new(
            hash_signed(seed, salt * 3 + 10),
            hash_signed(seed, salt * 3 + 11),
            hash_signed(seed, salt * 3 + 12),
        ) * 0.055;
        let lobe = irregular_icosphere(radius, 1, seed ^ ((salt + 1) * 0x9e37_79b9), 0.16);
        builder.append(
            &lobe,
            Mat4::from_scale_rotation_translation(
                scale,
                pocket3d::glam::Quat::IDENTITY,
                (offset + jitter) * radius,
            ),
        );
    }
    builder.build()
}

/// Generate a small repeatable RGBA texture from a palette. Coarse cells and
/// fine grain keep terrain variation visible without imported image assets.
pub fn palette_texture(width: u32, height: u32, seed: u64, palette: &[[u8; 4]]) -> Vec<u8> {
    assert!(
        width > 0 && height > 0,
        "texture dimensions must be non-zero"
    );
    assert!(!palette.is_empty(), "texture palette must not be empty");
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let coarse = hash01(seed, ((x / 6) as u64) | (((y / 6) as u64) << 32));
            let grain = hash01(seed ^ 0xa24b_aed4_963e_e407, x as u64 | ((y as u64) << 32));
            let value = (coarse * 0.72 + grain * 0.28).min(0.999_999);
            let index = (value * palette.len() as f32) as usize;
            pixels.extend_from_slice(&palette[index]);
        }
    }
    pixels
}

fn model_vertex(position: Vec3, normal: Vec3, uv: Vec2) -> ModelVertex {
    ModelVertex {
        pos: position.to_array(),
        normal: normal.normalize_or_zero().to_array(),
        uv: uv.to_array(),
        joints: [0; 4],
        weights: [1.0, 0.0, 0.0, 0.0],
    }
}

fn normalize_or(normal: Vec3, fallback: Vec3, transform: Mat3) -> [f32; 3] {
    let transformed = transform * normal;
    if transformed.is_finite() && transformed.length_squared() > NORMAL_EPSILON {
        transformed.normalize().to_array()
    } else {
        fallback.to_array()
    }
}

fn face_normal(a: Vec3, b: Vec3, c: Vec3, fallback: Vec3) -> Vec3 {
    let normal = (b - a).cross(c - a);
    if normal.is_finite() && normal.length_squared() > NORMAL_EPSILON {
        normal.normalize()
    } else if fallback.length_squared() > NORMAL_EPSILON {
        fallback.normalize()
    } else {
        Vec3::Y
    }
}

fn spherical_uv(direction: Vec3) -> Vec2 {
    Vec2::new(
        0.5 + direction.z.atan2(direction.x) / TAU,
        0.5 - direction.y.clamp(-1.0, 1.0).asin() / PI,
    )
}

fn orient_faces_outward(positions: &[Vec3], faces: &mut [[u32; 3]]) {
    for face in faces {
        let a = positions[face[0] as usize];
        let b = positions[face[1] as usize];
        let c = positions[face[2] as usize];
        if (b - a).cross(c - a).dot(a + b + c) < 0.0 {
            face.swap(1, 2);
        }
    }
}

fn midpoint(
    positions: &mut Vec<Vec3>,
    cache: &mut HashMap<(u32, u32), u32>,
    a: u32,
    b: u32,
) -> u32 {
    let edge = if a < b { (a, b) } else { (b, a) };
    if let Some(&index) = cache.get(&edge) {
        return index;
    }
    let point = (positions[a as usize] + positions[b as usize]).normalize();
    let index = positions.len() as u32;
    positions.push(point);
    cache.insert(edge, index);
    index
}

fn add_cap(builder: &mut MeshBuilder, y: f32, radius: f32, segments: u32, top: bool) {
    let normal = if top { Vec3::Y } else { Vec3::NEG_Y };
    let center = builder.vertex(Vec3::new(0.0, y, 0.0), normal, Vec2::splat(0.5));
    let mut rim = Vec::with_capacity((segments + 1) as usize);
    for segment in 0..=segments {
        let theta = segment as f32 / segments as f32 * TAU;
        let (sin, cos) = theta.sin_cos();
        rim.push(builder.vertex(
            Vec3::new(cos * radius, y, sin * radius),
            normal,
            Vec2::new(cos, sin) * 0.5 + Vec2::splat(0.5),
        ));
    }
    for segment in 0..segments as usize {
        if top {
            builder.triangle(center, rim[segment + 1], rim[segment]);
        } else {
            builder.triangle(center, rim[segment], rim[segment + 1]);
        }
    }
}

fn add_double_sided_triangle(builder: &mut MeshBuilder, positions: [Vec3; 3], uvs: [Vec2; 3]) {
    builder.triangle_flat(positions, uvs);
    builder.triangle_flat(
        [positions[2], positions[1], positions[0]],
        [uvs[2], uvs[1], uvs[0]],
    );
}

fn hash01(seed: u64, stream: u64) -> f32 {
    let mut value = seed ^ stream.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    ((value >> 40) as u32) as f32 / (1_u32 << 24) as f32
}

fn hash_signed(seed: u64, stream: u64) -> f32 {
    hash01(seed, stream) * 2.0 - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_valid(mesh: &Mesh) {
        mesh.validate().unwrap();
        for triangle in mesh.indices.as_chunks::<3>().0 {
            let a = Vec3::from(mesh.vertices[triangle[0] as usize].pos);
            let b = Vec3::from(mesh.vertices[triangle[1] as usize].pos);
            let c = Vec3::from(mesh.vertices[triangle[2] as usize].pos);
            assert!((b - a).cross(c - a).length_squared() > NORMAL_EPSILON);
        }
    }

    fn assert_outward(mesh: &Mesh, centre: Vec3) {
        for triangle in mesh.indices.as_chunks::<3>().0 {
            let a = Vec3::from(mesh.vertices[triangle[0] as usize].pos);
            let b = Vec3::from(mesh.vertices[triangle[1] as usize].pos);
            let c = Vec3::from(mesh.vertices[triangle[2] as usize].pos);
            let normal = (b - a).cross(c - a);
            let centroid = (a + b + c) / 3.0;
            assert!(normal.dot(centroid - centre) > 0.0);
        }
    }

    fn assert_front_faces_match_vertex_normals(mesh: &Mesh) {
        for triangle in mesh.indices.as_chunks::<3>().0 {
            let vertices = [
                mesh.vertices[triangle[0] as usize],
                mesh.vertices[triangle[1] as usize],
                mesh.vertices[triangle[2] as usize],
            ];
            let a = Vec3::from(vertices[0].pos);
            let b = Vec3::from(vertices[1].pos);
            let c = Vec3::from(vertices[2].pos);
            let geometric = (b - a).cross(c - a).normalize();
            let authored = vertices
                .iter()
                .map(|vertex| Vec3::from(vertex.normal))
                .fold(Vec3::ZERO, |sum, normal| sum + normal)
                .normalize_or_zero();
            assert!(geometric.dot(authored) > 0.25);
        }
    }

    #[test]
    fn sphere_and_icosphere_are_closed_and_outward() {
        let sphere = uv_sphere(1.0, 8, 12);
        assert_valid(&sphere);
        assert_outward(&sphere, Vec3::ZERO);

        let ico = icosphere(1.0, 2);
        assert_valid(&ico);
        assert_eq!(ico.triangle_count(), 320);
        assert_outward(&ico, Vec3::ZERO);
    }

    #[test]
    fn flat_shading_splits_shared_vertices() {
        let smooth = icosphere(1.0, 1);
        let flat = smooth.flat_shaded();
        assert_valid(&flat);
        assert_eq!(flat.vertices.len(), flat.indices.len());
        assert_eq!(flat.triangle_count(), smooth.triangle_count());
    }

    #[test]
    fn terrain_normals_face_up() {
        let terrain = terrain_patch(Vec2::new(8.0, 6.0), [8, 6], |point| {
            (point.x * 0.3).sin() * (point.y * 0.2).cos() * 0.25
        });
        assert_valid(&terrain);
        assert!(
            terrain
                .vertices
                .iter()
                .all(|vertex| Vec3::from(vertex.normal).y > 0.0)
        );
        assert_eq!(terrain.triangle_count(), 8 * 6 * 2);
    }

    #[test]
    fn grounded_primitives_do_not_cross_ground() {
        for mesh in [
            cylinder(0.4, 1.2, 12),
            cone(0.4, 1.2, 12),
            rock(0.8, 7),
            grass_tuft_seeded(0.5, 0.9, 7, 11),
        ] {
            assert_valid(&mesh);
            assert_front_faces_match_vertex_normals(&mesh);
            let (min, _) = mesh.bounds().unwrap();
            assert!(min.y >= -1.0e-5);
        }
    }

    #[test]
    fn seeded_art_is_reproducible() {
        let a = rock(1.0, 42);
        let b = rock(1.0, 42);
        let c = rock(1.0, 43);
        assert_eq!(a.vertices[0].pos, b.vertices[0].pos);
        assert_ne!(a.vertices[0].pos, c.vertices[0].pos);

        let texture_a = palette_texture(16, 16, 9, &[[10, 20, 30, 255], [40, 50, 60, 255]]);
        let texture_b = palette_texture(16, 16, 9, &[[10, 20, 30, 255], [40, 50, 60, 255]]);
        assert_eq!(texture_a, texture_b);
    }

    #[test]
    fn transformed_mesh_preserves_valid_winding_under_mirroring() {
        let original = icosphere(1.0, 0);
        let mirrored = original.transformed(Mat4::from_scale(Vec3::new(-2.0, 1.0, 0.5)));
        assert_valid(&mirrored);
        assert_outward(&mirrored, Vec3::ZERO);
    }
}
