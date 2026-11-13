"""Prepares the CC0 KayKit character packs (Kay Lousberg, kaylousberg.com)
for the game: keeps one weapon set per figure, attaches skeleton weapons to
the hand bones, keeps a handful of animations renamed to
idle / walk / attack / hit / death / cast, and exports a compact GLB.

    git clone --depth 1 https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
    git clone --depth 1 https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0
    python scripts/blender/prepare_kaykit.py <folder with both clones>   # writes public/models/kaykit-*.glb
"""

import os
import sys

import bpy

SRC = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models')
ADV = os.path.join(SRC, 'KayKit-Character-Pack-Adventures-1.0', 'addons', 'kaykit_character_pack_adventures')
SKL = os.path.join(SRC, 'KayKit-Character-Pack-Skeletons-1.0', 'addons', 'kaykit_character_pack_skeletons')

# out name, source file, meshes to keep (None = all), extra weapons {gltf: bone}, animations {new name: source}
FIGURES = [
    ('kaykit-knight', f'{ADV}/Characters/gltf/Knight.glb',
     {'Knight_Helmet', 'Knight_Cape', 'Knight_ArmLeft', 'Knight_ArmRight', 'Knight_Body', 'Knight_Head', 'Knight_LegLeft', 'Knight_LegRight', '1H_Sword', 'Round_Shield'},
     {}, {'idle': 'Idle', 'walk': 'Walking_A', 'attack': '1H_Melee_Attack_Chop', 'hit': 'Hit_A', 'death': 'Death_A', 'block': 'Block'}),
    ('kaykit-barbarian', f'{ADV}/Characters/gltf/Barbarian.glb',
     {'Barbarian_Hat', 'Barbarian_Cape', 'Barbarian_ArmLeft', 'Barbarian_ArmRight', 'Barbarian_Body', 'Barbarian_Head', 'Barbarian_LegLeft', 'Barbarian_LegRight', '2H_Axe'},
     {}, {'idle': '2H_Melee_Idle', 'walk': 'Walking_A', 'attack': '2H_Melee_Attack_Chop', 'hit': 'Hit_A', 'death': 'Death_A'}),
    ('kaykit-mage', f'{ADV}/Characters/gltf/Mage.glb',
     {'Mage_Hat', 'Mage_Cape', 'Mage_ArmLeft', 'Mage_ArmRight', 'Mage_Body', 'Mage_Head', 'Mage_LegLeft', 'Mage_LegRight', '2H_Staff'},
     {}, {'idle': 'Idle', 'walk': 'Walking_A', 'attack': 'Spellcast_Shoot', 'hit': 'Hit_A', 'death': 'Death_A', 'cast': 'Spellcast_Raise'}),
    ('kaykit-warlock', f'{ADV}/Characters/gltf/Mage.glb',
     {'Mage_Hat', 'Mage_Cape', 'Mage_ArmLeft', 'Mage_ArmRight', 'Mage_Body', 'Mage_Head', 'Mage_LegLeft', 'Mage_LegRight', '1H_Wand', 'Spellbook_open'},
     {}, {'idle': 'Idle', 'walk': 'Walking_A', 'attack': 'Spellcast_Shoot', 'hit': 'Hit_A', 'death': 'Death_A', 'cast': 'Spellcast_Long'}),
    ('kaykit-rogue', f'{ADV}/Characters/gltf/Rogue_Hooded.glb',
     {'Rogue_Cape', 'Rogue_ArmLeft', 'Rogue_ArmRight', 'Rogue_Body', 'Rogue_Head_Hooded', 'Rogue_LegLeft', 'Rogue_LegRight', 'Knife', 'Knife_Offhand'},
     {}, {'idle': 'Idle', 'walk': 'Walking_A', 'attack': 'Dualwield_Melee_Attack_Stab', 'hit': 'Hit_A', 'death': 'Death_A'}),
    ('kaykit-ranger', f'{ADV}/Characters/gltf/Rogue.glb',
     {'Rogue_Cape', 'Rogue_ArmLeft', 'Rogue_ArmRight', 'Rogue_Body', 'Rogue_Head', 'Rogue_LegLeft', 'Rogue_LegRight', '2H_Crossbow'},
     {}, {'idle': '2H_Melee_Idle', 'walk': 'Walking_A', 'attack': '2H_Ranged_Shoot', 'hit': 'Hit_A', 'death': 'Death_A'}),
    ('kaykit-skeleton-warrior', f'{SKL}/Characters/gltf/Skeleton_Warrior.glb', None,
     {f'{SKL}/Assets/gltf/Skeleton_Blade.gltf': 'handslot.r', f'{SKL}/Assets/gltf/Skeleton_Shield_Small_A.gltf': 'handslot.l'},
     {'idle': 'Idle_Combat', 'walk': 'Walking_D_Skeletons', 'attack': '1H_Melee_Attack_Chop', 'hit': 'Hit_A', 'death': 'Death_C_Skeletons'}),
    ('kaykit-skeleton-minion', f'{SKL}/Characters/gltf/Skeleton_Minion.glb', None,
     {f'{SKL}/Assets/gltf/Skeleton_Axe.gltf': 'handslot.r'},
     {'idle': 'Idle_B', 'walk': 'Walking_D_Skeletons', 'attack': '1H_Melee_Attack_Chop', 'hit': 'Hit_A', 'death': 'Death_C_Skeletons'}),
    ('kaykit-skeleton-mage', f'{SKL}/Characters/gltf/Skeleton_Mage.glb', None,
     {f'{SKL}/Assets/gltf/Skeleton_Staff.gltf': 'handslot.r'},
     {'idle': 'Idle', 'walk': 'Walking_D_Skeletons', 'attack': 'Spellcast_Shoot', 'hit': 'Hit_A', 'death': 'Death_C_Skeletons', 'cast': 'Spellcast_Summon'}),
    ('kaykit-skeleton-rogue', f'{SKL}/Characters/gltf/Skeleton_Rogue.glb', None,
     {f'{SKL}/Assets/gltf/Skeleton_Crossbow.gltf': 'handslot.r'},
     {'idle': 'Idle', 'walk': 'Walking_D_Skeletons', 'attack': '1H_Ranged_Shoot', 'hit': 'Hit_A', 'death': 'Death_C_Skeletons'}),
]


def build(name, src, keep, weapons, anims):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    armature = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')

    if keep is not None:
        for o in list(bpy.context.scene.objects):
            if o.type == 'MESH' and o.name not in keep:
                bpy.data.objects.remove(o, do_unlink=True)

    for path, bone in weapons.items():
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        for o in set(bpy.context.scene.objects) - before:
            if o.type != 'MESH':
                continue
            world = o.matrix_world.copy()
            o.parent = armature
            o.parent_type = 'BONE'
            o.parent_bone = bone
            o.matrix_parent_inverse.identity()
            # the bone parent places the weapon at the bone's tail; move it to the head
            o.location = (0, -armature.data.bones[bone].length, 0)
            o.rotation_euler = (0, 0, 0)
            del world

    wanted = {src_name: new for new, src_name in anims.items()}
    for action in list(bpy.data.actions):
        if action.name in wanted:
            action.name = wanted[action.name]
            action.use_fake_user = True
        else:
            bpy.data.actions.remove(action)
    missing = set(anims) - {a.name for a in bpy.data.actions}
    if missing:
        print(f'{name}: missing animations {sorted(missing)}')

    if armature.animation_data is None:
        armature.animation_data_create()
    armature.animation_data.action = bpy.data.actions.get('idle')

    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, f'{name}.glb')
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True,
                              export_animations=True, export_animation_mode='ACTIONS',
                              export_image_format='AUTO')
    print(f'{name}: {os.path.getsize(out) // 1024} KB, animations {sorted(a.name for a in bpy.data.actions)}')


if __name__ == '__main__':
    for fig in FIGURES:
        build(*fig)
