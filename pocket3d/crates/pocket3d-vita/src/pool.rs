//! Per-frame CPU triangle queue and vita2d-pool submission.

use core::cmp::Ordering;

use glam::{Mat4, Vec2, Vec3, Vec4};
use vita2d_sys as v2d;

use crate::{SCREEN_HEIGHT, SCREEN_WIDTH};

const MAX_DRAW_VERTICES: usize = 65_535;
const BACKDROP_LAYER: i16 = i16::MIN;

#[derive(Clone, Copy, Debug)]
struct ClipVertex {
    clip: Vec4,
    uv: Vec2,
    color: Vec4,
}

impl ClipVertex {
    const ZERO: Self = Self {
        clip: Vec4::ZERO,
        uv: Vec2::ZERO,
        color: Vec4::ZERO,
    };

    fn interpolate(self, other: Self, amount: f32) -> Self {
        Self {
            clip: self.clip.lerp(other.clip, amount),
            uv: self.uv.lerp(other.uv, amount),
            color: self.color.lerp(other.color, amount),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ScreenVertex {
    x: f32,
    y: f32,
    u: f32,
    v: f32,
    color: u32,
}

#[derive(Clone, Copy, Debug)]
enum Material {
    Color,
    Textured {
        texture: *const v2d::vita2d_texture,
        tint: u32,
    },
}

impl Material {
    fn same_batch(self, other: Self) -> bool {
        match (self, other) {
            (Self::Color, Self::Color) => true,
            (
                Self::Textured {
                    texture: a_texture,
                    tint: a_tint,
                },
                Self::Textured {
                    texture: b_texture,
                    tint: b_tint,
                },
            ) => a_texture == b_texture && a_tint == b_tint,
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct QueuedTriangle {
    vertices: [ScreenVertex; 3],
    material: Material,
    /// OpenGL NDC depth: +1 is far and -1 is near.
    depth: f32,
    /// Later layers intentionally overlay earlier layers (viewmodels).
    layer: i16,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FrameStats {
    pub triangles: u32,
    pub draw_calls: u32,
    pub dropped_triangles: u32,
}

/// CPU staging retained across frames. Call [`FramePool::reset`] after the
/// previous vita2d scene has completed and before [`crate::begin_3d`].
pub struct FramePool {
    triangles: Vec<QueuedTriangle>,
    pub last: FrameStats,
}

impl FramePool {
    pub const fn new() -> Self {
        Self {
            triangles: Vec::new(),
            last: FrameStats {
                triangles: 0,
                draw_calls: 0,
                dropped_triangles: 0,
            },
        }
    }

    pub fn reset(&mut self) {
        self.triangles.clear();
        self.last = FrameStats::default();
    }

    pub fn reserve_triangles(&mut self, additional: usize) {
        self.triangles.reserve(additional);
    }

    pub(crate) fn queue_world_triangle(
        &mut self,
        view_proj: Mat4,
        positions: [Vec3; 3],
        uvs: [Vec2; 3],
        colors: [u32; 3],
        texture: *const v2d::vita2d_texture,
        layer: i16,
    ) {
        let mut input = [ClipVertex::ZERO; 3];
        for index in 0..3 {
            input[index] = ClipVertex {
                clip: view_proj * positions[index].extend(1.0),
                uv: uvs[index],
                color: unpack_abgr(colors[index]),
            };
        }
        self.queue_clipped(input, Some(texture), layer);
    }

    pub(crate) fn queue_color_triangle(
        &mut self,
        transform: Mat4,
        positions: [Vec3; 3],
        colors: [u32; 3],
        layer: i16,
    ) {
        let mut input = [ClipVertex::ZERO; 3];
        for index in 0..3 {
            input[index] = ClipVertex {
                clip: transform * positions[index].extend(1.0),
                uv: Vec2::ZERO,
                color: unpack_abgr(colors[index]),
            };
        }
        self.queue_clipped(input, None, layer);
    }

    pub(crate) fn queue_backdrop_triangle(&mut self, positions: [[f32; 2]; 3], colors: [u32; 3]) {
        let mut vertices = [ScreenVertex {
            x: 0.0,
            y: 0.0,
            u: 0.0,
            v: 0.0,
            color: 0,
        }; 3];
        for index in 0..3 {
            vertices[index] = ScreenVertex {
                x: positions[index][0],
                y: positions[index][1],
                u: 0.0,
                v: 0.0,
                color: colors[index],
            };
        }
        self.triangles.push(QueuedTriangle {
            vertices,
            material: Material::Color,
            depth: 1.0,
            layer: BACKDROP_LAYER,
        });
    }

    fn queue_clipped(
        &mut self,
        triangle: [ClipVertex; 3],
        texture: Option<*const v2d::vita2d_texture>,
        layer: i16,
    ) {
        let mut input = [ClipVertex::ZERO; 12];
        let mut output = [ClipVertex::ZERO; 12];
        input[..3].copy_from_slice(&triangle);
        let mut count = 3usize;

        for plane in 0..6 {
            if count == 0 {
                return;
            }
            let mut output_count = 0usize;
            let mut previous = input[count - 1];
            let mut previous_distance = clip_distance(previous.clip, plane);
            let mut previous_inside = previous_distance >= 0.0;

            for current in input[..count].iter().copied() {
                let current_distance = clip_distance(current.clip, plane);
                let current_inside = current_distance >= 0.0;
                if current_inside != previous_inside {
                    let denominator = previous_distance - current_distance;
                    if denominator.abs() > f32::EPSILON {
                        let amount = (previous_distance / denominator).clamp(0.0, 1.0);
                        output[output_count] = previous.interpolate(current, amount);
                        output_count += 1;
                    }
                }
                if current_inside {
                    output[output_count] = current;
                    output_count += 1;
                }
                previous = current;
                previous_distance = current_distance;
                previous_inside = current_inside;
            }
            core::mem::swap(&mut input, &mut output);
            count = output_count;
        }

        if count < 3 {
            return;
        }
        for index in 1..count - 1 {
            let clipped = [input[0], input[index], input[index + 1]];
            if clipped.iter().any(|vertex| vertex.clip.w <= 1.0e-5) {
                continue;
            }

            let mut screen = [ScreenVertex {
                x: 0.0,
                y: 0.0,
                u: 0.0,
                v: 0.0,
                color: 0,
            }; 3];
            let mut depth = 0.0;
            let mut tint = Vec4::ZERO;
            for vertex in 0..3 {
                let inverse_w = clipped[vertex].clip.w.recip();
                let ndc = clipped[vertex].clip * inverse_w;
                screen[vertex] = ScreenVertex {
                    x: (ndc.x * 0.5 + 0.5) * SCREEN_WIDTH,
                    y: (0.5 - ndc.y * 0.5) * SCREEN_HEIGHT,
                    u: clipped[vertex].uv.x,
                    v: clipped[vertex].uv.y,
                    color: pack_abgr(clipped[vertex].color),
                };
                depth += ndc.z;
                tint += clipped[vertex].color;
            }
            if screen.iter().any(|vertex| {
                !vertex.x.is_finite()
                    || !vertex.y.is_finite()
                    || !vertex.u.is_finite()
                    || !vertex.v.is_finite()
            }) {
                continue;
            }
            let signed_area = (screen[1].x - screen[0].x) * (screen[2].y - screen[0].y)
                - (screen[1].y - screen[0].y) * (screen[2].x - screen[0].x);
            if signed_area.abs() < 0.01 {
                continue;
            }

            let material = match texture {
                Some(texture) if !texture.is_null() => Material::Textured {
                    texture,
                    tint: pack_abgr(tint / 3.0),
                },
                _ => Material::Color,
            };
            self.triangles.push(QueuedTriangle {
                vertices: screen,
                material,
                depth: depth / 3.0,
                layer,
            });
        }
    }

    pub(crate) unsafe fn flush(&mut self) {
        self.triangles.sort_by(|left, right| {
            left.layer.cmp(&right.layer).then_with(|| {
                right
                    .depth
                    .partial_cmp(&left.depth)
                    .unwrap_or(Ordering::Equal)
            })
        });

        let mut stats = FrameStats {
            triangles: self.triangles.len() as u32,
            draw_calls: 0,
            dropped_triangles: 0,
        };
        let mut start = 0usize;
        while start < self.triangles.len() {
            let material = self.triangles[start].material;
            let maximum_end = (start + MAX_DRAW_VERTICES / 3).min(self.triangles.len());
            let mut end = start + 1;
            while end < maximum_end && material.same_batch(self.triangles[end].material) {
                end += 1;
            }

            let submitted = match material {
                Material::Color => submit_color(&self.triangles[start..end]),
                Material::Textured { texture, tint } => {
                    submit_textured(&self.triangles[start..end], texture, tint)
                }
            };
            if submitted {
                stats.draw_calls += 1;
            } else {
                stats.dropped_triangles += (end - start) as u32;
            }
            start = end;
        }
        self.last = stats;
        self.triangles.clear();
    }
}

impl Default for FramePool {
    fn default() -> Self {
        Self::new()
    }
}

fn clip_distance(vertex: Vec4, plane: usize) -> f32 {
    match plane {
        0 => vertex.x + vertex.w,
        1 => vertex.w - vertex.x,
        2 => vertex.y + vertex.w,
        3 => vertex.w - vertex.y,
        4 => vertex.z + vertex.w,
        5 => vertex.w - vertex.z,
        _ => unreachable!(),
    }
}

fn unpack_abgr(color: u32) -> Vec4 {
    Vec4::new(
        (color & 0xff) as f32 / 255.0,
        ((color >> 8) & 0xff) as f32 / 255.0,
        ((color >> 16) & 0xff) as f32 / 255.0,
        ((color >> 24) & 0xff) as f32 / 255.0,
    )
}

fn pack_abgr(color: Vec4) -> u32 {
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
    channel(color.x) | (channel(color.y) << 8) | (channel(color.z) << 16) | (channel(color.w) << 24)
}

#[cfg(target_os = "vita")]
unsafe fn submit_color(triangles: &[QueuedTriangle]) -> bool {
    let count = triangles.len() * 3;
    let bytes = count * core::mem::size_of::<v2d::vita2d_color_vertex>();
    let destination = v2d::vita2d_pool_memalign(
        bytes as u32,
        core::mem::size_of::<v2d::vita2d_color_vertex>() as u32,
    )
    .cast::<v2d::vita2d_color_vertex>();
    if destination.is_null() {
        return false;
    }
    for (index, vertex) in triangles
        .iter()
        .flat_map(|triangle| triangle.vertices.iter())
        .enumerate()
    {
        destination.add(index).write(v2d::vita2d_color_vertex {
            x: vertex.x,
            y: vertex.y,
            z: 0.5,
            color: vertex.color,
        });
    }
    v2d::vita2d_draw_array(
        v2d::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
        destination,
        count,
    );
    true
}

#[cfg(not(target_os = "vita"))]
unsafe fn submit_color(_triangles: &[QueuedTriangle]) -> bool {
    true
}

#[cfg(target_os = "vita")]
unsafe fn submit_textured(
    triangles: &[QueuedTriangle],
    texture: *const v2d::vita2d_texture,
    tint: u32,
) -> bool {
    if texture.is_null() {
        return false;
    }
    let count = triangles.len() * 3;
    let bytes = count * core::mem::size_of::<v2d::vita2d_texture_vertex>();
    let destination = v2d::vita2d_pool_memalign(
        bytes as u32,
        core::mem::size_of::<v2d::vita2d_texture_vertex>() as u32,
    )
    .cast::<v2d::vita2d_texture_vertex>();
    if destination.is_null() {
        return false;
    }
    for (index, vertex) in triangles
        .iter()
        .flat_map(|triangle| triangle.vertices.iter())
        .enumerate()
    {
        destination.add(index).write(v2d::vita2d_texture_vertex {
            x: vertex.x,
            y: vertex.y,
            z: 0.5,
            u: vertex.u,
            v: vertex.v,
        });
    }
    v2d::vita2d_draw_array_textured(
        texture,
        v2d::SceGxmPrimitiveType_SCE_GXM_PRIMITIVE_TRIANGLES,
        destination,
        count,
        tint,
    );
    true
}

#[cfg(not(target_os = "vita"))]
unsafe fn submit_textured(
    _triangles: &[QueuedTriangle],
    _texture: *const v2d::vita2d_texture,
    _tint: u32,
) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_a_triangle_crossing_the_near_plane() {
        let mut pool = FramePool::new();
        pool.queue_color_triangle(
            Mat4::IDENTITY,
            [
                Vec3::new(-0.5, -0.5, 0.0),
                Vec3::new(0.5, -0.5, 0.0),
                Vec3::new(0.0, 0.5, -2.0),
            ],
            [0xffff_ffff; 3],
            0,
        );
        assert_eq!(pool.triangles.len(), 2);
        assert!(pool.triangles.iter().all(|triangle| triangle
            .vertices
            .iter()
            .all(|vertex| vertex.x >= 0.0 && vertex.x <= SCREEN_WIDTH)));
    }

    #[test]
    fn rejects_fully_offscreen_triangle() {
        let mut pool = FramePool::new();
        pool.queue_color_triangle(
            Mat4::IDENTITY,
            [
                Vec3::new(2.0, 0.0, 0.0),
                Vec3::new(3.0, 0.0, 0.0),
                Vec3::new(2.0, 1.0, 0.0),
            ],
            [0xffff_ffff; 3],
            0,
        );
        assert!(pool.triangles.is_empty());
    }

    #[test]
    fn abgr_roundtrip_is_exact() {
        let color = 0x7f12_34fe;
        assert_eq!(pack_abgr(unpack_abgr(color)), color);
    }
}
