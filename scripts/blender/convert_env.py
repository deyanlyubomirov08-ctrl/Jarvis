"""Converts CC0 environment models by Quaternius (quaternius.com) into the
3D table's environment kit (public/models/env/<name>.glb): one mesh per
prop, material colours baked into vertex colours, origin at the centre of
the base, scaled to map cells. Pieces it does not replace (walls, door,
gravestone, mushrooms) keep coming from build_props.py.

Source: https://github.com/trebeljahr/quaternius-showcase  (public/glb/...)

    python scripts/blender/convert_env.py <folder with the quaternius-showcase clone>
"""

import os
import sys

import bpy

SRC = os.path.join(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.'), 'quaternius-showcase', 'public', 'glb')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models', 'env')

# kit name: (source, fit, size) — fit 'h' scales to a height, 'w' to the widest side
PIECES = {
    'tree-a': ('nature_pack/CommonTree_1.glb', 'h', 1.5),
    'tree-b': ('nature_pack/CommonTree_2.glb', 'h', 1.45),
    'tree-c': ('nature_pack/PineTree_1.glb', 'h', 1.7),
    'deadtree-a': ('nature_pack/CommonTree_Dead_1.glb', 'h', 1.4),
    'deadtree-b': ('nature_pack/BirchTree_Dead_1.glb', 'h', 1.4),
    'rock-a': ('nature_pack/Rock_Moss_1.glb', 'w', 1.0),
    'rock-b': ('nature_pack/Rock_2.glb', 'w', 1.0),
    'rock-c': ('nature_pack/Rock_Moss_3.glb', 'w', 1.0),
    'crate': ('modular_dungeon_1/Crate.glb', 'w', 0.55),
    'barrel': ('modular_dungeon_pack/Barrel.glb', 'h', 0.6),
    'bones': ('modular_dungeon_pack/Bones.glb', 'w', 0.55),
    'pillar': ('modular_dungeon_pack/Column_Broken.glb', 'w', 0.7),
    'crystals': ('rpg_items_pack/Crystal2.glb', 'h', 0.6),
}


def base_color(mat):
    if mat is None:
        return (0.6, 0.6, 0.6, 1)
    if mat.use_nodes:
        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is not None:
            c = bsdf.inputs['Base Color'].default_value
            return (c[0], c[1], c[2], 1)
    c = mat.diffuse_color
    return (c[0], c[1], c[2], 1)


def convert(name, rel, fit, size):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.join(SRC, rel))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    # bake each face's material colour into a colour attribute
    for o in meshes:
        me = o.data
        col = me.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
        for poly in me.polygons:
            mat = me.materials[poly.material_index] if me.materials else None
            rgba = base_color(mat)
            for li in poly.loop_indices:
                col.data[li].color = rgba
        me.color_attributes.active_color = col
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    for o in list(bpy.context.scene.objects):
        if o != obj:
            bpy.data.objects.remove(o, do_unlink=True)
    obj.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # base centre to origin, then scale to cells
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    cx, cy, z0 = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)
    extent = (max(zs) - z0) if fit == 'h' else max(max(xs) - min(xs), max(ys) - min(ys))
    k = size / max(extent, 1e-6)
    for v in obj.data.vertices:
        v.co.x = (v.co.x - cx) * k
        v.co.y = (v.co.y - cy) * k
        v.co.z = (v.co.z - z0) * k
    obj.data.materials.clear()
    mat = bpy.data.materials.new('painted')
    mat.use_nodes = True
    vc = mat.node_tree.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    mat.node_tree.links.new(vc.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    obj.data.materials.append(mat)
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f'{name}.glb')
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True,
                              export_vertex_color='ACTIVE', export_animations=False)
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f'{name}: {tris} tris, {os.path.getsize(out) // 1024} KB (from {rel})')


if __name__ == '__main__':
    for name, (rel, fit, size) in PIECES.items():
        try:
            convert(name, rel, fit, size)
        except Exception as err:
            print(f'{name}: FAILED {err}')
