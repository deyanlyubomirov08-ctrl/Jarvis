"""Generates the game's 3D figures with free Hugging Face Spaces:
FLUX.1-schnell draws an original concept image, TRELLIS.2 turns it into a
textured GLB, and Blender reduces it for the browser. Results go to
public/models/ and are registered in public/models/manifest.json.

    pip install gradio_client          # plus `pip install bpy` for Blender
    HF_TOKEN=hf_... python scripts/generate_models.py [id ...]

Already generated models are skipped, so the script can be re-run after the
free daily GPU quota resets. It stops cleanly when the quota runs out.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

from gradio_client import Client, handle_file

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
MODELS = os.path.join(ROOT, 'public', 'models')
MANIFEST = os.path.join(MODELS, 'manifest.json')
OPTIMIZE = os.path.join(ROOT, 'scripts', 'blender', 'optimize_glb.py')
BLENDER_PY = os.environ.get('BLENDER_PY', sys.executable)
TOKEN = os.environ.get('HF_TOKEN') or 'hf_proxyinjectedplaceholder0000000000'

STYLE = ('dark fantasy style, highly detailed sculpted resin miniature on a round base, '
         'single figure centered, full body, plain light gray background, soft studio light')
BEAST = 'standing on all fours, three-quarter side view, ' + STYLE
FIGURE = 'standing pose, three-quarter view, ' + STYLE

# id, manifest rules, subject, height (cells), pose
ROSTER = [
    # monsters from the ready-made adventures first
    ('kobold', ['monster:kobold'], 'a small scaly kobold scavenger with a crude spear and ragged loincloth', 0.75, FIGURE),
    ('wolf', ['monster:wolf|worg|jackal'], 'a lean feral wolf with matted fur, snarling', 0.7, BEAST),
    ('bugbear', ['monster:bugbear|hobgoblin'], 'a towering hairy bugbear brute with a spiked morningstar and hide armor', 1.35, FIGURE),
    ('giant-rat', ['monster:rat'], 'a giant mangy rat with a long tail', 0.45, BEAST),
    ('skeleton', ['monster:skeleton'], 'an undead skeleton warrior with a rusted sword, cracked shield and tattered rags', 1.1, FIGURE),
    ('zombie', ['monster:zombie|ghoul|ghast'], 'a shambling rotting zombie in torn burial clothes, reaching forward', 1.05, FIGURE),
    ('wight', ['monster:wight|mummy|specter'], 'a gaunt undead knight with an iron crown, glowing eyes and a tattered cloak', 1.2, FIGURE),
    ('giant-spider', ['monster:spider|insect'], 'a giant hairy spider with eight long legs and many eyes', 0.6, BEAST),
    ('ettercap', ['monster:ettercap'], 'a hunched spider-like humanoid with mandibles and long clawed fingers', 1.0, FIGURE),
    ('gelatinous-cube', ['monster:cube|ooze|jelly|pudding'], 'a translucent green gelatinous cube of slime with bones floating inside', 0.9, STYLE),
    ('giant-frog', ['monster:frog|toad'], 'a giant warty swamp frog', 0.55, BEAST),
    ('crocodile', ['monster:crocodile'], 'a large swamp crocodile with armored scales', 0.5, BEAST),
    ('lizardfolk', ['monster:lizardfolk'], 'a lizardfolk warrior with a bone spear and a hide shield', 1.15, FIGURE),
    ('swamp-hag', ['monster:hag'], 'a hunched swamp witch with long claws, a ragged shawl and warty green skin', 1.1, FIGURE),
    ('magma-imp', ['monster:mephit|imp|quasit'], 'a small imp made of cracked molten rock with glowing seams', 0.7, FIGURE),
    ('hell-hound', ['monster:hound'], 'a hound with smoldering black fur and glowing ember eyes', 0.8, BEAST),
    ('red-wyrmling', ['monster:dragon|wyrmling|drake'], 'a young red dragon with spread wings and ember-colored scales', 0.95, BEAST),
    # common random-encounter foes
    ('orc', ['monster:orc'], 'a hulking orc brute with tusks, a crude cleaver and patched leather armor', 1.25, FIGURE),
    ('bandit', ['monster:bandit|thug|scout|spy'], 'a masked bandit with a crossbow and a hooded travel cloak', 1.05, FIGURE),
    ('cultist', ['monster:cultist|fanatic|acolyte|priest|mage'], 'a robed cultist with a ritual dagger and a deep hood', 1.05, FIGURE),
    ('owlbear', ['monster:owlbear|bear'], 'a shaggy beast with the feathered head of an owl and the body of a bear', 1.1, BEAST),
    ('gnoll', ['monster:gnoll'], 'a hyena-headed gnoll raider with a crude flail and bone trophies', 1.2, FIGURE),
    # heroes by class
    ('hero-fighter', ['class:fighter'], 'an armored fighter with a longsword and a kite shield, chainmail and a torn surcoat', 1.15, FIGURE),
    ('hero-wizard', ['class:wizard'], 'an old wizard with a tall pointed hat, a staff topped with a glowing crystal and a long beard', 1.15, FIGURE),
    ('hero-cleric', ['class:cleric'], 'a battle cleric with a mace, a holy symbol and scale armor under a tabard', 1.15, FIGURE),
    ('hero-rogue', ['class:rogue'], 'a hooded rogue with twin daggers and dark leather armor', 1.1, FIGURE),
    ('hero-ranger', ['class:ranger'], 'a hooded ranger with a longbow, a quiver and a long travel cloak', 1.15, FIGURE),
    ('hero-barbarian', ['class:barbarian'], 'a wild barbarian warrior with a greataxe, a fur mantle and tribal tattoos', 1.2, FIGURE),
    ('hero-paladin', ['class:paladin'], 'a paladin in ornate plate armor with a warhammer and a round shield', 1.2, FIGURE),
    ('hero-bard', ['class:bard'], 'a wandering bard with a fiddle, a wide-brimmed hat and a patched long coat', 1.1, FIGURE),
    ('hero-druid', ['class:druid'], 'a druid with a gnarled wooden staff, a cloak of leaves and fur and an antler crown', 1.15, FIGURE),
    ('hero-monk', ['class:monk'], 'a barefoot monk in wrapped robes in a martial arts stance', 1.05, FIGURE),
    ('hero-sorcerer', ['class:sorcerer'], 'a sorcerer with glowing hands, flowing robes and arcane sigils', 1.1, FIGURE),
    ('hero-warlock', ['class:warlock'], 'a warlock in a dark long coat and wide hat with a floating eldritch tome', 1.15, FIGURE),
]


class QuotaExceeded(Exception):
    pass


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as err:  # gradio_client raises AppError with the Space's message
        if 'quota' in str(err).lower():
            raise QuotaExceeded(str(err)) from err
        raise


def concept(flux, subject, pose, out):
    prompt = f'full body 3D sculpted miniature of {subject}, {pose}'
    res, _ = call(flux.predict, prompt=prompt, seed=7, randomize_seed=False, width=1024, height=1024,
                  num_inference_steps=4, api_name='/infer')
    shutil.copy(res['path'] if isinstance(res, dict) else res, out)


def to_3d(trellis, image, out):
    try:
        trellis.predict(api_name='/start_session')
    except Exception:
        pass
    img = call(trellis.predict, input=handle_file(image), api_name='/preprocess_image')
    call(trellis.predict, image=handle_file(img['path'] if isinstance(img, dict) else img), seed=1,
         resolution='512', api_name='/image_to_3d')
    glb, dl = call(trellis.predict, decimation_target=100000, texture_size=1024, api_name='/extract_glb')
    shutil.copy(dl if isinstance(dl, str) else (glb if isinstance(glb, str) else glb.get('path')), out)


def register(model_id, rules, height):
    with open(MANIFEST, encoding='utf-8') as f:
        manifest = json.load(f)
    manifest['models'] = [m for m in manifest['models'] if m['id'] != model_id]
    # hand-made models listed first keep priority over generated ones
    manifest['models'].append({'id': model_id, 'title': f'{model_id} (FLUX + TRELLIS.2)', 'file': f'{model_id}.glb',
                               'use': rules, 'height': height, 'generated': True})
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main():
    wanted = set(sys.argv[1:])
    flux = Client('https://black-forest-labs-flux-1-schnell.hf.space/', hf_token=TOKEN, verbose=False)
    trellis = Client('https://microsoft-trellis-2.hf.space/', hf_token=TOKEN, verbose=False)
    work = tempfile.mkdtemp(prefix='models-')
    done = 0
    for model_id, rules, subject, height, pose in ROSTER:
        if wanted and model_id not in wanted:
            continue
        target = os.path.join(MODELS, f'{model_id}.glb')
        if os.path.exists(target):
            continue
        t = time.time()
        img = os.path.join(work, f'{model_id}.png')
        raw = os.path.join(work, f'{model_id}-raw.glb')
        try:
            concept(flux, subject, pose, img)
            to_3d(trellis, img, raw)
        except QuotaExceeded as err:
            print(f'STOP: free GPU quota used up ({err}). Run again later to continue.', flush=True)
            break
        except Exception as err:
            print(f'{model_id}: failed ({str(err)[:160]})', flush=True)
            continue
        subprocess.run([BLENDER_PY, OPTIMIZE, raw, target, '20000', '1024'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copy(img, os.path.join(work, f'{model_id}-concept.png'))
        register(model_id, rules, height)
        done += 1
        print(f'{model_id}: ok in {time.time() - t:.0f}s ({os.path.getsize(target) // 1024} KB)', flush=True)
    print(f'generated {done} model(s); concept images in {work}', flush=True)


if __name__ == '__main__':
    main()
