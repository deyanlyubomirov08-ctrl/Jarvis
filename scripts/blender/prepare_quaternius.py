"""Prepares CC0 creature models by Quaternius (quaternius.com) for the game:
keeps five animations renamed to idle / walk / attack / hit / death and
exports a compact GLB to public/models/q-<name>.glb.

Sources (all CC0, by Quaternius):
  - Ultimate Animated Animal Pack, Easy Enemy Pack, Animated Dinosaur Pack:
      https://github.com/trebeljahr/quaternius-showcase  (public/glb/...)
  - Animated Monster Pack, Animated Zombie:
      https://github.com/beep2bleep/FreeAssetsByKenneyNLandQuaternius
  - Ultimate Monsters (Orc, Demon, Blue Demon, Creep Creature):
      https://github.com/511action/descent-3d-assets  (models/)

    python scripts/blender/prepare_quaternius.py <folder with the three clones>
"""

import os
import re
import sys

import bpy

SRC = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models')
SHOW = os.path.join(SRC, 'quaternius-showcase', 'public', 'glb')
PACKS = os.path.join(SRC, 'FreeAssetsByKenneyNLandQuaternius', 'FreeModels by Quaternius[Patreon]', 'Characters and Animals')
DESC = os.path.join(SRC, 'descent-3d-assets', 'models')

FIGURES = {
    'q-orc': f'{DESC}/Orc.gltf',
    'q-demon': f'{DESC}/Demon.gltf',
    'q-imp': f'{DESC}/BlueDemon.gltf',
    'q-creep': f'{DESC}/CreepCreature.glb',
    'q-dragon': f'{PACKS}/Monster Pack Animated - Aug 2018/FBX/Dragon.fbx',
    'q-slime': f'{PACKS}/Monster Pack Animated - Aug 2018/FBX/Slime.fbx',
    'q-bat': f'{PACKS}/Monster Pack Animated - Aug 2018/FBX/Bat.fbx',
    'q-zombie': f'{PACKS}/Zombie Animated - Jan 2018/FBX/Zombie.fbx',
    'q-wolf': f'{SHOW}/animals_pack/Wolf.glb',
    'q-husky': f'{SHOW}/animals_pack/Husky.glb',
    'q-fox': f'{SHOW}/animals_pack/Fox.glb',
    'q-stag': f'{SHOW}/animals_pack/Stag.glb',
    'q-horse': f'{SHOW}/animals_pack/Horse.glb',
    'q-bull': f'{SHOW}/animals_pack/Bull.glb',
    'q-spider': f'{SHOW}/easy_enemies_pack/Spider.glb',
    'q-rat': f'{SHOW}/easy_enemies_pack/Rat.glb',
    'q-frog': f'{SHOW}/easy_enemies_pack/Frog.glb',
    'q-snake': f'{SHOW}/easy_enemies_pack/Snake_angry.glb',
    'q-wasp': f'{SHOW}/easy_enemies_pack/Wasp.glb',
    'q-raptor': f'{SHOW}/dinosaurs_pack/Velociraptor.glb',
    'q-trex': f'{SHOW}/dinosaurs_pack/Trex.glb',
    'q-triceratops': f'{SHOW}/dinosaurs_pack/Triceratops.glb',
    'q-stegosaurus': f'{SHOW}/dinosaurs_pack/Stegosaurus.glb',
}

# first matching pattern wins; names are compared in lower case
PATTERNS = {
    'idle': [r'(^|[|_])idle1?(_action)?$', r'(^|[|_])idle', r'flying', r'crawl'],
    'walk': [r'walk1?(_action)?$', r'walk', r'gallop$', r'run$', r'flying'],
    'attack': [r'attack$', r'attack', r'bite', r'weapon$', r'punch'],
    'hit': [r'hit$', r'hitreact', r'damage', r'hit'],
    'death': [r'death'],
}


def load(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise ValueError(path)


def pick(actions, key, used):
    names = {a.name.lower(): a for a in actions if a not in used}
    for pat in PATTERNS[key]:
        for low, action in names.items():
            if re.search(pat, low):
                return action
    return None


def build(name, path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    load(path)
    actions = list(bpy.data.actions)
    chosen = {}
    used = set()
    for key in ('death', 'attack', 'hit', 'idle', 'walk'):
        action = pick(actions, key, used if key != 'walk' else set())
        if action is None:
            continue
        if action in used:  # e.g. a flying loop used for both idle and walk
            action = action.copy()
        chosen[key] = action
        used.add(action)
    keep = set(chosen.values())
    for action in actions:
        if action not in keep:
            bpy.data.actions.remove(action)
    for key, action in chosen.items():
        action.name = key
        action.use_fake_user = True
    for arm in [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']:
        if arm.animation_data is None:
            arm.animation_data_create()
        arm.animation_data.action = chosen.get('idle')
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f'{name}.glb')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True,
                              export_animations=True, export_animation_mode='ACTIONS')
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH')
    print(f'{name}: {os.path.getsize(out) // 1024} KB, {tris} tris, animations {sorted(chosen)}')


if __name__ == '__main__':
    only = set(sys.argv[2:])
    for name, path in FIGURES.items():
        if only and name not in only:
            continue
        try:
            build(name, path)
        except Exception as err:
            print(f'{name}: FAILED {err}')
