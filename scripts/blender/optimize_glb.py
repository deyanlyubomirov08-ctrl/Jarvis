"""Shrinks a generated GLB for the game: decimates the mesh, scales the
texture down and re-exports it.

    python scripts/blender/optimize_glb.py <in.glb> <out.glb> [max_tris] [texture_px]
"""

import os
import sys

import bpy

src, dst = sys.argv[1], sys.argv[2]
max_tris = int(sys.argv[3]) if len(sys.argv) > 3 else 20000
tex_px = int(sys.argv[4]) if len(sys.argv) > 4 else 1024

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
before = 0
for o in meshes:
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    before += tris
    if tris > max_tris:
        m = o.modifiers.new('decimate', 'DECIMATE')
        m.ratio = max_tris / tris
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=m.name)
after = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)

for img in bpy.data.images:
    if img.size[0] > tex_px:
        img.scale(tex_px, tex_px * img.size[1] // max(1, img.size[0]))

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', use_selection=True, export_apply=True,
                          export_image_format='JPEG', export_jpeg_quality=85)
print(f'{os.path.basename(dst)}: {before} → {after} tris, {os.path.getsize(dst) // 1024} KB')
