"""Models the environment props of the 3D table in Blender and exports
them as GLB files with painted vertex colours (no textures).

Run with Blender's Python module (pip install bpy) or Blender itself:

    python scripts/blender/build_props.py            # writes public/models/env/
    blender -b -P scripts/blender/build_props.py

Every prop has its origin at the centre of its base; 1 unit = 1 map cell.
"""

import math
import os
import random

import bpy
import bmesh
from mathutils import Vector, noise

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models', 'env')


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def activate(obj):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_all(obj):
    activate(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def mod(obj, kind, **props):
    m = obj.modifiers.new(name=kind.lower(), type=kind)
    for k, v in props.items():
        setattr(m, k, v)
    return m


def tex(kind='CLOUDS', size=0.4, depth=2, seed_shift=0.0):
    t = bpy.data.textures.new(f'{kind}-{random.random()}', type=kind)
    if hasattr(t, 'noise_scale'):
        t.noise_scale = size
    if hasattr(t, 'noise_depth'):
        t.noise_depth = depth
    if hasattr(t, 'intensity'):
        t.intensity = 1.0 + seed_shift
    return t


def displace(obj, strength, size=0.4, kind='CLOUDS'):
    m = mod(obj, 'DISPLACE', strength=strength, mid_level=0.5)
    m.texture = tex(kind, size)
    m.texture_coords = 'OBJECT' if False else 'LOCAL'
    return m


def paint(obj, base, var=0.12, dark_bottom=0.35, height=1.0, seed=0, crevice=0.25):
    """Vertex colours: base tint, per-face jitter, darker towards the
    ground and in concave spots — a cheap hand-painted look."""
    me = obj.data
    if not me.color_attributes:
        me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
    col = me.color_attributes[0]
    rnd = random.Random(seed)
    face_tint = [1 + (rnd.random() - 0.5) * 2 * var for _ in me.polygons]
    mw = obj.matrix_world
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index]
            p = mw @ v.co
            h = max(0.0, min(1.0, p.z / max(height, 1e-6)))
            shade = (1 - dark_bottom) + dark_bottom * h
            n = noise.noise(p * 3.1 + Vector((seed, seed, seed)))
            shade *= 1 + n * 0.15
            # downward faces read as occluded
            shade *= 1 - crevice * max(0.0, -poly.normal.z)
            k = face_tint[poly.index] * shade
            col.data[li].color = (min(1, base[0] * k), min(1, base[1] * k), min(1, base[2] * k), 1)
    me.color_attributes.active_color = col


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    return obj


def cube(size, loc=(0, 0, 0), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return o


def cyl(r, depth, loc=(0, 0, 0), rot=(0, 0, 0), verts=12, r2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r if r2 is None else r2, depth=depth, location=loc, rotation=rot)
    return bpy.context.active_object


def ico(r, loc=(0, 0, 0), sub=2):
    bpy.ops.mesh.primitive_ico_sphere_add(radius=r, subdivisions=sub, location=loc)
    return bpy.context.active_object


def material():
    m = bpy.data.materials.new('painted')
    m.use_nodes = True
    nodes = m.node_tree.nodes
    bsdf = nodes.get('Principled BSDF')
    attr = nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    m.node_tree.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.9
    return m


def export(obj, name):
    obj.data.materials.clear()
    obj.data.materials.append(material())
    # origin at base centre
    activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.shade_flat()
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f'{name}.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True,
        export_vertex_color='ACTIVE', export_yup=True, export_normals=True,
    )
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f'{name}: {tris} tris, {os.path.getsize(path) // 1024} KB')


def stone_rgb(rnd, base=(0.36, 0.33, 0.36)):
    k = 0.8 + rnd.random() * 0.4
    warm = (rnd.random() - 0.5) * 0.06
    return (base[0] * k + warm, base[1] * k, base[2] * k - warm)


# ---------------------------------------------------------------------------
# props
# ---------------------------------------------------------------------------

def wall(seed, name, height=1.5, palette=(0.34, 0.31, 0.36)):
    """A 1×1 cell block of irregular, bevelled stones around a core."""
    reset()
    rnd = random.Random(seed)
    parts = []
    core = cube((0.94, 0.94, height * 0.98), (0, 0, height * 0.49))
    paint(core, (0.08, 0.07, 0.08), height=height, seed=seed)
    parts.append(core)
    rows = 6
    rh = height / rows
    for r in range(rows):
        for side in range(4):
            n = 2 if (r + side) % 2 else 3
            for i in range(n):
                w = 1.0 / n
                x = -0.5 + w * (i + 0.5) + (rnd.random() - 0.5) * 0.04
                sz = (w * (0.9 + rnd.random() * 0.06), 0.12 + rnd.random() * 0.04, rh * (0.86 + rnd.random() * 0.08))
                z = rh * (r + 0.5)
                ang = side * math.pi / 2
                pos = Vector((x, 0.47 + rnd.random() * 0.02, z))
                pos.rotate(__import__('mathutils').Euler((0, 0, ang)))
                b = cube(sz, pos, (rnd.uniform(-0.03, 0.03), rnd.uniform(-0.03, 0.03), ang + rnd.uniform(-0.04, 0.04)))
                mod(b, 'BEVEL', width=0.025, segments=1)
                apply_all(b)
                paint(b, stone_rgb(rnd, palette), var=0.06, height=height, seed=seed + r * 10 + i)
                parts.append(b)
    # uneven capstones
    for i in range(3):
        for j in range(3):
            c = cube((0.31, 0.31, 0.08 + rnd.random() * 0.05), (-0.33 + i * 0.33, -0.33 + j * 0.33, height + 0.03), (0, 0, rnd.uniform(-0.1, 0.1)))
            mod(c, 'BEVEL', width=0.03, segments=1)
            apply_all(c)
            paint(c, tuple(min(1, v * 1.35) for v in stone_rgb(rnd, palette)), var=0.05, height=height, seed=seed + 99 + i * 3 + j, dark_bottom=0.1)
            parts.append(c)
    obj = join(parts, name)
    export(obj, name)


def boulder(seed, name, palette=(0.36, 0.3, 0.25)):
    reset()
    rnd = random.Random(seed)
    o = ico(0.5, (0, 0, 0.5), sub=3)
    o.scale = (1 + rnd.random() * 0.2, 0.9 + rnd.random() * 0.2, 0.8 + rnd.random() * 0.5)
    bpy.ops.object.transform_apply(scale=True)
    displace(o, 0.32, size=0.45)
    displace(o, 0.08, size=0.12)
    mod(o, 'DECIMATE', ratio=0.35)
    apply_all(o)
    # flatten the bottom
    for v in o.data.vertices:
        if v.co.z < 0.05:
            v.co.z = 0.05 if v.co.z > -0.2 else v.co.z * 0.2
    paint(o, palette, var=0.14, height=1.2, seed=seed, crevice=0.4)
    export(o, name)


def tree(seed, name):
    """Gnarled trunk with root flares and lumpy painted canopy clumps."""
    reset()
    rnd = random.Random(seed)
    parts = []
    trunk = cyl(0.13, 1.1, (0, 0, 0.55), verts=10, r2=0.07)
    mod(trunk, 'SUBSURF', levels=1)
    mod(trunk, 'SIMPLE_DEFORM', deform_method='TWIST', angle=rnd.uniform(0.6, 1.2))
    m = mod(trunk, 'SIMPLE_DEFORM', deform_method='BEND', angle=rnd.uniform(-0.4, 0.4))
    displace(trunk, 0.05, size=0.15)
    apply_all(trunk)
    paint(trunk, (0.3, 0.19, 0.11), var=0.1, height=1.2, seed=seed)
    parts.append(trunk)
    for i in range(4):
        a = i * math.pi / 2 + rnd.uniform(-0.3, 0.3)
        root = cyl(0.06, 0.4, (math.cos(a) * 0.14, math.sin(a) * 0.14, 0.06), (0, math.pi / 2 - 0.35, a), verts=6, r2=0.02)
        paint(root, (0.27, 0.17, 0.1), height=1.2, seed=seed + i)
        parts.append(root)
    for i in range(5):
        a = rnd.random() * math.pi * 2
        r = 0.0 if i == 0 else 0.22 + rnd.random() * 0.12
        c = ico(0.32 + rnd.random() * 0.12, (math.cos(a) * r, math.sin(a) * r, 1.15 + rnd.random() * 0.3 - (0.1 if i else -0.15)), sub=2)
        c.scale = (1, 1, 0.8)
        bpy.ops.object.transform_apply(scale=True)
        displace(c, 0.16, size=0.25)
        mod(c, 'DECIMATE', ratio=0.6)
        apply_all(c)
        g = (0.17 + rnd.random() * 0.08, 0.36 + rnd.random() * 0.12, 0.13 + rnd.random() * 0.05)
        paint(c, g, var=0.16, height=1.8, seed=seed + 50 + i, dark_bottom=0.55)
        parts.append(c)
    obj = join(parts, name)
    export(obj, name)


def dead_tree(seed, name):
    """Bare, twisted swamp tree with hanging moss."""
    reset()
    rnd = random.Random(seed)
    parts = []
    trunk = cyl(0.12, 1.2, (0, 0, 0.6), verts=8, r2=0.05)
    mod(trunk, 'SUBSURF', levels=1)
    mod(trunk, 'SIMPLE_DEFORM', deform_method='TWIST', angle=1.6)
    mod(trunk, 'SIMPLE_DEFORM', deform_method='BEND', angle=rnd.uniform(0.3, 0.7))
    displace(trunk, 0.04, size=0.12)
    apply_all(trunk)
    paint(trunk, (0.22, 0.2, 0.16), var=0.1, height=1.4, seed=seed)
    parts.append(trunk)
    for i in range(5):
        a = rnd.random() * math.pi * 2
        z = 0.6 + i * 0.13
        br = cyl(0.035, 0.5, (math.cos(a) * 0.18, math.sin(a) * 0.18, z), (0, math.pi / 2 - 0.5, a), verts=6, r2=0.008)
        paint(br, (0.2, 0.18, 0.14), height=1.4, seed=seed + i)
        parts.append(br)
        moss = cube((0.03, 0.06, 0.25 + rnd.random() * 0.2), (math.cos(a) * 0.36, math.sin(a) * 0.36, z - 0.1))
        paint(moss, (0.23, 0.3, 0.12), height=1.4, seed=seed + 30 + i)
        parts.append(moss)
    obj = join(parts, name)
    export(obj, name)


def crate(seed, name):
    reset()
    rnd = random.Random(seed)
    parts = []
    box = cube((0.5, 0.5, 0.5), (0, 0, 0.25))
    mod(box, 'BEVEL', width=0.02, segments=1)
    apply_all(box)
    paint(box, (0.42, 0.29, 0.16), height=0.5, seed=seed)
    parts.append(box)
    for side in range(4):
        a = side * math.pi / 2
        for z in (0.06, 0.44):
            p = Vector((0, 0.255, z))
            p.rotate(__import__('mathutils').Euler((0, 0, a)))
            slat = cube((0.52, 0.03, 0.07), p, (0, 0, a))
            paint(slat, (0.3, 0.2, 0.11), height=0.5, seed=seed + side)
            parts.append(slat)
        p = Vector((0, 0.26, 0.25))
        p.rotate(__import__('mathutils').Euler((0, 0, a)))
        diag = cube((0.6, 0.03, 0.06), p, (0, 0.78 if side % 2 else -0.78, a))
        diag.rotation_euler = (0, 0, a)
        paint(diag, (0.32, 0.21, 0.12), height=0.5, seed=seed + 9 + side)
        parts.append(diag)
    obj = join(parts, name)
    obj.rotation_euler.z = rnd.uniform(-0.2, 0.2)
    export(obj, name)


def barrel(seed, name):
    reset()
    parts = []
    b = cyl(0.21, 0.55, (0, 0, 0.275), verts=14)
    mod(b, 'SUBSURF', levels=1)
    apply_all(b)
    for v in b.data.vertices:
        t = 1 - abs(v.co.z) / 0.275
        f = 1 + 0.18 * max(0.0, t)
        v.co.x *= f
        v.co.y *= f
    paint(b, (0.4, 0.26, 0.14), height=0.6, seed=seed)
    parts.append(b)
    for z in (0.1, 0.45):
        ring = cyl(0.235, 0.04, (0, 0, z), verts=14)
        paint(ring, (0.22, 0.22, 0.24), height=0.6, seed=seed + 1)
        parts.append(ring)
    obj = join(parts, name)
    export(obj, name)


def bones(seed, name):
    reset()
    rnd = random.Random(seed)
    parts = []
    skull = ico(0.09, (0, 0, 0.08), sub=2)
    skull.scale = (1, 1.15, 0.95)
    bpy.ops.object.transform_apply(scale=True)
    paint(skull, (0.78, 0.74, 0.62), height=0.3, seed=seed)
    parts.append(skull)
    for s in (-1, 1):
        eye = ico(0.025, (s * 0.035, 0.09, 0.09), sub=1)
        paint(eye, (0.05, 0.04, 0.04), height=0.3, seed=seed)
        parts.append(eye)
    for i in range(6):
        a = rnd.random() * math.pi * 2
        r = 0.12 + rnd.random() * 0.15
        bone = cyl(0.018, 0.26, (math.cos(a) * r, math.sin(a) * r, 0.03), (math.pi / 2, 0, rnd.random() * math.pi), verts=6)
        paint(bone, (0.72, 0.68, 0.56), height=0.3, seed=seed + i)
        parts.append(bone)
        for e in (-1, 1):
            knob = ico(0.03, (math.cos(a) * r, math.sin(a) * r, 0.03), sub=1)
            knob.location = bone.matrix_world @ Vector((0, 0, e * 0.13))
            paint(knob, (0.75, 0.7, 0.58), height=0.3, seed=seed + i)
            parts.append(knob)
    obj = join(parts, name)
    export(obj, name)


def gravestone(seed, name):
    reset()
    rnd = random.Random(seed)
    parts = []
    slab = cube((0.42, 0.12, 0.62), (0, 0, 0.31), (rnd.uniform(-0.1, 0.1), 0, rnd.uniform(-0.15, 0.15)))
    top = cyl(0.21, 0.12, (0, 0, 0.62), (math.pi / 2, 0, 0), verts=12)
    top.rotation_euler = slab.rotation_euler.copy()
    top.rotation_euler.x += math.pi / 2
    top.location = slab.matrix_world @ Vector((0, 0, 0.31))
    for o in (slab, top):
        displace(o, 0.02, size=0.1)
        apply_all(o)
        paint(o, (0.42, 0.42, 0.45), var=0.08, height=0.8, seed=seed)
        parts.append(o)
    mound = ico(0.3, (0, 0.25, 0), sub=2)
    mound.scale = (1, 1.4, 0.3)
    bpy.ops.object.transform_apply(scale=True)
    paint(mound, (0.25, 0.2, 0.15), height=0.8, seed=seed + 5)
    parts.append(mound)
    obj = join(parts, name)
    export(obj, name)


def mushrooms(seed, name):
    reset()
    rnd = random.Random(seed)
    parts = []
    for i in range(5):
        a = rnd.random() * math.pi * 2
        r = rnd.random() * 0.18
        h = 0.12 + rnd.random() * 0.2
        x, y = math.cos(a) * r, math.sin(a) * r
        stem = cyl(0.025, h, (x, y, h / 2), verts=8, r2=0.02)
        paint(stem, (0.8, 0.76, 0.66), height=0.4, seed=seed + i)
        cap = ico(0.06 + h * 0.25, (x, y, h), sub=2)
        cap.scale = (1, 1, 0.5)
        bpy.ops.object.transform_apply(scale=True)
        glow = (0.2, 0.75, 0.65) if i % 2 else (0.72, 0.25, 0.55)
        paint(cap, glow, height=0.4, seed=seed + 10 + i, dark_bottom=0.6)
        parts += [stem, cap]
    obj = join(parts, name)
    export(obj, name)


def pillar(seed, name):
    reset()
    rnd = random.Random(seed)
    parts = []
    base = cube((0.5, 0.5, 0.14), (0, 0, 0.07))
    shaft_h = 0.9 + rnd.random() * 0.5
    shaft = cyl(0.16, shaft_h, (0, 0, 0.14 + shaft_h / 2), verts=10)
    displace(shaft, 0.03, size=0.1)
    for o in (base, shaft):
        mod(o, 'BEVEL', width=0.02, segments=1)
        apply_all(o)
        paint(o, (0.45, 0.42, 0.46), var=0.07, height=1.6, seed=seed)
        parts.append(o)
    # broken top
    chunk = ico(0.17, (0.02, 0.0, 0.14 + shaft_h), sub=1)
    chunk.scale = (1, 1, 0.5)
    bpy.ops.object.transform_apply(scale=True)
    paint(chunk, (0.47, 0.44, 0.48), height=1.6, seed=seed + 3)
    parts.append(chunk)
    rubble = ico(0.08, (0.3, 0.1, 0.05), sub=1)
    paint(rubble, (0.4, 0.38, 0.42), height=1.6, seed=seed + 4)
    parts.append(rubble)
    obj = join(parts, name)
    export(obj, name)


def door(seed, name):
    reset()
    parts = []
    for i in range(4):
        plank = cube((0.23, 0.1, 1.1 - (0.02 if i % 2 else 0)), (-0.345 + i * 0.23, 0, 0.55))
        mod(plank, 'BEVEL', width=0.012, segments=1)
        apply_all(plank)
        paint(plank, (0.38 + i * 0.01, 0.24, 0.13), var=0.08, height=1.1, seed=seed + i)
        parts.append(plank)
    for z in (0.22, 0.88):
        band = cube((0.96, 0.12, 0.06), (0, 0, z))
        paint(band, (0.2, 0.2, 0.22), height=1.1, seed=seed + 7)
        parts.append(band)
    ring = cyl(0.05, 0.03, (0.3, 0.08, 0.55), (math.pi / 2, 0, 0), verts=10)
    paint(ring, (0.75, 0.55, 0.2), height=1.1, seed=seed + 8, dark_bottom=0)
    parts.append(ring)
    obj = join(parts, name)
    export(obj, name)


def crystals(seed, name):
    reset()
    rnd = random.Random(seed)
    parts = []
    for i in range(6):
        a = rnd.random() * math.pi * 2
        r = rnd.random() * 0.15
        h = 0.25 + rnd.random() * 0.45
        c = cyl(0.06 + rnd.random() * 0.03, h, (math.cos(a) * r, math.sin(a) * r, h / 2), (rnd.uniform(-0.35, 0.35), rnd.uniform(-0.35, 0.35), 0), verts=6, r2=0.0)
        col = (0.2, 0.85, 0.8) if i % 3 else (0.8, 0.3, 0.7)
        paint(c, col, height=0.8, seed=seed + i, dark_bottom=0.5)
        parts.append(c)
    obj = join(parts, name)
    export(obj, name)


if __name__ == '__main__':
    random.seed(1)
    wall(1, 'wall-a')
    wall(2, 'wall-b')
    wall(3, 'wall-crypt', palette=(0.3, 0.3, 0.38))
    boulder(4, 'rock-a')
    boulder(5, 'rock-b', palette=(0.32, 0.28, 0.24))
    boulder(6, 'rock-c', palette=(0.3, 0.27, 0.25))
    tree(7, 'tree-a')
    tree(8, 'tree-b')
    tree(9, 'tree-c')
    dead_tree(10, 'deadtree-a')
    dead_tree(11, 'deadtree-b')
    crate(12, 'crate')
    barrel(13, 'barrel')
    bones(14, 'bones')
    gravestone(15, 'gravestone')
    mushrooms(16, 'mushrooms')
    pillar(17, 'pillar')
    door(18, 'door')
    crystals(19, 'crystals')
