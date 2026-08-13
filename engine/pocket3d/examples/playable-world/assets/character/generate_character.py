#!/usr/bin/env python3
"""Generate a deterministic, low-poly, skinned Pocket3D explorer.

Run with Blender 5.1+:
  blender --background --factory-startup --python generate_character.py
  blender --background --factory-startup --python generate_character.py -- \
    --output-dir /tmp/explorer --skip-previews

Outputs explorer.blend, explorer.glb, three studio pose PNGs, and receipt.json.
The runtime asset is Y-up after glTF export, faces -Z, and has its rest-pose
foot soles on Y=0.
"""

import bpy
import argparse
import hashlib
import json
import math
import subprocess
import struct
import sys
from pathlib import Path
from mathutils import Vector


SCRIPT_PATH = Path(__file__).resolve()
OUT = SCRIPT_PATH.parent
BLEND_PATH = OUT / "explorer.blend"
GLB_PATH = OUT / "explorer.glb"
RECEIPT_PATH = OUT / "receipt.json"
PREVIEW_DIR = OUT / "previews"

CHARACTER_OBJECTS = []
MATERIALS = {}


def parse_args():
    parser = argparse.ArgumentParser(description="Generate the Pocket3D explorer character")
    parser.add_argument("--output-dir", type=Path, default=SCRIPT_PATH.parent)
    parser.add_argument("--skip-previews", action="store_true", help="do not render studio preview PNGs")
    blender_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(blender_args)


def configure_outputs(output_dir):
    global OUT, BLEND_PATH, GLB_PATH, RECEIPT_PATH, PREVIEW_DIR
    OUT = output_dir.expanduser().resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR = OUT / "previews"
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    BLEND_PATH = OUT / "explorer.blend"
    GLB_PATH = OUT / "explorer.glb"
    RECEIPT_PATH = OUT / "receipt.json"


def reset_scene():
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.armatures, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            datablocks.remove(block)


def mat(name, color, roughness=0.72, metallic=0.0):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    MATERIALS[name] = material
    return material


def finish_mesh(obj, material, smooth=True, bevel=0.0, bone=None):
    if material:
        obj.data.materials.append(material)
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if bevel > 0.0:
        modifier = obj.modifiers.new("Soft bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        modifier.limit_method = "ANGLE"
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)
    if bone:
        bind_rigid(obj, bone)
    CHARACTER_OBJECTS.append(obj)
    return obj


def bind_rigid(obj, bone_name):
    obj.parent = ARMATURE
    obj.matrix_parent_inverse = ARMATURE.matrix_world.inverted()
    modifier = obj.modifiers.new("Explorer rig", "ARMATURE")
    modifier.object = ARMATURE
    group = obj.vertex_groups.new(name=bone_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    obj["rigid_bone"] = bone_name


def uv_sphere(name, location, scale, material, bone, segments=16, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish_mesh(obj, material, True, 0.0, bone)


def ico(name, location, scale, material, bone, subdivisions=2):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish_mesh(obj, material, True, 0.0, bone)


def cube(name, location, scale, material, bone, bevel=0.04, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish_mesh(obj, material, True, bevel, bone)


def cone_between(name, start, end, r1, r2, material, bone, vertices=12):
    start, end = Vector(start), Vector(end)
    direction = end - start
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=r1,
        radius2=r2,
        depth=direction.length,
        location=(start + end) * 0.5,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(direction.normalized())
    return finish_mesh(obj, material, True, 0.01, bone)


def cylinder_between(name, start, end, radius, material, bone, vertices=12):
    return cone_between(name, start, end, radius, radius, material, bone, vertices)


def custom_mesh(name, vertices, faces, material, bone, bevel=0.0, smooth=False):
    mesh = bpy.data.meshes.new(f"{name}.mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish_mesh(obj, material, smooth, bevel, bone)


def tag_vertices(obj, group_name):
    """Mark source geometry for Blender-side QA without adding a deform bone."""
    group = obj.vertex_groups.new(name=group_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    return obj


def create_armature():
    data = bpy.data.armatures.new("ExplorerRig")
    armature = bpy.data.objects.new("ExplorerRig", data)
    bpy.context.collection.objects.link(armature)
    armature.show_in_front = True
    armature["runtime_contract"] = "Pocket3D Explorer v1"
    armature["front_axis"] = "-Z"
    armature["up_axis"] = "+Y"
    armature["rest_foot_y"] = 0.0
    armature["animation_contract"] = "Idle,Walk,Chop"
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    defs = {
        "root": ((0, 0, 0.00), (0, 0, 0.18), None),
        "hips": ((0, 0, 0.72), (0, 0, 1.02), "root"),
        "spine": ((0, 0, 1.02), (0, 0, 1.30), "hips"),
        "chest": ((0, 0, 1.30), (0, 0, 1.56), "spine"),
        "neck": ((0, 0, 1.56), (0, 0, 1.68), "chest"),
        "head": ((0, 0, 1.68), (0, 0, 2.05), "neck"),
        # The arm chains hang beside the torso. Blender local X is explicitly
        # rolled to the character's left/right axis below, so local-X rotation
        # produces front/back (+/-Y) swing instead of shoulder abduction.
        "upper_arm.L": ((0.35, 0, 1.49), (0.35, 0.015, 1.20), "chest"),
        "forearm.L": ((0.35, 0.015, 1.20), (0.36, 0.04, 0.96), "upper_arm.L"),
        "hand.L": ((0.36, 0.04, 0.96), (0.37, 0.10, 0.84), "forearm.L"),
        "upper_arm.R": ((-0.35, 0, 1.49), (-0.35, 0.015, 1.20), "chest"),
        "forearm.R": ((-0.35, 0.015, 1.20), (-0.36, 0.04, 0.96), "upper_arm.R"),
        "hand.R": ((-0.36, 0.04, 0.96), (-0.37, 0.10, 0.84), "forearm.R"),
        "thigh.L": ((0.16, 0, 0.78), (0.17, 0, 0.46), "hips"),
        "shin.L": ((0.17, 0, 0.46), (0.17, 0, 0.16), "thigh.L"),
        "foot.L": ((0.17, 0, 0.16), (0.17, 0.18, 0.055), "shin.L"),
        "thigh.R": ((-0.16, 0, 0.78), (-0.17, 0, 0.46), "hips"),
        "shin.R": ((-0.17, 0, 0.46), (-0.17, 0, 0.16), "thigh.R"),
        "foot.R": ((-0.17, 0, 0.16), (-0.17, 0.18, 0.055), "shin.R"),
        "axe.R": ((-0.37, 0.085, 0.91), (-0.31, 0.075, 0.20), "hand.R"),
    }
    for name, (head, tail, _) in defs.items():
        bone = data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.use_deform = True
    for name, (_, _, parent) in defs.items():
        if parent:
            data.edit_bones[name].parent = data.edit_bones[parent]
    for name in (
        "upper_arm.L", "forearm.L", "hand.L",
        "upper_arm.R", "forearm.R", "hand.R", "axe.R",
    ):
        data.edit_bones[name].align_roll(Vector((0, 1, 0)))
    bpy.ops.object.mode_set(mode="POSE")
    for pose_bone in armature.pose.bones:
        pose_bone.rotation_mode = "XYZ"
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.select_set(False)
    return armature


def create_character():
    # Compact warm/cool adventure palette, authored from scratch.
    skin = mat("Skin warm", (0.73, 0.39, 0.23), 0.82)
    skin_light = mat("Skin highlight", (0.93, 0.61, 0.38), 0.78)
    hair = mat("Hair auburn", (0.19, 0.055, 0.025), 0.88)
    hair_hi = mat("Hair edge", (0.37, 0.10, 0.035), 0.86)
    tunic = mat("Tunic teal", (0.035, 0.34, 0.32), 0.82)
    tunic_hi = mat("Tunic edge", (0.06, 0.53, 0.44), 0.80)
    cloth_dark = mat("Trouser charcoal", (0.055, 0.07, 0.075), 0.92)
    leather = mat("Leather umber", (0.24, 0.095, 0.035), 0.88)
    leather_hi = mat("Leather edge", (0.48, 0.21, 0.07), 0.84)
    cream = mat("Scarf cream", (0.86, 0.69, 0.42), 0.88)
    eye = mat("Eye ink", (0.012, 0.017, 0.014), 0.75)
    eye_hi = mat("Eye glint", (0.75, 0.94, 0.82), 0.52)
    metal = mat("Axe steel", (0.28, 0.38, 0.39), 0.35, 0.35)
    metal_hi = mat("Axe edge", (0.67, 0.79, 0.75), 0.28, 0.52)

    # Boots are authored first and establish exact z=0 sole contact.
    cube("Boot.L", (0.17, 0.075, 0.05), (0.145, 0.235, 0.10), leather, "foot.L", 0.045)
    cube("Boot.R", (-0.17, 0.075, 0.05), (0.145, 0.235, 0.10), leather, "foot.R", 0.045)
    cube("Boot toe.L", (0.17, 0.235, 0.085), (0.14, 0.16, 0.08), leather_hi, "foot.L", 0.05)
    cube("Boot toe.R", (-0.17, 0.235, 0.085), (0.14, 0.16, 0.08), leather_hi, "foot.R", 0.05)
    cylinder_between("Boot cuff.L", (0.17, 0, 0.16), (0.17, 0, 0.28), 0.15, leather_hi, "shin.L", 12)
    cylinder_between("Boot cuff.R", (-0.17, 0, 0.16), (-0.17, 0, 0.28), 0.15, leather_hi, "shin.R", 12)

    # Layered legs and articulated knee guards.
    cone_between("Trouser thigh.L", (0.16, 0, 0.72), (0.17, 0, 0.45), 0.16, 0.12, cloth_dark, "thigh.L", 12)
    cone_between("Trouser thigh.R", (-0.16, 0, 0.72), (-0.17, 0, 0.45), 0.16, 0.12, cloth_dark, "thigh.R", 12)
    cone_between("Legging.L", (0.17, 0, 0.45), (0.17, 0, 0.25), 0.115, 0.105, cream, "shin.L", 12)
    cone_between("Legging.R", (-0.17, 0, 0.45), (-0.17, 0, 0.25), 0.115, 0.105, cream, "shin.R", 12)
    cube("Knee guard.L", (0.17, 0.11, 0.45), (0.13, 0.055, 0.105), leather, "shin.L", 0.035, (math.radians(-8), 0, 0))
    cube("Knee guard.R", (-0.17, 0.11, 0.45), (0.13, 0.055, 0.105), leather, "shin.R", 0.035, (math.radians(-8), 0, 0))

    # Tapered tunic, asymmetric tabard, belt, buckle, and neck scarf.
    cone_between("Tunic torso", (0, 0, 0.78), (0, 0, 1.48), 0.34, 0.43, tunic, "chest", 12)
    cube("Tunic front panel", (0, 0.315, 1.04), (0.25, 0.038, 0.37), tunic_hi, "chest", 0.035, (math.radians(-3), 0, 0))
    # Split hem gives the silhouette depth beyond a primitive capsule.
    custom_mesh("Tabard.L", [(-0.02, .34, .96), (.31, .28, .96), (.27, .25, .66), (.04, .31, .72),
                              (-0.02, .27, .96), (.27, .22, .96), (.24, .20, .69), (.04, .25, .74)],
                [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)], tunic, "hips", 0.015)
    custom_mesh("Tabard.R", [(0.02,.34,.96),(-.31,.28,.96),(-.27,.25,.66),(-.04,.31,.72),
                              (.02,.27,.96),(-.27,.22,.96),(-.24,.20,.69),(-.04,.25,.74)],
                [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], tunic, "hips", 0.015)
    cylinder_between("Belt", (0, 0, 0.93), (0, 0, 1.02), 0.355, leather, "hips", 16)
    cube("Belt buckle", (0, 0.36, 0.975), (0.085, 0.035, 0.075), metal_hi, "hips", 0.018)
    cube("Belt pouch", (0.30, 0.08, 0.90), (0.11, 0.09, 0.14), leather_hi, "hips", 0.035, (0, math.radians(-10), math.radians(-12)))
    cone_between("Scarf", (0, 0, 1.49), (0, 0, 1.60), 0.25, 0.21, cream, "neck", 14)
    custom_mesh("Scarf tail", [(.04,-.18,1.55),(.22,-.12,1.48),(.16,-.10,1.09),(.02,-.14,1.23),
                               (.02,-.14,1.54),(.18,-.09,1.48),(.13,-.07,1.12),(0,-.10,1.25)],
                [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)], cream, "chest", 0.012)

    # Sleeves, bracers, and modeled hands with thumbs.
    arm_defs = [
        ("L", (0.30,0,1.49), (0.35,.015,1.20), (0.36,.04,.96), (0.37,.08,.89), "upper_arm.L", "forearm.L", "hand.L", 1),
        ("R", (-0.30,0,1.49), (-0.35,.015,1.20), (-0.36,.04,.96), (-0.37,.08,.89), "upper_arm.R", "forearm.R", "hand.R", -1),
    ]
    for side, shoulder, elbow, wrist, palm, upper_b, fore_b, hand_b, sign in arm_defs:
        cone_between(f"Tunic sleeve.{side}", shoulder, elbow, 0.18, 0.135, tunic_hi, upper_b, 12)
        cone_between(f"Forearm.{side}", elbow, wrist, 0.12, 0.09, skin_light, fore_b, 12)
        cone_between(f"Bracer.{side}", (Vector(elbow)*.58+Vector(wrist)*.42), wrist, 0.13, 0.105, leather, fore_b, 12)
        uv_sphere(f"Hand palm.{side}", palm, (0.105,0.085,0.115), skin_light, hand_b, 12, 8)
        uv_sphere(f"Hand thumb.{side}", (palm[0] + sign*.073, palm[1]+.065, palm[2]+.02), (0.05,.045,.068), skin, hand_b, 10, 6)
    # Shoulder guard offsets one side and breaks the primitive silhouette.
    ico("Shoulder guard.L", (0.32, 0.01, 1.46), (.19,.16,.16), leather_hi, "upper_arm.L", 2)

    # Expressive head: jaw, ears, nose, inset eyes, brows, hair cap and locks.
    uv_sphere("Head", (0, 0.015, 1.79), (0.285,0.25,0.32), skin_light, "head", 18, 12)
    uv_sphere("Jaw", (0, 0.155, 1.69), (.20,.12,.16), skin, "head", 14, 8)
    uv_sphere("Ear.L", (.27,.02,1.80), (.065,.04,.09), skin, "head", 10, 6)
    uv_sphere("Ear.R", (-.27,.02,1.80), (.065,.04,.09), skin, "head", 10, 6)
    custom_mesh("Nose", [(-.035,.255,1.82),(.035,.255,1.82),(0,.34,1.75),(-.03,.245,1.73),(.03,.245,1.73)],
                [(0,1,2),(0,2,3),(1,4,2),(3,2,4),(0,3,4,1)], skin, "head", 0.008)
    for side, x in (("L", .105), ("R", -.105)):
        uv_sphere(f"Eye.{side}", (x,.246,1.835), (.052,.018,.045), eye, "head", 12, 6)
        uv_sphere(f"Eye glint.{side}", (x + .014,.264,1.851), (.012,.007,.012), eye_hi, "head", 8, 4)
        cube(f"Brow.{side}", (x,.267,1.91), (.073,.013,.015), hair, "head", .008, (math.radians(-5), math.radians(0), math.radians(-8 if side == "L" else 8)))
    custom_mesh("Mouth", [(-.07,.289,1.69), (0,.299,1.675), (.07,.289,1.69), (0,.302,1.666)], [(0,1,3),(1,2,3)], hair_hi, "head")

    # Hair cap plus directional locks; all silhouette pieces are independently modeled.
    ico("Hair cap", (0,-.015,1.96), (.30,.26,.24), hair, "head", 2)
    lock_specs = [
        ("Hair lock crown", (-.04,.20,2.08), (.12,.08,.16), (math.radians(-18),0,math.radians(12))),
        ("Hair lock.L", (.23,.13,1.97), (.09,.07,.19), (math.radians(-15),math.radians(-7),math.radians(-18))),
        ("Hair lock.R", (-.23,.13,1.96), (.09,.07,.20), (math.radians(-15),math.radians(7),math.radians(18))),
        ("Hair side.L", (.27,-.01,1.76), (.075,.07,.20), (0,math.radians(-8),math.radians(-8))),
        ("Hair side.R", (-.27,-.01,1.76), (.075,.07,.20), (0,math.radians(8),math.radians(8))),
        ("Hair tail", (0,-.22,1.68), (.13,.08,.25), (math.radians(7),0,0)),
    ]
    for name, loc, scale, rot in lock_specs:
        cube(name, loc, scale, hair_hi, "head", .05, rot)

    # Axe is a real hand-bound assembly, rigidly weighted to axe.R.
    axe_lower = Vector((-0.31, 0.075, 0.20))
    axe_grip = Vector((-0.37, 0.085, 0.91))
    tag_vertices(
        cylinder_between("Axe handle", axe_lower, axe_grip, .035, leather_hi, "axe.R", 12),
        "QA.axe_handle",
    )
    # The right hand is on -X. The blade extends farther into -X than the
    # handle, keeping the cutting edge on the outside of the body.
    blade_vertices = [
        (-.32,.045,.34),(-.53,.045,.40),(-.68,.045,.31),(-.62,.045,.14),(-.36,.045,.11),
        (-.32,.105,.34),(-.53,.105,.40),(-.68,.105,.31),(-.62,.105,.14),(-.36,.105,.11),
    ]
    blade_faces = [(0,1,2,3,4),(5,9,8,7,6),(0,5,6,1),(1,6,7,2),(2,7,8,3),(3,8,9,4),(4,9,5,0)]
    tag_vertices(custom_mesh("Axe blade", blade_vertices, blade_faces, metal, "axe.R", .018), "QA.axe_blade")
    tag_vertices(
        cube("Axe cutting edge", (-.655,.075,.255), (.022,.038,.12), metal_hi, "axe.R", .012, (0,math.radians(10),0)),
        "QA.axe_blade",
    )
    tag_vertices(
        cylinder_between("Axe grip wrap", (-.35,.082,.70), axe_grip, .048, cream, "axe.R", 12),
        "QA.axe_handle",
    )


def join_character_meshes():
    """Collapse rigid pieces into one skinned mesh and one slot per material."""
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    active = CHARACTER_OBJECTS[0]
    # Joining every selected object in one operator call lets Blender choose an
    # internal object traversal order, which changes index buffers between
    # otherwise identical headless runs. Join in authored order instead.
    for obj in CHARACTER_OBJECTS[1:]:
        bpy.ops.object.select_all(action="DESELECT")
        active.select_set(True)
        obj.select_set(True)
        bpy.context.view_layer.objects.active = active
        result = bpy.ops.object.join()
        if "FINISHED" not in result:
            raise RuntimeError(f"Failed to join {obj.name}: {result}")
    active.name = "ExplorerMesh"
    active.data.name = "ExplorerMesh"

    # Join remaps polygon indices to the concatenated slots.  Capture names
    # before de-duplicating; assigning indices after clear() would otherwise
    # collapse every polygon to slot zero.
    polygon_material_names = [
        active.material_slots[polygon.material_index].material.name
        if active.material_slots[polygon.material_index].material else ""
        for polygon in active.data.polygons
    ]
    unique_materials = []
    material_index_by_pointer = {}
    slot_remap = {}
    for old_index, slot in enumerate(active.material_slots):
        material = slot.material
        if material is None:
            key = 0
        else:
            key = material.as_pointer()
        if key not in material_index_by_pointer:
            material_index_by_pointer[key] = len(unique_materials)
            unique_materials.append(material)
        slot_remap[old_index] = material_index_by_pointer[key]
    active.data.materials.clear()
    for material in unique_materials:
        active.data.materials.append(material)
    material_index_by_name = {
        slot.material.name if slot.material else "": index
        for index, slot in enumerate(active.material_slots)
    }
    for polygon, material_name in zip(active.data.polygons, polygon_material_names):
        polygon.material_index = material_index_by_name[material_name]

    armature_modifiers = [modifier for modifier in active.modifiers if modifier.type == "ARMATURE"]
    if not armature_modifiers:
        modifier = active.modifiers.new("Explorer rig", "ARMATURE")
        modifier.object = ARMATURE
    else:
        armature_modifiers[0].object = ARMATURE
        for modifier in armature_modifiers[1:]:
            active.modifiers.remove(modifier)
    active.parent = ARMATURE
    active.matrix_parent_inverse = ARMATURE.matrix_world.inverted()

    required_groups = {
        "hips", "chest", "neck", "head", "upper_arm.L", "forearm.L", "hand.L",
        "upper_arm.R", "forearm.R", "hand.R", "thigh.L", "shin.L", "foot.L",
        "thigh.R", "shin.R", "foot.R", "axe.R",
    }
    present_groups = {group.name for group in active.vertex_groups}
    missing_groups = sorted(required_groups - present_groups)
    if missing_groups:
        raise RuntimeError(f"Joined mesh lost vertex groups: {missing_groups}")
    missing_qa_groups = sorted({"QA.axe_blade", "QA.axe_handle"} - present_groups)
    if missing_qa_groups:
        raise RuntimeError(f"Joined mesh lost QA groups: {missing_qa_groups}")
    deform_bones = {bone.name for bone in ARMATURE.data.bones}
    deform_group_indices = {
        group.index: group.name
        for group in active.vertex_groups
        if group.name in deform_bones
    }
    weighted_counts = {name: 0 for name in deform_bones}
    for vertex in active.data.vertices:
        memberships = [
            entry
            for entry in vertex.groups
            if entry.group in deform_group_indices and entry.weight > 0.00001
        ]
        if len(memberships) != 1 or abs(memberships[0].weight - 1.0) > 0.0001:
            raise RuntimeError(f"Vertex {vertex.index} is not rigidly weighted: {memberships}")
        weighted_counts[deform_group_indices[memberships[0].group]] += 1
    if weighted_counts.get("hand.R", 0) == 0 or weighted_counts.get("axe.R", 0) == 0:
        raise RuntimeError(f"Right hand or axe weights missing: {weighted_counts}")

    CHARACTER_OBJECTS.clear()
    CHARACTER_OBJECTS.append(active)
    active["mesh_contract"] = "one rigid weight per vertex"
    active["material_slots_deduplicated"] = True
    return active, weighted_counts


def reset_pose():
    for pb in ARMATURE.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)


def key_pose(action, frame, rotations=None, locations=None, scales=None):
    # Frame evaluation must happen before authoring the pose.  Blender 5.1
    # evaluates the active Action during frame_set(), which would otherwise
    # replace the values we are about to key with the previous keyframe.
    bpy.context.scene.frame_set(frame)
    reset_pose()
    rotations = rotations or {}
    locations = locations or {}
    scales = scales or {}
    for name, value in rotations.items():
        ARMATURE.pose.bones[name].rotation_euler = value
    for name, value in locations.items():
        ARMATURE.pose.bones[name].location = value
    for name, value in scales.items():
        ARMATURE.pose.bones[name].scale = value
    for pb in ARMATURE.pose.bones:
        pb.keyframe_insert("rotation_euler", frame=frame, group=pb.name)
        pb.keyframe_insert("location", frame=frame, group=pb.name)
        pb.keyframe_insert("scale", frame=frame, group=pb.name)


def action_begin(name):
    action = bpy.data.actions.new(name=name)
    action.use_fake_user = True
    ARMATURE.animation_data_create()
    ARMATURE.animation_data.action = action
    return action


def create_actions():
    idle = action_begin("Idle")
    idle_poses = {
        1: ({"chest": (0.0,0.0,-.025), "head": (.015,0,.025), "upper_arm.L": (.03,0,0), "upper_arm.R": (-.03,0,0)}, {"hips": (0,0,0)}),
        24: ({"chest": (.025,0,.025), "head": (-.02,.015,-.035), "upper_arm.L": (-.035,0,0), "upper_arm.R": (.035,0,0)}, {"hips": (0,0,.014)}),
        48: ({"chest": (0.0,0.0,-.025), "head": (.015,0,.025), "upper_arm.L": (.03,0,0), "upper_arm.R": (-.03,0,0)}, {"hips": (0,0,0)}),
    }
    for frame,(rots,locs) in idle_poses.items(): key_pose(idle,frame,rots,locs)
    idle["loop"] = True

    walk = action_begin("Walk")
    # Contact / passing / opposite-contact sequence. Local X swings limbs front-back.
    walk_poses = {
        1: ({"thigh.L": (-.55,0,.03), "shin.L": (.18,0,0), "foot.L": (.15,0,0),
             "thigh.R": (.48,0,-.03), "shin.R": (.46,0,0), "foot.R": (-.18,0,0),
             "upper_arm.L": (.58,0,0), "forearm.L": (-.18,0,0),
             "upper_arm.R": (-.58,0,0), "forearm.R": (-.12,0,0)}, {"hips": (0,-.029,0)}),
        9: ({"thigh.L": (-.05,0,0), "shin.L": (.18,0,0), "thigh.R": (.04,0,0), "shin.R": (.18,0,0),
             "upper_arm.L": (.05,0,0), "upper_arm.R": (-.05,0,0)}, {"hips": (0,0,0)}),
        17: ({"thigh.L": (.48,0,-.03), "shin.L": (.46,0,0), "foot.L": (-.18,0,0),
              "thigh.R": (-.55,0,.03), "shin.R": (.18,0,0), "foot.R": (.15,0,0),
              "upper_arm.L": (-.58,0,0), "forearm.L": (-.12,0,0),
              "upper_arm.R": (.58,0,0), "forearm.R": (-.18,0,0)}, {"hips": (0,-.030,0)}),
        25: ({"thigh.L": (.04,0,0), "shin.L": (.18,0,0), "thigh.R": (-.05,0,0), "shin.R": (.18,0,0),
              "upper_arm.L": (-.05,0,0), "upper_arm.R": (.05,0,0)}, {"hips": (0,0,0)}),
        33: ({"thigh.L": (-.55,0,.03), "shin.L": (.18,0,0), "foot.L": (.15,0,0),
              "thigh.R": (.48,0,-.03), "shin.R": (.46,0,0), "foot.R": (-.18,0,0),
              "upper_arm.L": (.58,0,0), "forearm.L": (-.18,0,0),
              "upper_arm.R": (-.58,0,0), "forearm.R": (-.12,0,0)}, {"hips": (0,-.029,0)}),
    }
    for frame,(rots,locs) in walk_poses.items(): key_pose(walk,frame,rots,locs)
    walk["loop"] = True

    chop = action_begin("Chop")
    chop_poses = {
        1: ({"upper_arm.L": (.05,0,-.04), "upper_arm.R": (-.04,0,.04), "forearm.R": (-.08,0,0)}, {"hips": (0,0,0)}),
        8: ({"chest": (-.12,-.06,-.22), "head": (.05,.02,.12),
             "upper_arm.R": (-1.25,.15,-.30), "forearm.R": (-.75,.05,.10), "hand.R": (-.20,0,.12),
             "upper_arm.L": (.30,0,.25), "forearm.L": (-.25,0,0), "axe.R": (0,.08,-.12)}, {"hips": (0,0,.02)}),
        14: ({"chest": (-.20,-.10,-.32), "head": (.08,.03,.16),
              "upper_arm.R": (-1.48,.18,-.38), "forearm.R": (-.92,.08,.15), "hand.R": (-.28,0,.18),
              "upper_arm.L": (.35,0,.30), "forearm.L": (-.30,0,0), "axe.R": (0,.12,-.16)}, {"hips": (0,0,.04)}),
        22: ({"chest": (.42,.08,.34), "head": (-.12,-.04,-.18),
              "upper_arm.R": (.92,-.12,.34), "forearm.R": (.58,-.05,-.16), "hand.R": (.22,0,-.12),
              "upper_arm.L": (-.42,0,-.25), "forearm.L": (.25,0,0), "axe.R": (0,-.08,.10)}, {"hips": (0,0,-.025)}),
        27: ({"chest": (.28,.04,.20), "head": (-.08,-.02,-.12),
              "upper_arm.R": (.62,-.08,.20), "forearm.R": (.38,0,-.10), "hand.R": (.14,0,-.08),
              "upper_arm.L": (-.28,0,-.16)}, {"hips": (0,0,-.012)}),
        36: ({"upper_arm.L": (.05,0,-.04), "upper_arm.R": (-.04,0,.04), "forearm.R": (-.08,0,0)}, {"hips": (0,0,0)}),
    }
    for frame,(rots,locs) in chop_poses.items(): key_pose(chop,frame,rots,locs)
    chop["loop"] = False

    ARMATURE.animation_data.action = idle
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = 48
    bpy.context.scene.frame_set(1)
    return {"Idle": idle, "Walk": walk, "Chop": chop}


def create_studio():
    floor_mat = mat("Studio floor", (.055,.09,.08), .94)
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0,0,-.006))
    floor = bpy.context.object
    floor.name = "PREVIEW Studio Floor"
    floor.data.materials.append(floor_mat)

    world = bpy.context.scene.world or bpy.data.worlds.new("Studio World")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (.018,.030,.028,1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = .26

    def area(name, location, energy, size, color):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = location
        look_at(obj, Vector((0,0,1.05)))
        return obj

    area("Key", (3.4,4.2,5.2), 900, 4.0, (1.0,.76,.55))
    area("Fill", (-3.5,2.0,2.8), 650, 3.5, (.50,.74,1.0))
    area("Rim", (0,-4.0,3.3), 1000, 3.0, (.36,1.0,.68))

    camera_data = bpy.data.cameras.new("Studio Camera")
    camera = bpy.data.objects.new("Studio Camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (3.4,5.7,2.55)
    camera_data.lens = 58
    camera_data.sensor_width = 36
    look_at(camera, Vector((0,0.05,1.05)))
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100
    scene.render.fps = 30
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.render.image_settings.compression = 40
    scene.view_settings.look = "AgX - Medium High Contrast"
    return floor


def look_at(obj, target):
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def export_glb():
    bpy.ops.object.select_all(action="DESELECT")
    ARMATURE.select_set(True)
    for obj in CHARACTER_OBJECTS:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = ARMATURE
    reset_pose()
    bpy.context.scene.frame_set(1)
    result = bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_materials="EXPORT",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
        export_skins=True,
        export_all_influences=False,
        export_influence_nb=4,
        export_def_bones=True,
        export_leaf_bone=False,
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=True,
        export_armature_object_remove=False,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_current_frame=False,
        export_apply=False,
    )
    if "FINISHED" not in result:
        raise RuntimeError(f"glTF export failed: {result}")


def canonicalize_glb():
    """Normalize exporter-only ordering and sub-micro UV round-off in-place."""
    raw = bytearray(GLB_PATH.read_bytes())
    json_length, json_kind = struct.unpack_from("<II", raw, 12)
    if json_kind != 0x4E4F534A:
        raise RuntimeError("Missing GLB JSON chunk during canonicalization")
    document = json.loads(raw[20:20 + json_length].decode("utf-8"))
    binary_header = 20 + json_length
    binary_length, binary_kind = struct.unpack_from("<II", raw, binary_header)
    if binary_kind != 0x004E4942:
        raise RuntimeError("Missing GLB BIN chunk during canonicalization")
    binary_start = binary_header + 8
    accessors = document.get("accessors", [])
    views = document.get("bufferViews", [])

    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            index_accessor = accessors[primitive["indices"]]
            if index_accessor["componentType"] not in (5123, 5125):
                raise RuntimeError(f"Unsupported index type: {index_accessor['componentType']}")
            index_format = "H" if index_accessor["componentType"] == 5123 else "I"
            index_view = views[index_accessor["bufferView"]]
            index_offset = binary_start + index_view.get("byteOffset", 0) + index_accessor.get("byteOffset", 0)
            index_count = index_accessor["count"]
            indices = struct.unpack_from(f"<{index_count}{index_format}", raw, index_offset)
            if index_count % 3:
                raise RuntimeError(f"Non-triangle index count: {index_count}")
            triangles = []
            for start in range(0, index_count, 3):
                triangle = indices[start:start + 3]
                # Cyclic rotation retains winding while producing one canonical
                # representation for the same triangle.
                triangles.append(min(
                    triangle,
                    (triangle[1], triangle[2], triangle[0]),
                    (triangle[2], triangle[0], triangle[1]),
                ))
            canonical_indices = [index for triangle in sorted(triangles) for index in triangle]
            struct.pack_into(f"<{index_count}{index_format}", raw, index_offset, *canonical_indices)

            for semantic, accessor_id in primitive.get("attributes", {}).items():
                if not semantic.startswith("TEXCOORD_"):
                    continue
                accessor = accessors[accessor_id]
                if accessor["componentType"] != 5126 or accessor["type"] != "VEC2":
                    continue
                view = views[accessor["bufferView"]]
                offset = binary_start + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
                float_count = accessor["count"] * 2
                values = struct.unpack_from(f"<{float_count}f", raw, offset)
                quantized = [round(value, 6) for value in values]
                struct.pack_into(f"<{float_count}f", raw, offset, *quantized)

    if binary_start + binary_length != len(raw):
        raise RuntimeError("Unexpected GLB trailing data")
    GLB_PATH.write_bytes(raw)


def render_previews(actions):
    camera = bpy.context.scene.camera
    views = (
        ("idle", "Idle", 24, (3.4, 5.7, 2.55)),
        ("walk", "Walk", 1, (3.4, 5.7, 2.55)),
        ("chop", "Chop", 22, (3.4, 5.7, 2.55)),
        # Orthographic intent with a perspective camera: the centered rear and
        # side views make lateral arm abduction impossible to hide.
        ("walk-rear", "Walk", 1, (0.0, -5.8, 2.1)),
        ("walk-side", "Walk", 1, (5.8, 0.0, 2.1)),
    )
    for name, action_name, frame, camera_location in views:
        ARMATURE.animation_data.action = actions[action_name]
        bpy.context.scene.frame_set(frame)
        camera.location = camera_location
        look_at(camera, Vector((0, 0.05, 1.05)))
        bpy.context.scene.render.filepath = str(PREVIEW_DIR / f"{name}.png")
        bpy.ops.render.render(write_still=True)
    ARMATURE.animation_data.action = actions["Idle"]
    bpy.context.scene.frame_set(1)


def parse_glb(path):
    raw = path.read_bytes()
    magic, version, total = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF" or version != 2 or total != len(raw):
        raise RuntimeError("Invalid GLB 2 header")
    json_len, json_kind = struct.unpack_from("<II", raw, 12)
    if json_kind != 0x4E4F534A:
        raise RuntimeError("Missing GLB JSON chunk")
    doc = json.loads(raw[20:20+json_len].decode("utf-8"))
    animations = [a.get("name", "") for a in doc.get("animations", [])]
    nodes = [n.get("name", "") for n in doc.get("nodes", [])]
    required_bones = ["root","hips","spine","chest","neck","head","upper_arm.L","forearm.L","hand.L",
                      "upper_arm.R","forearm.R","hand.R","thigh.L","shin.L","foot.L","thigh.R","shin.R","foot.R","axe.R"]
    if set(animations) != {"Idle","Walk","Chop"}:
        raise RuntimeError(f"Animation contract mismatch: {animations}")
    missing = sorted(set(required_bones) - set(nodes))
    if missing:
        raise RuntimeError(f"Missing bones/nodes: {missing}")
    if len(doc.get("skins", [])) != 1:
        raise RuntimeError(f"Expected exactly one skin, got {len(doc.get('skins', []))}")
    triangle_count = 0
    exported_vertex_count = 0
    primitive_count = 0
    accessors = doc.get("accessors", [])
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            primitive_count += 1
            position_accessor = primitive.get("attributes", {}).get("POSITION")
            if position_accessor is not None:
                exported_vertex_count += accessors[position_accessor]["count"]
            if primitive.get("mode", 4) == 4 and "indices" in primitive:
                triangle_count += accessors[primitive["indices"]]["count"] // 3
    if triangle_count > 8000:
        raise RuntimeError(f"Triangle budget exceeded: {triangle_count}")
    if len(doc.get("meshes", [])) != 1 or primitive_count > 14:
        raise RuntimeError(
            f"Runtime mesh was not collapsed: meshes={len(doc.get('meshes', []))}, primitives={primitive_count}"
        )
    clips = {}
    for animation in doc.get("animations", []):
        durations = []
        for sampler in animation.get("samplers", []):
            accessor = accessors[sampler["input"]]
            durations.extend(accessor.get("max", []))
        clips[animation.get("name", "")] = {
            "channels": len(animation.get("channels", [])),
            "duration_seconds": round(max(durations, default=0.0), 4),
        }
    if any(clip["channels"] < 3 for clip in clips.values()):
        raise RuntimeError(f"Animations have insufficient channels: {clips}")
    external_buffers = [buffer.get("uri") for buffer in doc.get("buffers", []) if buffer.get("uri")]
    external_images = [image.get("uri") for image in doc.get("images", []) if image.get("uri")]
    stats = {
        "glb_bytes": len(raw),
        "up_axis": "+Y",
        "front_axis": "-Z",
        "rest_foot_y": 0.0,
        "meshes": len(doc.get("meshes", [])),
        "primitives": primitive_count,
        "exported_vertices": exported_vertex_count,
        "triangles": triangle_count,
        "material_names": [m.get("name","") for m in doc.get("materials",[])],
        "skins": len(doc.get("skins", [])),
        "joint_count": len(doc["skins"][0].get("joints", [])),
        "clips": clips,
        "self_contained": not external_buffers and not external_images,
        "external_buffers": external_buffers,
        "external_images": external_images,
    }
    if stats["joint_count"] != 19:
        raise RuntimeError(f"Joint contract mismatch: {stats['joint_count']}")
    if not stats["self_contained"]:
        raise RuntimeError("GLB contains external buffer references")
    return stats


def validate_scene_rest_pose():
    reset_pose()
    bpy.context.scene.frame_set(1)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    min_z = float("inf")
    for obj in CHARACTER_OBJECTS:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        for vertex in mesh.vertices:
            min_z = min(min_z, (evaluated.matrix_world @ vertex.co).z)
        evaluated.to_mesh_clear()
    if abs(min_z) > 0.001:
        raise RuntimeError(f"Rest feet are not grounded: min Blender Z={min_z}")
    return min_z


def weighted_group_vertex_indices(group_name):
    mesh_object = CHARACTER_OBJECTS[0]
    group = mesh_object.vertex_groups.get(group_name)
    if group is None:
        raise RuntimeError(f"Missing weighted group {group_name}")
    vertex_indices = [
        vertex.index
        for vertex in mesh_object.data.vertices
        if any(entry.group == group.index and entry.weight > 0.5 for entry in vertex.groups)
    ]
    if not vertex_indices:
        raise RuntimeError(f"Weighted group {group_name} has no vertices")
    return vertex_indices


def weighted_group_min_z(group_name):
    mesh_object = CHARACTER_OBJECTS[0]
    vertex_indices = weighted_group_vertex_indices(group_name)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh_object.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    minimum = min((evaluated.matrix_world @ mesh.vertices[index].co).z for index in vertex_indices)
    evaluated.to_mesh_clear()
    return minimum


def weighted_group_centroid(group_name):
    mesh_object = CHARACTER_OBJECTS[0]
    vertex_indices = weighted_group_vertex_indices(group_name)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh_object.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    centroid = sum(
        (evaluated.matrix_world @ mesh.vertices[index].co for index in vertex_indices),
        Vector((0, 0, 0)),
    ) / len(vertex_indices)
    evaluated.to_mesh_clear()
    return centroid


def validate_action_motion(actions):
    def tail(action_name, frame, bone_name):
        ARMATURE.animation_data.action = actions[action_name]
        bpy.context.scene.frame_set(frame)
        return ARMATURE.matrix_world @ ARMATURE.pose.bones[bone_name].tail

    walk_stride = (tail("Walk", 1, "foot.L") - tail("Walk", 17, "foot.L")).length
    chop_hand_travel = (tail("Chop", 1, "hand.R") - tail("Chop", 14, "hand.R")).length
    chop_axe_swing = (tail("Chop", 14, "axe.R") - tail("Chop", 22, "axe.R")).length

    walk_hands = {
        side: (tail("Walk", 1, f"hand.{side}"), tail("Walk", 17, f"hand.{side}"))
        for side in ("L", "R")
    }
    walk_hand_deltas = {
        side: positions[1] - positions[0]
        for side, positions in walk_hands.items()
    }
    walk_arm_forward_travel = min(abs(delta.y) for delta in walk_hand_deltas.values())
    walk_arm_lateral_drift = max(abs(delta.x) for delta in walk_hand_deltas.values())
    walk_arm_phase_error = abs(walk_hand_deltas["L"].y + walk_hand_deltas["R"].y)
    walk_arm_local_x_alignment = min(
        abs(ARMATURE.data.bones[name].matrix_local.to_3x3().col[0].normalized().dot(Vector((1, 0, 0))))
        for name in ("upper_arm.L", "upper_arm.R")
    )

    ARMATURE.animation_data.action = actions["Idle"]
    bpy.context.scene.frame_set(1)
    axe_blade_rest_centroid = weighted_group_centroid("QA.axe_blade")
    axe_handle_rest_centroid = weighted_group_centroid("QA.axe_handle")
    axe_outward_offsets = []
    axe_center_clearances = []
    for action_name, action in actions.items():
        ARMATURE.animation_data.action = action
        frame_start, frame_end = (int(round(value)) for value in action.frame_range)
        for frame in range(frame_start, frame_end + 1):
            bpy.context.scene.frame_set(frame)
            blade = weighted_group_centroid("QA.axe_blade")
            handle = weighted_group_centroid("QA.axe_handle")
            # Right side is Blender -X. Positive offset means blade is farther
            # outward than its handle; positive clearance means it stays on the
            # right side of the character center.
            axe_outward_offsets.append(handle.x - blade.x)
            axe_center_clearances.append(-blade.x)
    ARMATURE.animation_data.action = actions["Chop"]
    bpy.context.scene.frame_set(14)
    chop_blade_windup = weighted_group_centroid("QA.axe_blade")
    bpy.context.scene.frame_set(22)
    chop_blade_impact = weighted_group_centroid("QA.axe_blade")
    axe_blade_forward_travel = abs(chop_blade_impact.y - chop_blade_windup.y)
    axe_blade_outward_min = min(axe_outward_offsets)
    axe_blade_center_clearance_min = min(axe_center_clearances)

    walk_contacts = []
    ARMATURE.animation_data.action = actions["Walk"]
    for frame in (1, 5, 9, 13, 17, 21, 25, 29, 33):
        bpy.context.scene.frame_set(frame)
        walk_contacts.append(min(weighted_group_min_z("foot.L"), weighted_group_min_z("foot.R")))
    chop_contacts = []
    ARMATURE.animation_data.action = actions["Chop"]
    for frame in (1, 8, 14, 18, 22, 27, 36):
        bpy.context.scene.frame_set(frame)
        chop_contacts.append(min(weighted_group_min_z("foot.L"), weighted_group_min_z("foot.R")))

    if walk_stride < 0.35:
        raise RuntimeError(f"Walk stride is static: {walk_stride}")
    if chop_hand_travel < 0.25 or chop_axe_swing < 0.45:
        raise RuntimeError(f"Chop is static: hand={chop_hand_travel}, axe={chop_axe_swing}")
    if walk_arm_local_x_alignment < 0.995:
        raise RuntimeError(f"Arm local X is not lateral: {walk_arm_local_x_alignment}")
    if walk_arm_forward_travel < 0.40:
        raise RuntimeError(f"Walk arms do not travel front/back: {walk_arm_forward_travel}")
    if walk_arm_lateral_drift > 0.05:
        raise RuntimeError(f"Walk arms drift laterally: {walk_arm_lateral_drift}")
    if walk_hand_deltas["L"].y * walk_hand_deltas["R"].y >= 0 or walk_arm_phase_error > 0.05:
        raise RuntimeError(f"Walk arms are not opposed: {walk_hand_deltas}")
    if axe_blade_outward_min < 0.075 or axe_blade_center_clearance_min < 0.20:
        raise RuntimeError(
            f"Axe blade turns inward: offset={axe_blade_outward_min}, "
            f"center_clearance={axe_blade_center_clearance_min}"
        )
    if axe_blade_forward_travel < 0.50:
        raise RuntimeError(f"Axe does not chop forward: {axe_blade_forward_travel}")
    if max(abs(value) for value in walk_contacts) > 0.008:
        raise RuntimeError(f"Walk has no planted foot: {walk_contacts}")
    if max(abs(value) for value in chop_contacts) > 0.002:
        raise RuntimeError(f"Chop lifts or sinks planted feet: {chop_contacts}")
    return {
        "walk_stride_m": round(walk_stride, 4),
        "chop_hand_travel_m": round(chop_hand_travel, 4),
        "chop_axe_swing_m": round(chop_axe_swing, 4),
        "walk_arm_forward_travel_m": round(walk_arm_forward_travel, 4),
        "walk_arm_lateral_drift_m": round(walk_arm_lateral_drift, 4),
        "walk_arm_phase_error_m": round(walk_arm_phase_error, 4),
        "walk_arm_local_x_alignment": round(walk_arm_local_x_alignment, 5),
        "axe_blade_outward": True,
        "axe_blade_outward_min_m": round(axe_blade_outward_min, 4),
        "axe_blade_center_clearance_min_m": round(axe_blade_center_clearance_min, 4),
        "axe_blade_forward_travel_m": round(axe_blade_forward_travel, 4),
        "axe_blade_rest_centroid_blender_xyz": [round(value, 4) for value in axe_blade_rest_centroid],
        "axe_handle_rest_centroid_blender_xyz": [round(value, 4) for value in axe_handle_rest_centroid],
        "axe_blade_rest_outward_from_handle_m": round(axe_handle_rest_centroid.x - axe_blade_rest_centroid.x, 4),
        "axe_blade_rest_center_clearance_m": round(-axe_blade_rest_centroid.x, 4),
        "walk_contact_max_error_m": round(max(abs(value) for value in walk_contacts), 4),
        "chop_contact_max_error_m": round(max(abs(value) for value in chop_contacts), 4),
    }


def fresh_import_validate():
    blender_binary = Path(bpy.app.binary_path)
    expression = (
        "import bpy,json;"
        f"bpy.ops.import_scene.gltf(filepath={json.dumps(str(GLB_PATH))});"
        "arms=[o for o in bpy.context.scene.objects if o.type=='ARMATURE'];"
        "meshes=[o for o in bpy.context.scene.objects if o.type=='MESH' and any(m.type=='ARMATURE' for m in o.modifiers)];"
        "payload={'armatures':len(arms),'meshes':len(meshes),"
        "'bones':sorted(b.name for b in arms[0].data.bones) if arms else [],"
        "'actions':sorted(a.name for a in bpy.data.actions)};"
        "print('FRESH_IMPORT_JSON '+json.dumps(payload,sort_keys=True))"
    )
    result = subprocess.run(
        [str(blender_binary), "--background", "--factory-startup", "--python-expr", expression],
        capture_output=True,
        text=True,
        check=False,
    )
    combined = result.stdout + "\n" + result.stderr
    marker = "FRESH_IMPORT_JSON "
    payload_line = next((line for line in combined.splitlines() if line.startswith(marker)), None)
    if result.returncode != 0 or payload_line is None:
        raise RuntimeError(f"Fresh GLB import failed ({result.returncode}):\n{combined}")
    payload = json.loads(payload_line[len(marker):])
    required_bones = [
        "root", "hips", "spine", "chest", "neck", "head", "upper_arm.L",
        "forearm.L", "hand.L", "upper_arm.R", "forearm.R", "hand.R", "thigh.L",
        "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R", "axe.R",
    ]
    expected = {
        "armatures": 1,
        "meshes": 1,
        "bones": sorted(required_bones),
        "actions": ["Chop", "Idle", "Walk"],
    }
    if payload != expected:
        raise RuntimeError(f"Fresh import contract mismatch: {payload} != {expected}")
    return {"passed": True, **payload}


def main():
    global ARMATURE
    args = parse_args()
    configure_outputs(args.output_dir)
    # Blender otherwise creates a sibling `.blend1` backup on every
    # regeneration. The generated `.blend` is already reproducible from this
    # script, so keep the asset directory free of stale binary snapshots.
    bpy.context.preferences.filepaths.save_version = 0
    reset_scene()
    ARMATURE = create_armature()
    create_character()
    explorer_mesh, weighted_counts = join_character_meshes()
    actions = create_actions()
    floor = create_studio()
    motion_metrics = validate_action_motion(actions)
    ARMATURE.animation_data.action = actions["Idle"]
    min_z = validate_scene_rest_pose()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=True)
    export_glb()
    canonicalize_glb()
    if not args.skip_previews:
        render_previews(actions)
    stats = parse_glb(GLB_PATH)
    fresh_import = fresh_import_validate()
    receipt = {
        "schema": "pocket3d-character-receipt-v1",
        "generator": {
            "blender_version": bpy.app.version_string,
            "script": "generate_character.py",
        },
        "outputs": {
            "blend": BLEND_PATH.name,
            "glb": GLB_PATH.name,
            "glb_sha256": hashlib.sha256(GLB_PATH.read_bytes()).hexdigest(),
            "previews": [] if args.skip_previews else [
                "previews/idle.png",
                "previews/walk.png",
                "previews/chop.png",
                "previews/walk-rear.png",
                "previews/walk-side.png",
            ],
        },
        "geometry": {
            "source_vertices": len(explorer_mesh.data.vertices),
            "source_triangles": sum(len(polygon.vertices) - 2 for polygon in explorer_mesh.data.polygons),
            "exported_vertices": stats["exported_vertices"],
            "exported_triangles": stats["triangles"],
            "meshes": stats["meshes"],
            "primitives": stats["primitives"],
            "material_count": len(stats["material_names"]),
            "materials": stats["material_names"],
        },
        "rig": {
            "skins": stats["skins"],
            "bone_count": stats["joint_count"],
            "bones": fresh_import["bones"],
            "rigid_weighted_vertices_by_bone": {name: count for name, count in weighted_counts.items() if count},
            "up_axis": stats["up_axis"],
            "front_axis": stats["front_axis"],
            "rest_foot_y": stats["rest_foot_y"],
        },
        "clips": stats["clips"],
        "tests": {
            "blender_rest_min_z": round(min_z, 6),
            **motion_metrics,
            "glb_self_contained": stats["self_contained"],
            "fresh_import": fresh_import,
        },
    }
    RECEIPT_PATH.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print("POCKET3D_EXPLORER_OK", json.dumps(receipt, sort_keys=True))


if __name__ == "__main__":
    main()
