"""Procedurally build and render a slim silver iPod nano product scene.

Run headlessly:
    /Applications/Blender.app/Contents/MacOS/Blender \
      --background --factory-startup --python build_ipod.py
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parent
BLEND_PATH = ROOT / "ipod.blend"
RENDER_PATH = ROOT / "renders" / "ipod.png"
FRONT_RENDER_PATH = ROOT / "renders" / "ipod_front.png"
TOP_RENDER_PATH = ROOT / "renders" / "ipod_top.png"

COLLECTIONS: dict[str, bpy.types.Collection] = {}
MATERIALS: dict[str, bpy.types.Material] = {}

BODY_WIDTH = 4.00
BODY_DEPTH = 0.68
BODY_HEIGHT = 9.00
BODY_BOTTOM = 0.06
TOP_CAP_HEIGHT = 0.10
FRONT_Y = -BODY_DEPTH / 2.0


def srgb(hex_value: str) -> tuple[float, float, float, float]:
    value = hex_value.strip().lstrip("#")
    return tuple(int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)


def reset_scene() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for datablocks in (
        bpy.data.curves,
        bpy.data.meshes,
        bpy.data.cameras,
        bpy.data.lights,
        bpy.data.materials,
    ):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)

    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)


def make_collection(name: str) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    COLLECTIONS[name] = collection
    return collection


def move_to_collection(obj: bpy.types.Object, collection_name: str) -> None:
    target = COLLECTIONS[collection_name]
    for source in list(obj.users_collection):
        source.objects.unlink(obj)
    target.objects.link(obj)


def set_input(node: bpy.types.Node, name: str, value: object) -> None:
    socket = node.inputs.get(name)
    if socket is not None:
        socket.default_value = value


def make_material(
    name: str,
    color: tuple[float, float, float, float],
    *,
    roughness: float,
    metallic: float = 0.0,
    coat: float = 0.0,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_input(bsdf, "Base Color", color)
    set_input(bsdf, "Roughness", roughness)
    set_input(bsdf, "Metallic", metallic)
    set_input(bsdf, "Coat Weight", coat)
    set_input(bsdf, "Coat Roughness", 0.10)
    if emission is not None:
        set_input(bsdf, "Emission Color", emission)
        set_input(bsdf, "Emission Strength", emission_strength)
    MATERIALS[name] = mat
    return mat


def make_anodized_aluminum() -> bpy.types.Material:
    mat = make_material(
        "MAT_AnodizedSilver",
        srgb("ADB4B5"),
        roughness=0.34,
        metallic=0.76,
        coat=0.04,
    )
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    set_input(bsdf, "Anisotropic IOR Level", 0.18)
    noise = nodes.new("ShaderNodeTexNoise")
    texcoord = nodes.new("ShaderNodeTexCoord")
    texcoord.name = "Body generated coordinates"
    noise.name = "Fine anodized grain"
    noise.inputs["Scale"].default_value = 220.0
    noise.inputs["Detail"].default_value = 1.4
    noise.inputs["Roughness"].default_value = 0.36
    noise.inputs["Distortion"].default_value = 0.025
    bump = nodes.new("ShaderNodeBump")
    bump.name = "Microscopic anodized texture"
    bump.inputs["Strength"].default_value = 0.022
    bump.inputs["Distance"].default_value = 0.010
    links.new(texcoord.outputs["Generated"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def setup_materials() -> None:
    make_anodized_aluminum()
    make_material("MAT_Wheel", srgb("F1F0EA"), roughness=0.44, coat=0.06)
    make_material("MAT_CenterButton", srgb("B7BDBD"), roughness=0.27, metallic=0.62, coat=0.06)
    make_material("MAT_ScreenBezel", srgb("14191B"), roughness=0.16, coat=0.24)
    make_material(
        "MAT_ScreenGlow",
        srgb("D4E7EB"),
        roughness=0.38,
        emission=srgb("C9E2E8"),
        emission_strength=0.28,
    )
    make_material("MAT_ScreenInk", srgb("26333A"), roughness=0.50)
    make_material(
        "MAT_HighlightBlue",
        srgb("248CC4"),
        roughness=0.38,
        emission=srgb("1887BE"),
        emission_strength=0.16,
    )
    make_material("MAT_LabelGray", srgb("979C9C"), roughness=0.48)
    make_material("MAT_WhiteInk", srgb("F4FBFC"), roughness=0.42)
    make_material("MAT_PortDark", srgb("111518"), roughness=0.38, metallic=0.10)
    make_material("MAT_EndCapWhite", srgb("F5F4EF"), roughness=0.30, coat=0.16)
    make_material("MAT_EndCapSeam", srgb("9EA4A3"), roughness=0.42, metallic=0.18)
    make_material("MAT_HoldOrange", srgb("D95A1E"), roughness=0.38, coat=0.06)
    make_material("MAT_TopLabel", srgb("7E8482"), roughness=0.50)
    make_material("MAT_BatteryGreen", srgb("68AF67"), roughness=0.42)
    make_material("MAT_Backdrop", srgb("E4E4E1"), roughness=0.74)


def assign_material(obj: bpy.types.Object, material_name: str) -> None:
    obj.data.materials.append(MATERIALS[material_name])


def add_bevel(obj: bpy.types.Object, width: float, segments: int = 5) -> None:
    modifier = obj.modifiers.new(name="Precision edge rounding", type="BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    modifier.harden_normals = True


def rounded_box(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    material_name: str,
    collection_name: str,
    *,
    bevel: float,
    bevel_segments: int = 5,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign_material(obj, material_name)
    if bevel > 0.0:
        add_bevel(obj, bevel, bevel_segments)
    move_to_collection(obj, collection_name)
    return obj


def front_cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    material_name: str,
    collection_name: str,
    *,
    bevel: float = 0.0,
    vertices: int = 96,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=(math.radians(90.0), 0.0, 0.0),
    )
    obj = bpy.context.object
    obj.name = name
    assign_material(obj, material_name)
    if bevel > 0.0:
        add_bevel(obj, bevel, 3)
    move_to_collection(obj, collection_name)
    return obj


def create_annulus(
    name: str,
    location: tuple[float, float, float],
    outer_radius: float,
    inner_radius: float,
    depth: float,
    material_name: str,
    collection_name: str,
    *,
    segments: int = 128,
) -> bpy.types.Object:
    x0, y0, z0 = location
    half_depth = depth / 2.0
    vertices: list[tuple[float, float, float]] = []
    for y, radius in (
        (y0 - half_depth, outer_radius),
        (y0 - half_depth, inner_radius),
        (y0 + half_depth, outer_radius),
        (y0 + half_depth, inner_radius),
    ):
        for i in range(segments):
            angle = math.tau * i / segments
            vertices.append((x0 + radius * math.cos(angle), y, z0 + radius * math.sin(angle)))

    faces: list[tuple[int, int, int, int]] = []
    for i in range(segments):
        j = (i + 1) % segments
        front_outer_i, front_outer_j = i, j
        front_inner_i, front_inner_j = segments + i, segments + j
        back_outer_i, back_outer_j = 2 * segments + i, 2 * segments + j
        back_inner_i, back_inner_j = 3 * segments + i, 3 * segments + j
        faces.extend(
            [
                (front_outer_i, front_outer_j, front_inner_j, front_inner_i),
                (back_outer_i, back_inner_i, back_inner_j, back_outer_j),
                (front_outer_i, back_outer_i, back_outer_j, front_outer_j),
                (front_inner_i, front_inner_j, back_inner_j, back_inner_i),
            ]
        )

    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    COLLECTIONS[collection_name].objects.link(obj)
    assign_material(obj, material_name)
    add_bevel(obj, 0.010, 3)
    return obj


def create_text(
    name: str,
    body: str,
    location: tuple[float, float, float],
    size: float,
    material_name: str,
    collection_name: str,
    *,
    align: str = "CENTER",
    extrude: float = 0.004,
) -> bpy.types.Object:
    curve = bpy.data.curves.new(name=f"{name}_Curve", type="FONT")
    curve.body = body
    curve.align_x = align
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = extrude
    curve.bevel_depth = 0.002
    curve.bevel_resolution = 2
    curve.resolution_u = 8
    obj = bpy.data.objects.new(name, curve)
    obj.location = location
    obj.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    COLLECTIONS[collection_name].objects.link(obj)
    assign_material(obj, material_name)
    return obj


def create_top_text(
    name: str,
    body: str,
    location: tuple[float, float, float],
    size: float,
    material_name: str,
    collection_name: str,
) -> bpy.types.Object:
    """Create shallow printed lettering on a horizontal top surface."""

    curve = bpy.data.curves.new(name=f"{name}_Curve", type="FONT")
    curve.body = body
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = size
    curve.extrude = 0.001
    curve.bevel_depth = 0.0005
    curve.bevel_resolution = 1
    obj = bpy.data.objects.new(name, curve)
    obj.location = location
    COLLECTIONS[collection_name].objects.link(obj)
    assign_material(obj, material_name)
    return obj


def triangle_icon(
    name: str,
    center: tuple[float, float, float],
    width: float,
    height: float,
    direction: str,
    material_name: str,
    collection_name: str,
) -> bpy.types.Object:
    x, y, z = center
    sign = 1.0 if direction == "RIGHT" else -1.0
    points = [
        (x + sign * width / 2.0, y, z),
        (x - sign * width / 2.0, y, z + height / 2.0),
        (x - sign * width / 2.0, y, z - height / 2.0),
    ]
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(points, [], [(0, 1, 2)])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    COLLECTIONS[collection_name].objects.link(obj)
    assign_material(obj, material_name)
    return obj


def create_unibody(
    name: str,
    *,
    width: float,
    depth: float,
    height: float,
    bottom: float,
    material_name: str,
    collection_name: str,
    center_x: float = 0.0,
    center_y: float = 0.0,
    side_roll: float = 0.20,
    side_segments: int = 20,
    end_bevel: float = 0.070,
) -> bpy.types.Object:
    """Create a nano-style enclosure with a continuous stadium cross-section.

    The front and back are broad tangent planes. Both side walls are true
    half-ellipse arcs, so their highlights roll continuously instead of reading
    as a second shell. A small bevel is applied only to the top and bottom rims.
    """

    radius_y = depth / 2.0
    half_flat = width / 2.0 - side_roll
    outline: list[tuple[float, float]] = [
        (center_x - half_flat, center_y - radius_y),
        (center_x + half_flat, center_y - radius_y),
    ]

    # Right side: front tangent to back tangent.
    for i in range(1, side_segments + 1):
        angle = -math.pi / 2.0 + math.pi * i / side_segments
        outline.append(
            (
                center_x + half_flat + side_roll * math.cos(angle),
                center_y + radius_y * math.sin(angle),
            )
        )

    outline.append((center_x - half_flat, center_y + radius_y))

    # Left side: back tangent to front tangent. The closing vertex is omitted.
    for i in range(1, side_segments):
        angle = math.pi / 2.0 + math.pi * i / side_segments
        outline.append(
            (
                center_x - half_flat + side_roll * math.cos(angle),
                center_y + radius_y * math.sin(angle),
            )
        )

    top = bottom + height
    vertices = [(x, y, bottom) for x, y in outline] + [(x, y, top) for x, y in outline]
    count = len(outline)
    faces: list[tuple[int, ...]] = []
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    faces.append(tuple(reversed(range(count))))
    faces.append(tuple(count + i for i in range(count)))

    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    COLLECTIONS[collection_name].objects.link(obj)
    assign_material(obj, material_name)

    # Preserve truly planar front/back faces while smoothing only the curved
    # side-wall strips. Front is face 0; back is face 1 + side_segments.
    back_face_index = 1 + side_segments
    for index, polygon in enumerate(mesh.polygons[:count]):
        polygon.use_smooth = index not in (0, back_face_index)

    if end_bevel > 0.0:
        add_bevel(obj, end_bevel, 6)
    return obj


def create_ipod_body() -> None:
    body = create_unibody(
        "IPOD_AnodizedAluminumUnibody",
        width=BODY_WIDTH,
        depth=BODY_DEPTH,
        height=BODY_HEIGHT - TOP_CAP_HEIGHT,
        bottom=BODY_BOTTOM,
        material_name="MAT_AnodizedSilver",
        collection_name="IPOD_BODY",
        end_bevel=0.010,
    )
    body["construction"] = "Single-piece anodized aluminum enclosure"
    body["side_profile"] = "Continuous front-to-side-to-back radius"


def create_screen() -> None:
    screen_z = 7.43
    bezel_y = FRONT_Y - 0.006
    rounded_box(
        "IPOD_ScreenBlackBezel",
        (0.0, bezel_y, screen_z),
        (3.18, 0.022, 2.35),
        "MAT_ScreenBezel",
        "IPOD_SCREEN",
        bevel=0.075,
        bevel_segments=8,
    )
    rounded_box(
        "IPOD_LCD",
        (0.0, FRONT_Y - 0.020, screen_z),
        (3.02, 0.010, 2.17),
        "MAT_ScreenGlow",
        "IPOD_SCREEN",
        bevel=0.035,
        bevel_segments=6,
    )

    ui_y = FRONT_Y - 0.028
    rounded_box(
        "IPOD_LCD_HeaderRule",
        (0.0, ui_y, 8.16),
        (2.88, 0.008, 0.022),
        "MAT_ScreenInk",
        "IPOD_SCREEN_UI",
        bevel=0.005,
    )
    rounded_box(
        "IPOD_LCD_MusicHighlight",
        (0.0, ui_y, 7.95),
        (2.88, 0.009, 0.31),
        "MAT_HighlightBlue",
        "IPOD_SCREEN_UI",
        bevel=0.018,
    )

    create_text("IPOD_LCD_Title", "iPod", (0.0, ui_y - 0.009, 8.37), 0.20, "MAT_ScreenInk", "IPOD_SCREEN_UI", extrude=0.002)

    # Battery body, fill, and terminal.
    rounded_box(
        "IPOD_LCD_BatteryBody",
        (1.20, ui_y - 0.008, 8.37),
        (0.34, 0.008, 0.16),
        "MAT_ScreenInk",
        "IPOD_SCREEN_UI",
        bevel=0.018,
    )
    rounded_box(
        "IPOD_LCD_BatteryFill",
        (1.185, ui_y - 0.017, 8.37),
        (0.245, 0.008, 0.095),
        "MAT_BatteryGreen",
        "IPOD_SCREEN_UI",
        bevel=0.010,
    )
    rounded_box(
        "IPOD_LCD_BatteryTerminal",
        (1.39, ui_y - 0.009, 8.37),
        (0.045, 0.008, 0.072),
        "MAT_ScreenInk",
        "IPOD_SCREEN_UI",
        bevel=0.006,
    )

    items = [
        ("Music", 7.95, "MAT_WhiteInk"),
        ("Photos", 7.59, "MAT_ScreenInk"),
        ("Extras", 7.23, "MAT_ScreenInk"),
        ("Settings", 6.87, "MAT_ScreenInk"),
        ("Shuffle Songs", 6.51, "MAT_ScreenInk"),
    ]
    for index, (label, z, material) in enumerate(items):
        create_text(
            f"IPOD_LCD_Menu_{index + 1}_{label.replace(' ', '')}",
            label,
            (-1.34, ui_y - 0.011, z),
            0.205,
            material,
            "IPOD_SCREEN_UI",
            align="LEFT",
            extrude=0.002,
        )
        triangle_icon(
            f"IPOD_LCD_Chevron_{index + 1}",
            (1.34, ui_y - 0.013, z),
            0.085,
            0.145,
            "RIGHT",
            "MAT_WhiteInk" if index == 0 else "MAT_ScreenInk",
            "IPOD_SCREEN_UI",
        )


def create_click_wheel() -> None:
    wheel_y = FRONT_Y - 0.012
    wheel_z = 3.23
    create_annulus(
        "IPOD_ClickWheel",
        (0.0, wheel_y, wheel_z),
        1.50,
        0.68,
        0.020,
        "MAT_Wheel",
        "IPOD_WHEEL",
    )
    front_cylinder(
        "IPOD_CenterSelectButton",
        (0.0, wheel_y - 0.002, wheel_z),
        0.64,
        0.022,
        "MAT_CenterButton",
        "IPOD_WHEEL",
        bevel=0.008,
        vertices=128,
    )

    icon_y = FRONT_Y - 0.028
    create_text("IPOD_Wheel_MENU", "MENU", (0.0, icon_y, 4.36), 0.225, "MAT_LabelGray", "IPOD_WHEEL", extrude=0.001)

    # Previous-track control.
    triangle_icon("IPOD_PreviousTriangleA", (-1.00, icon_y, wheel_z), 0.18, 0.24, "LEFT", "MAT_LabelGray", "IPOD_WHEEL")
    triangle_icon("IPOD_PreviousTriangleB", (-1.16, icon_y, wheel_z), 0.18, 0.24, "LEFT", "MAT_LabelGray", "IPOD_WHEEL")
    rounded_box("IPOD_PreviousBar", (-1.29, icon_y, wheel_z), (0.038, 0.006, 0.25), "MAT_LabelGray", "IPOD_WHEEL", bevel=0.006)

    # Next-track control.
    triangle_icon("IPOD_NextTriangleA", (1.00, icon_y, wheel_z), 0.18, 0.24, "RIGHT", "MAT_LabelGray", "IPOD_WHEEL")
    triangle_icon("IPOD_NextTriangleB", (1.16, icon_y, wheel_z), 0.18, 0.24, "RIGHT", "MAT_LabelGray", "IPOD_WHEEL")
    rounded_box("IPOD_NextBar", (1.29, icon_y, wheel_z), (0.038, 0.006, 0.25), "MAT_LabelGray", "IPOD_WHEEL", bevel=0.006)

    # Play/pause control.
    triangle_icon("IPOD_PlayTriangle", (-0.13, icon_y, 2.11), 0.20, 0.25, "RIGHT", "MAT_LabelGray", "IPOD_WHEEL")
    rounded_box("IPOD_PauseBarA", (0.10, icon_y, 2.11), (0.042, 0.006, 0.24), "MAT_LabelGray", "IPOD_WHEEL", bevel=0.006)
    rounded_box("IPOD_PauseBarB", (0.20, icon_y, 2.11), (0.042, 0.006, 0.24), "MAT_LabelGray", "IPOD_WHEEL", bevel=0.006)


def create_ports() -> None:
    top_z = BODY_BOTTOM + BODY_HEIGHT
    cap_bottom = top_z - TOP_CAP_HEIGHT

    # The actual nano closes the aluminum extrusion with a separate, nearly
    # flat white polymer end cap. A thin gray gasket remains visible below it.
    create_unibody(
        "IPOD_TopEndCapGasket",
        width=3.98,
        depth=0.66,
        height=0.016,
        bottom=cap_bottom - 0.004,
        material_name="MAT_EndCapSeam",
        collection_name="IPOD_DETAILS",
        side_roll=0.330,
        side_segments=24,
        end_bevel=0.010,
    )
    top_cap = create_unibody(
        "IPOD_TopWhiteEndCap",
        width=3.96,
        depth=0.65,
        height=TOP_CAP_HEIGHT,
        bottom=cap_bottom,
        material_name="MAT_EndCapWhite",
        collection_name="IPOD_DETAILS",
        side_roll=0.325,
        side_segments=32,
        end_bevel=0.015,
    )
    top_cap["construction"] = "Separate flat polymer end cap"
    cap_surface_z = top_z

    # The Hold track is a shallow orange capsule. The white slider leaves only
    # a small orange crescent exposed at its left end, matching the reference.
    create_unibody(
        "IPOD_HoldTrackRim",
        width=0.94,
        depth=0.22,
        height=0.009,
        bottom=cap_surface_z - 0.002,
        material_name="MAT_EndCapSeam",
        collection_name="IPOD_DETAILS",
        center_x=-1.20,
        center_y=-0.025,
        side_roll=0.110,
        side_segments=18,
        end_bevel=0.004,
    )
    create_unibody(
        "IPOD_HoldOrangeReveal",
        width=0.88,
        depth=0.150,
        height=0.010,
        bottom=cap_surface_z + 0.002,
        material_name="MAT_HoldOrange",
        collection_name="IPOD_DETAILS",
        center_x=-1.20,
        center_y=-0.025,
        side_roll=0.075,
        side_segments=18,
        end_bevel=0.004,
    )
    create_unibody(
        "IPOD_HoldWhiteSlider",
        width=0.66,
        depth=0.158,
        height=0.014,
        bottom=cap_surface_z + 0.006,
        material_name="MAT_EndCapWhite",
        collection_name="IPOD_DETAILS",
        center_x=-1.09,
        center_y=-0.025,
        side_roll=0.079,
        side_segments=18,
        end_bevel=0.005,
    )
    create_top_text(
        "IPOD_HoldLabel",
        "HOLD",
        (-0.50, -0.025, cap_surface_z + 0.012),
        0.105,
        "MAT_TopLabel",
        "IPOD_DETAILS",
    )

    # A matching white bottom cap completes the extrusion when the model is
    # inspected from below, while remaining unobtrusive in the standing render.
    create_unibody(
        "IPOD_BottomWhiteEndCap",
        width=3.96,
        depth=0.65,
        height=0.060,
        bottom=0.0,
        material_name="MAT_EndCapWhite",
        collection_name="IPOD_DETAILS",
        side_roll=0.325,
        side_segments=32,
        end_bevel=0.015,
    )


def create_cyclorama() -> None:
    width = 24.0
    profile: list[tuple[float, float]] = [(-13.0, 0.0), (2.8, 0.0)]
    radius = 3.2
    for i in range(1, 13):
        angle = math.radians(90.0) * i / 12.0
        profile.append((2.8 + radius * math.sin(angle), radius * (1.0 - math.cos(angle))))
    profile.append((6.0, 18.0))

    vertices: list[tuple[float, float, float]] = []
    for x in (-width / 2.0, width / 2.0):
        for y, z in profile:
            vertices.append((x, y, z))
    count = len(profile)
    faces = []
    for i in range(count - 1):
        faces.append((i, i + 1, count + i + 1, count + i))
    mesh = bpy.data.meshes.new("StudioCyclorama_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    cyclorama = bpy.data.objects.new("StudioCyclorama", mesh)
    COLLECTIONS["STUDIO"].objects.link(cyclorama)
    assign_material(cyclorama, "MAT_Backdrop")
    add_bevel(cyclorama, 0.03, 2)

def look_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def add_area_light(
    name: str,
    location: tuple[float, float, float],
    target: tuple[float, float, float],
    energy: float,
    size: float,
    color: tuple[float, float, float],
    *,
    shape: str = "DISK",
    size_y: float | None = None,
) -> bpy.types.Object:
    data = bpy.data.lights.new(name=f"{name}_Data", type="AREA")
    data.energy = energy
    data.color = color
    data.shape = shape
    data.size = size
    if size_y is not None:
        data.size_y = size_y
    light = bpy.data.objects.new(name, data)
    light.location = location
    COLLECTIONS["LIGHTS"].objects.link(light)
    look_at(light, target)
    return light


def setup_lighting() -> None:
    target = (0.0, 0.0, 4.55)
    add_area_light("Key_VerticalSoftbox", (-5.2, -8.0, 10.8), target, 940.0, 4.6, (1.0, 0.98, 0.95), shape="RECTANGLE", size_y=7.6)
    add_area_light("Front_Fill", (4.5, -7.5, 7.0), target, 510.0, 4.2, (0.91, 0.95, 1.0), shape="RECTANGLE", size_y=6.2)
    add_area_light("Right_Curve_Rim", (4.5, 2.4, 10.2), (0.0, 0.15, 4.8), 1080.0, 2.0, (0.96, 0.98, 1.0), shape="RECTANGLE", size_y=7.5)
    add_area_light("Left_Curve_Rim", (-4.0, 1.2, 7.7), (0.0, 0.1, 4.4), 620.0, 1.8, (1.0, 0.98, 0.94), shape="RECTANGLE", size_y=6.5)
    add_area_light("Screen_Fill", (0.0, -7.0, 7.4), (0.0, -0.1, 7.4), 115.0, 2.4, (0.92, 0.97, 1.0))


def make_camera(
    name: str,
    location: tuple[float, float, float],
    target: tuple[float, float, float],
    lens: float,
) -> bpy.types.Object:
    camera_data = bpy.data.cameras.new(f"{name}_Data")
    camera_data.lens = lens
    camera_data.sensor_fit = "VERTICAL"
    camera_data.sensor_height = 32.0
    camera_data.dof.use_dof = False
    camera_data.dof.focus_distance = (Vector(target) - Vector(location)).length
    camera_data.dof.aperture_fstop = 11.0
    camera = bpy.data.objects.new(name, camera_data)
    camera.location = location
    COLLECTIONS["CAMERA"].objects.link(camera)
    look_at(camera, target)
    return camera


def setup_cameras() -> tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    target = (0.0, -0.02, 4.57)
    front = make_camera("FrontValidationCamera", (0.0, -24.0, 4.57), target, 78.0)
    hero = make_camera("HeroCamera", (2.3, -24.0, 5.45), target, 77.0)
    top = make_camera("TopDetailCamera", (0.8, -7.8, 11.8), (0.0, -0.02, 8.00), 90.0)
    bpy.context.scene.camera = hero
    return front, hero, top


def configure_scene() -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 1400
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.film_transparent = False
    scene.render.filepath = str(RENDER_PATH)
    scene.render.use_file_extension = True

    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "AgX - Medium High Contrast"

    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "CENTIMETERS"
    scene.unit_settings.scale_length = 0.01

    world = bpy.data.worlds.new("StudioWorld") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = srgb("D7DCE0")
    background.inputs["Strength"].default_value = 0.32

    scene["asset_name"] = "Slim Silver iPod nano"
    scene["asset_style"] = "Second-generation nano inspired anodized aluminum unibody"
    scene["dimensions_cm"] = "4.00 x 0.68 x 9.00"
    scene["generator"] = Path(__file__).name


def organize_outliner() -> None:
    for name in (
        "IPOD_BODY",
        "IPOD_SCREEN",
        "IPOD_SCREEN_UI",
        "IPOD_WHEEL",
        "IPOD_DETAILS",
        "STUDIO",
        "LIGHTS",
        "CAMERA",
    ):
        make_collection(name)


def main() -> None:
    print("[1/7] Resetting scene and configuring renderer")
    reset_scene()
    organize_outliner()
    configure_scene()
    setup_materials()

    print("[2/7] Building continuous anodized aluminum unibody")
    create_ipod_body()
    print("[3/7] Building lit screen and editable interface")
    create_screen()
    print("[4/7] Building click wheel and controls")
    create_click_wheel()
    create_ports()
    print("[5/7] Building studio stage")
    create_cyclorama()
    print("[6/7] Placing lights and camera")
    setup_lighting()
    front_camera, hero_camera, top_camera = setup_cameras()

    RENDER_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"[7/7] Rendering top detail, validation, and hero views, then saving {BLEND_PATH.name}")
    bpy.context.scene.camera = top_camera
    bpy.context.scene.render.resolution_x = 1200
    bpy.context.scene.render.resolution_y = 800
    bpy.context.scene.render.filepath = str(TOP_RENDER_PATH)
    bpy.ops.render.render(write_still=True)
    bpy.context.scene.render.resolution_x = 1000
    bpy.context.scene.render.resolution_y = 1400
    bpy.context.scene.camera = front_camera
    bpy.context.scene.render.filepath = str(FRONT_RENDER_PATH)
    bpy.ops.render.render(write_still=True)
    bpy.context.scene.camera = hero_camera
    bpy.context.scene.render.filepath = str(RENDER_PATH)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    bpy.ops.render.render(write_still=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    print(f"DONE: {BLEND_PATH}")
    print(f"DONE: {RENDER_PATH}")
    print(f"DONE: {FRONT_RENDER_PATH}")
    print(f"DONE: {TOP_RENDER_PATH}")


if __name__ == "__main__":
    main()
