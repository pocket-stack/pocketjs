# Pocket3D animation and rigid meshes

**`no_std` + `alloc` skeletal sampling** is shared by desktop Pocket3D and native
handheld consumers. `pocket3d::anim` re-exports the same public types, preserving
its existing import path. The crate has no window, GPU, character, controller,
expression, chat or application lifecycle dependency.

`Skeleton` samples linear/step TRS channels into reusable local/global buffers.
Parents precede children in its evaluation order. Callers own fixed-step timing,
clip selection, transitions, interpolation and procedural pose edits. Directly
constructed channels and skeletons must have valid key widths and node indices.

`mesh::MeshAsset` decodes **P3M1**, a bounded colored rigid-mesh profile. Its
`skin_matrices` produces row-major 3-by-4 affine matrices. `rigid_mesh` produces
40-byte unique vertices, u16 indices and immutable visibility ranges for native
backends. A vertex belongs to one joint. Zero affine matrices hide joints;
triangles with three hidden influences are omitted. The PICA backend supports
29 joints per draw; the file format allows 256 nodes and other backends can
consume the decoded geometry without the PICA palette limit.

The CPU `skin` reference takes an explicit `DirectionalLight`; the caller owns
light direction and ambient/diffuse factors. Output and rigid vertex material
factors use a gamma-2 transfer. Normals use the affine linear part followed by
normalization; this profile assumes rigid transforms or uniform scale.

## P3M1 encoding

Numbers are little endian. Coordinates use metres, +Y up and +Z forward. Asset
vertices are in bind space. The node rest hierarchy determines inverse binds.

| Record | Contents |
| --- | --- |
| Header | `P3M1`, u32 node/vertex/index/clip counts |
| Node | u16 UTF-8 name length + name, u32 parent (`0xffffffff` for root), f32 translation[3], quaternion XYZW[4], scale[3] |
| Vertex | f32 position[3], normal[3], linear RGB[3], u16 joint |
| Indices | u32 triangle indices |
| Clip | name, f32 duration, u32 channel count |
| Channel | u16 node, u8 path (0 translation, 1 rotation, 2 scale), u16 key count |
| Key | f32 time, f32 value[3 or 4] |

P3M1 channels interpolate linearly; the in-memory sampler also supports step
channels. Decoder limits are 32 MiB, 256 nodes, 100,000 vertices, 300,000 indices,
64 clips, 128 bytes per name and 500,000 keys across the asset. Parents must
precede children. Times must increase within a channel and fit its clip.
Nonfinite values, invalid rotations/scales/colors/indices, truncated input and
trailing bytes are rejected before returning an asset.

Run `cargo test --locked --manifest-path engine/Cargo.toml -p pocket3d-anim`.
Tests generate prop geometry and distinct hierarchies without game resources.
