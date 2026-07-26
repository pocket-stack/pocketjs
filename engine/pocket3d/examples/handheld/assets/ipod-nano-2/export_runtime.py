"""Export the authored iPod nano 2 scene as a Pocket Stage runtime GLB.

The editable source lives beside this cooker under ``source/``. This script
opens it read-only, exports only the device collections, adds one
exact full-UV ``dynamic_screen`` surface, and validates the resulting GLB before
returning success.

Run from the PocketJS repository root:

    /Applications/Blender.app/Contents/MacOS/Blender \
      --background --factory-startup \
      --python pocket3d/examples/handheld/assets/ipod-nano-2/export_runtime.py

Override paths after Blender's ``--`` separator:

    ... --python export_runtime.py -- --source /path/to/ipod.blend \
      --output /path/to/ipod-nano-2.glb

The default command also requires the byte-exact runtime contract recorded in
``SOURCE.json``. Pass ``--allow-output-drift`` only while intentionally
reviewing and updating that contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any, Iterable

import bpy
from mathutils import Matrix, Quaternion, Vector


PACKAGE_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE = PACKAGE_DIR / "source" / "ipod.blend"
DEFAULT_OUTPUT = PACKAGE_DIR / "ipod-nano-2.glb"
SOURCE_CONTRACT = PACKAGE_DIR / "SOURCE.json"

RUNTIME_COLLECTIONS = {
    "IPOD_BODY",
    "IPOD_SCREEN",
    "IPOD_WHEEL",
    "IPOD_DETAILS",
}
EXCLUDED_NODE_PREFIXES = (
    "IPOD_LCD_",  # authored static menu contents, not the LCD backing mesh
    "Studio",
    "FrontValidationCamera",
    "HeroCamera",
    "TopDetailCamera",
    "Key_",
    "Front_Fill",
    "Right_Curve_Rim",
    "Left_Curve_Rim",
    "Screen_Fill",
)

DYNAMIC_OBJECT = "P3D_dynamic_screen__display_main"
DYNAMIC_MATERIAL = "P3D_dynamic_screen__ipod_lcd"
DYNAMIC_ROLE_KEY = "pocket3d_role"
DYNAMIC_ROLE = "dynamic_screen"
SURFACE_ID = "display.main"

# Apple specifies a 176 x 132 display with a 0.168 mm pixel pitch.
SCREEN_WIDTH_UNITS = 2.9568
SCREEN_HEIGHT_UNITS = 2.2176
SCREEN_CENTER_Z = 7.43
# The source front is -Y. This is 0.04 mm in front of the LCD backing.
SCREEN_FRONT_Y = -0.369

EXPECTED_SOURCE_SHA256 = "2072e044d300140cf21ea9d2e428c4be62fe1b7dcf86a3ac197819741ef6b708"
EXPECTED_GLTF_BOUNDS = (
    (-2.0, 0.0, -0.34),
    (2.0, 9.08, 0.371),
)

GLB_MAGIC = 0x46546C67
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
COMPONENT_FORMATS = {
    5120: "b",
    5121: "B",
    5122: "h",
    5123: "H",
    5125: "I",
    5126: "f",
}
TYPE_COMPONENTS = {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
    "MAT2": 4,
    "MAT3": 9,
    "MAT4": 16,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--allow-source-drift",
        action="store_true",
        help="export an intentionally edited source before SOURCE.json is updated",
    )
    parser.add_argument(
        "--allow-output-drift",
        action="store_true",
        help="retain an intentionally changed GLB before SOURCE.json is updated",
    )
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_preflight(source: Path, allow_drift: bool) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"missing authored source: {source}")
    contract = json.loads(SOURCE_CONTRACT.read_text())
    contract_digest = contract["source"]["sha256"]
    if contract_digest != EXPECTED_SOURCE_SHA256:
        raise RuntimeError("SOURCE.json and exporter disagree about the source digest")
    actual = sha256(source)
    if actual != contract_digest and not allow_drift:
        raise RuntimeError(
            "authored source changed; review it and update SOURCE.json before exporting: "
            f"expected {contract_digest}, got {actual}"
        )


def verify_runtime_contract(report: dict[str, Any], allow_drift: bool) -> None:
    contract = json.loads(SOURCE_CONTRACT.read_text())["runtime_artifact"]
    expected = {
        "sha256": contract["sha256"],
        "bytes": contract["bytes"],
        "triangles": contract["triangles"],
        "runtime_vertices": contract["runtime_vertices"],
    }
    actual = {key: report[key] for key in expected}
    if actual != expected and not allow_drift:
        raise RuntimeError(
            "runtime export changed; inspect the GLB and update SOURCE.json only after review: "
            f"expected {expected}, got {actual}"
        )


def make_dynamic_screen() -> bpy.types.Object:
    old = bpy.data.objects.get(DYNAMIC_OBJECT)
    if old is not None:
        bpy.data.objects.remove(old, do_unlink=True)
    old_material = bpy.data.materials.get(DYNAMIC_MATERIAL)
    if old_material is not None and old_material.users == 0:
        bpy.data.materials.remove(old_material)

    half_w = SCREEN_WIDTH_UNITS / 2.0
    half_h = SCREEN_HEIGHT_UNITS / 2.0
    vertices = [
        (-half_w, SCREEN_FRONT_Y, SCREEN_CENTER_Z - half_h),
        (half_w, SCREEN_FRONT_Y, SCREEN_CENTER_Z - half_h),
        (half_w, SCREEN_FRONT_Y, SCREEN_CENTER_Z + half_h),
        (-half_w, SCREEN_FRONT_Y, SCREEN_CENTER_Z + half_h),
    ]
    mesh = bpy.data.meshes.new(f"{DYNAMIC_OBJECT}_Mesh")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    if len(mesh.polygons) != 1 or mesh.polygons[0].normal.y > -0.999:
        raise RuntimeError("dynamic screen winding does not face the device front (-Y)")

    # Blender's glTF exporter converts its bottom-left UV convention to glTF's
    # top-left convention by flipping V. Author the ordinary Blender mapping
    # here; the postflight below requires top V=0 in the final GLB.
    uv_by_vertex = {
        0: (0.0, 0.0),
        1: (1.0, 0.0),
        2: (1.0, 1.0),
        3: (0.0, 1.0),
    }
    uv = mesh.uv_layers.new(name="TEXCOORD_0")
    for loop in mesh.loops:
        uv.data[loop.index].uv = uv_by_vertex[loop.vertex_index]

    material = bpy.data.materials.new(DYNAMIC_MATERIAL)
    material.diffuse_color = (1.0, 1.0, 1.0, 1.0)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        bsdf.inputs["Roughness"].default_value = 1.0
    material[DYNAMIC_ROLE_KEY] = DYNAMIC_ROLE
    material["pocket3d_surface_id"] = SURFACE_ID
    mesh.materials.append(material)

    obj = bpy.data.objects.new(DYNAMIC_OBJECT, mesh)
    obj[DYNAMIC_ROLE_KEY] = DYNAMIC_ROLE
    obj["pocket3d_surface_id"] = SURFACE_ID
    screen_collection = bpy.data.collections.get("IPOD_SCREEN")
    if screen_collection is None:
        raise RuntimeError("source has no IPOD_SCREEN collection")
    screen_collection.objects.link(obj)
    return obj


def runtime_objects(dynamic_screen: bpy.types.Object) -> list[bpy.types.Object]:
    objects: list[bpy.types.Object] = []
    for obj in bpy.data.objects:
        if obj is dynamic_screen:
            objects.append(obj)
            continue
        collection_names = {collection.name for collection in obj.users_collection}
        if collection_names.intersection(RUNTIME_COLLECTIONS) and obj.type in {
            "MESH",
            "CURVE",
            "FONT",
        }:
            objects.append(obj)
    if not objects:
        raise RuntimeError("source produced no runtime objects")
    return sorted(objects, key=lambda obj: obj.name)


def freeze_meshes_and_strip_unused_uvs(
    objects: Iterable[bpy.types.Object], dynamic_screen: bpy.types.Object
) -> None:
    """Keep TEXCOORD_0 only where the runtime actually samples a texture.

    The source primitive cubes carry Blender-generated UVs even though every
    authored hardware material is factor-only in glTF. Bevel evaluation can
    perturb a handful of those unused floats between Blender processes. Their
    removal saves bytes and makes the cooked GLB byte-deterministic while the
    explicitly authored dynamic screen UV remains protected.
    """

    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj is dynamic_screen or obj.type != "MESH":
            continue
        if obj.modifiers:
            old_mesh = obj.data
            evaluated = obj.evaluated_get(depsgraph)
            obj.data = bpy.data.meshes.new_from_object(evaluated)
            obj.modifiers.clear()
            if old_mesh.users == 0:
                bpy.data.meshes.remove(old_mesh)
        while obj.data.uv_layers:
            obj.data.uv_layers.remove(obj.data.uv_layers[0])


def export_glb(output: Path, objects: Iterable[bpy.types.Object]) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    selected = list(objects)
    for obj in selected:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = selected[0]
    output.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_apply=True,
    )
    if result != {"FINISHED"}:
        raise RuntimeError(f"glTF export failed: {result}")


def read_glb(path: Path) -> tuple[dict[str, Any], bytes]:
    data = path.read_bytes()
    if len(data) < 20:
        raise RuntimeError("GLB is truncated")
    magic, version, total_length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or total_length != len(data):
        raise RuntimeError("invalid GLB header")
    document: dict[str, Any] | None = None
    binary = b""
    offset = 12
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        payload = data[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == JSON_CHUNK:
            document = json.loads(payload.decode("utf-8").rstrip(" \t\r\n\x00"))
        elif chunk_type == BIN_CHUNK:
            binary = payload
    if document is None:
        raise RuntimeError("GLB has no JSON chunk")
    return document, binary


def accessor_values(
    document: dict[str, Any], binary: bytes, accessor_index: int
) -> list[tuple[float | int, ...]]:
    accessor = document["accessors"][accessor_index]
    if "sparse" in accessor or "extensions" in accessor:
        raise RuntimeError("runtime exporter emitted unsupported sparse/compressed accessor")
    view = document["bufferViews"][accessor["bufferView"]]
    component_type = accessor["componentType"]
    component_format = COMPONENT_FORMATS.get(component_type)
    components = TYPE_COMPONENTS.get(accessor["type"])
    if component_format is None or components is None:
        raise RuntimeError(f"unsupported accessor layout: {accessor}")
    component_size = struct.calcsize(component_format)
    element_size = component_size * components
    stride = int(view.get("byteStride", element_size))
    start = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    unpack_format = "<" + component_format * components
    return [
        struct.unpack_from(unpack_format, binary, start + index * stride)
        for index in range(int(accessor["count"]))
    ]


def node_local_matrix(node: dict[str, Any]) -> Matrix:
    if "matrix" in node:
        values = node["matrix"]
        return Matrix(
            tuple(tuple(float(values[column * 4 + row]) for column in range(4)) for row in range(4))
        )
    translation = Matrix.Translation(Vector(node.get("translation", (0.0, 0.0, 0.0))))
    qx, qy, qz, qw = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    rotation = Quaternion((qw, qx, qy, qz)).to_matrix().to_4x4()
    sx, sy, sz = node.get("scale", (1.0, 1.0, 1.0))
    scale = Matrix.Diagonal(Vector((sx, sy, sz, 1.0)))
    return translation @ rotation @ scale


def scene_nodes(
    document: dict[str, Any],
) -> list[tuple[int, Matrix]]:
    scene_index = int(document.get("scene", 0))
    roots = document["scenes"][scene_index].get("nodes", [])
    result: list[tuple[int, Matrix]] = []

    def visit(index: int, parent: Matrix) -> None:
        node = document["nodes"][index]
        world = parent @ node_local_matrix(node)
        result.append((index, world))
        for child in node.get("children", []):
            visit(int(child), world)

    for root in roots:
        visit(int(root), Matrix.Identity(4))
    return result


def transformed_positions(
    document: dict[str, Any], binary: bytes, primitive: dict[str, Any], world: Matrix
) -> list[Vector]:
    values = accessor_values(document, binary, primitive["attributes"]["POSITION"])
    return [world @ Vector((float(x), float(y), float(z))) for x, y, z in values]


def bounds(points: Iterable[Vector]) -> tuple[list[float], list[float]]:
    values = list(points)
    if not values:
        raise RuntimeError("cannot measure empty geometry")
    minimum = [min(point[axis] for point in values) for axis in range(3)]
    maximum = [max(point[axis] for point in values) for axis in range(3)]
    return minimum, maximum


def assert_close(actual: float, expected: float, tolerance: float, label: str) -> None:
    if not math.isclose(actual, expected, abs_tol=tolerance, rel_tol=0.0):
        raise RuntimeError(f"{label}: expected {expected}, got {actual}")


def validate_output(path: Path) -> dict[str, Any]:
    document, binary = read_glb(path)
    nodes = document.get("nodes", [])
    meshes = document.get("meshes", [])
    materials = document.get("materials", [])
    accessors = document.get("accessors", [])
    names = [str(node.get("name", "")) for node in nodes]
    excluded = [name for name in names if name.startswith(EXCLUDED_NODE_PREFIXES)]
    if excluded:
        raise RuntimeError(f"non-runtime nodes escaped export filtering: {excluded}")
    if "IPOD_LCD" not in names or "IPOD_ScreenBlackBezel" not in names:
        raise RuntimeError("LCD backing or bezel was lost")
    if document.get("cameras") or document.get("animations"):
        raise RuntimeError("runtime asset unexpectedly contains cameras or animations")
    if "KHR_lights_punctual" in document.get("extensionsUsed", []):
        raise RuntimeError("runtime asset unexpectedly contains authored lights")

    dynamic_material_indices = {
        index
        for index, material in enumerate(materials)
        if (material.get("extras") or {}).get("pocket3d_role") == DYNAMIC_ROLE
        or str(material.get("name", "")).startswith("P3D_dynamic_screen__")
    }
    if len(dynamic_material_indices) != 1:
        raise RuntimeError(
            f"expected one dynamic material, found {len(dynamic_material_indices)}"
        )
    dynamic_material = materials[next(iter(dynamic_material_indices))]
    if (dynamic_material.get("extras") or {}).get("pocket3d_surface_id") != SURFACE_ID:
        raise RuntimeError("dynamic material lost its display.main surface id")

    runtime_vertices = 0
    runtime_triangles = 0
    primitive_count = 0
    all_positions: list[Vector] = []
    dynamic_records: list[tuple[dict[str, Any], Matrix]] = []
    for node_index, world in scene_nodes(document):
        node = nodes[node_index]
        if "mesh" not in node:
            continue
        mesh = meshes[int(node["mesh"])]
        for primitive in mesh.get("primitives", []):
            primitive_count += 1
            position_accessor = accessors[primitive["attributes"]["POSITION"]]
            runtime_vertices += int(position_accessor["count"])
            if primitive.get("mode", 4) != 4:
                raise RuntimeError("runtime asset contains a non-TRIANGLES primitive")
            if "indices" in primitive:
                runtime_triangles += int(accessors[primitive["indices"]]["count"]) // 3
            else:
                runtime_triangles += int(position_accessor["count"]) // 3
            all_positions.extend(transformed_positions(document, binary, primitive, world))
            if primitive.get("material") in dynamic_material_indices:
                dynamic_records.append((primitive, world))

    if len(dynamic_records) != 1:
        raise RuntimeError(
            f"expected one dynamic-screen primitive, found {len(dynamic_records)}"
        )
    dynamic_primitive, dynamic_world = dynamic_records[0]
    if "TEXCOORD_0" not in dynamic_primitive.get("attributes", {}):
        raise RuntimeError("dynamic screen is missing TEXCOORD_0")
    uv_values = accessor_values(
        document, binary, dynamic_primitive["attributes"]["TEXCOORD_0"]
    )
    uv_min = [min(float(value[axis]) for value in uv_values) for axis in range(2)]
    uv_max = [max(float(value[axis]) for value in uv_values) for axis in range(2)]
    for axis, name in enumerate(("U", "V")):
        assert_close(uv_min[axis], 0.0, 1e-6, f"screen {name} minimum")
        assert_close(uv_max[axis], 1.0, 1e-6, f"screen {name} maximum")
    if len({(round(float(u), 6), round(float(v), 6)) for u, v in uv_values}) != 4:
        raise RuntimeError("dynamic screen does not have exactly four full-span UV corners")

    screen_positions = transformed_positions(
        document, binary, dynamic_primitive, dynamic_world
    )
    if "indices" not in dynamic_primitive:
        raise RuntimeError("dynamic screen must remain indexed")
    screen_indices = [
        int(value[0])
        for value in accessor_values(document, binary, dynamic_primitive["indices"])
    ]
    if len(screen_indices) != 6:
        raise RuntimeError(f"dynamic screen must be two triangles, got {len(screen_indices) // 3}")
    a, b, c = (screen_positions[index] for index in screen_indices[:3])
    normal = (b - a).cross(c - a).normalized()
    if normal.z < 0.999:
        raise RuntimeError(f"dynamic screen faces away from +Z: {tuple(normal)}")
    screen_min, screen_max = bounds(screen_positions)
    assert_close(screen_max[0] - screen_min[0], SCREEN_WIDTH_UNITS, 1e-5, "screen width")
    assert_close(screen_max[1] - screen_min[1], SCREEN_HEIGHT_UNITS, 1e-5, "screen height")
    assert_close(screen_max[2] - screen_min[2], 0.0, 1e-6, "screen planarity")
    assert_close((screen_min[1] + screen_max[1]) / 2.0, SCREEN_CENTER_Z, 1e-5, "screen Y center")
    assert_close((screen_min[2] + screen_max[2]) / 2.0, -SCREEN_FRONT_Y, 1e-5, "screen Z front")
    for position, (u, v) in zip(screen_positions, uv_values, strict=True):
        expected_u = 0.0 if position.x < 0.0 else 1.0
        expected_v = 0.0 if position.y > SCREEN_CENTER_Z else 1.0
        assert_close(float(u), expected_u, 1e-6, "screen horizontal UV orientation")
        assert_close(float(v), expected_v, 1e-6, "screen vertical UV orientation")

    model_min, model_max = bounds(all_positions)
    for axis, axis_name in enumerate("XYZ"):
        assert_close(
            model_min[axis], EXPECTED_GLTF_BOUNDS[0][axis], 2e-4, f"model {axis_name} minimum"
        )
        assert_close(
            model_max[axis], EXPECTED_GLTF_BOUNDS[1][axis], 2e-4, f"model {axis_name} maximum"
        )

    return {
        "output": str(path),
        "bytes": path.stat().st_size,
        "sha256": sha256(path),
        "nodes": len(nodes),
        "meshes": len(meshes),
        "primitives": primitive_count,
        "runtime_vertices": runtime_vertices,
        "triangles": runtime_triangles,
        "materials": len(materials),
        "images": len(document.get("images", [])),
        "textures": len(document.get("textures", [])),
        "bounds": {"minimum": model_min, "maximum": model_max},
        "dynamic_screen": {
            "material": dynamic_material.get("name"),
            "primitives": len(dynamic_records),
            "uv_minimum": uv_min,
            "uv_maximum": uv_max,
            "minimum": screen_min,
            "maximum": screen_max,
        },
    }


def main() -> None:
    args = parse_args()
    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    source_preflight(source, args.allow_source_drift)
    bpy.ops.wm.open_mainfile(filepath=str(source))
    screen = make_dynamic_screen()
    objects = runtime_objects(screen)
    freeze_meshes_and_strip_unused_uvs(objects, screen)
    export_glb(output, objects)
    report = validate_output(output)
    verify_runtime_contract(report, args.allow_output_drift)
    print("IPOD_RUNTIME_REPORT " + json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
