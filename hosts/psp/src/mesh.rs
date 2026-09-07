//! Immutable GE vertex buffers; native mesh handles own residency. Retired
//! vertices survive until the previous display list completes.
use alloc::vec::Vec;
use core::ffi::c_void;
use pocketjs_core::Ui;
use psp::sys::{
    self, GuPrimitive, GuState, MatrixMode, ScePspFMatrix4, ScePspFVector4, VertexType,
};
#[repr(C, align(16))]
#[derive(Clone, Copy)]
struct Vertex {
    color: u32,
    x: f32,
    y: f32,
    z: f32,
}
struct Buffer {
    handle: i32,
    vertices: Vec<Vertex>,
}
static mut LIVE: [Option<Buffer>; 128] = [const { None }; 128];
static mut RETIRED: Vec<Buffer> = Vec::new();
static mut BYTES: usize = 0;
fn allocation_bytes(count: usize) -> usize {
    if count == 0 {
        0
    } else {
        (count * 16).max(16).next_power_of_two()
    }
}
const MAX_BYTES: usize = 4 * 1024 * 1024;
pub unsafe fn reset() {
    for slot in &mut LIVE {
        *slot = None;
    }
    RETIRED.clear();
    BYTES = 0;
}
pub unsafe fn retire() {
    for b in RETIRED.drain(..) {
        BYTES -= allocation_bytes(b.vertices.capacity());
    }
}
pub unsafe fn free(ui: &mut Ui, handle: i32) {
    if handle < 0 {
        return;
    }
    let i = (handle as usize) & 127;
    if LIVE[i].as_ref().map(|b| b.handle) == Some(handle) {
        RETIRED.push(LIVE[i].take().unwrap());
    }
    ui.free_mesh(handle);
}
pub unsafe fn upload(ui: &mut Ui, bytes: &[u8]) -> i32 {
    let handle = ui.upload_mesh(bytes);
    if handle < 0 {
        return -1;
    }
    let m = ui.mesh(handle).unwrap();
    let count = m.triangles.len() * 3;
    if BYTES + allocation_bytes(count) > MAX_BYTES {
        ui.free_mesh(handle);
        return -1;
    }
    let mut vertices = Vec::with_capacity(count);
    for t in &m.triangles {
        for &id in &t.indices {
            let p = m.vertices[id as usize];
            vertices.push(Vertex {
                color: t.color,
                x: p[0] as f32 / 16.0,
                y: p[1] as f32 / 16.0,
                z: 0.0,
            });
        }
    }
    sys::sceKernelDcacheWritebackRange(
        vertices.as_ptr() as *const c_void,
        (vertices.len() * 16) as u32,
    );
    BYTES += allocation_bytes(vertices.capacity());
    LIVE[(handle as usize) & 127] = Some(Buffer { handle, vertices });
    handle
}
fn matrix(a: [[f32; 4]; 4]) -> ScePspFMatrix4 {
    ScePspFMatrix4 {
        x: ScePspFVector4 {
            x: a[0][0],
            y: a[0][1],
            z: a[0][2],
            w: a[0][3],
        },
        y: ScePspFVector4 {
            x: a[1][0],
            y: a[1][1],
            z: a[1][2],
            w: a[1][3],
        },
        z: ScePspFVector4 {
            x: a[2][0],
            y: a[2][1],
            z: a[2][2],
            w: a[2][3],
        },
        w: ScePspFVector4 {
            x: a[3][0],
            y: a[3][1],
            z: a[3][2],
            w: a[3][3],
        },
    }
}
pub unsafe fn draw(words: &[u32]) {
    let handle = words[1] as i32;
    if handle < 0 {
        return;
    }
    let Some(b) = &LIVE[(handle as usize) & 127] else {
        return;
    };
    if b.handle != handle || b.vertices.is_empty() {
        return;
    }
    let a = f32::from_bits(words[2]);
    let by = f32::from_bits(words[3]);
    let c = f32::from_bits(words[4]);
    let d = f32::from_bits(words[5]);
    let tx = f32::from_bits(words[6]);
    let ty = f32::from_bits(words[7]);
    let x = (words[8] as u16) as i16 as i32;
    let y = ((words[8] >> 16) as u16) as i16 as i32;
    let w = (words[9] & 65535) as i32;
    let h = (words[9] >> 16) as i32;
    sys::sceGuScissor(x.max(0), y.max(0), (x + w).min(480), (y + h).min(272));
    sys::sceGuDisable(GuState::Texture2D);
    sys::sceGuDisable(GuState::DepthTest);
    sys::sceGuDisable(GuState::CullFace);
    let projection = matrix([
        [2.0 / 480.0, 0.0, 0.0, 0.0],
        [0.0, -2.0 / 272.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [-1.0, 1.0, 0.0, 1.0],
    ]);
    let identity = matrix([
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let model = matrix([
        [a, by, 0.0, 0.0],
        [c, d, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [tx, ty, 0.0, 1.0],
    ]);
    sys::sceGuSetMatrix(MatrixMode::Projection, &projection);
    sys::sceGuSetMatrix(MatrixMode::View, &identity);
    sys::sceGuSetMatrix(MatrixMode::Model, &model);
    let vtype = VertexType::from_bits_truncate(
        VertexType::COLOR_8888.bits()
            | VertexType::VERTEX_32BITF.bits()
            | VertexType::TRANSFORM_3D.bits(),
    );
    sys::sceGuDrawArray(
        GuPrimitive::Triangles,
        vtype,
        b.vertices.len() as i32,
        core::ptr::null(),
        b.vertices.as_ptr() as *const c_void,
    );
    sys::sceGuScissor(0, 0, 480, 272);
}
