// 3D table for Таверната: a painterly, hand-painted look built with
// three.js — toon shading with ink outlines, warm key light against cool
// neon rims, fog, bloom and an oil-paint (Kuwahara) filter.
//
// createTable(container, hooks) → { update(view), fx(event), focus(id),
//   setTargeting(on), setQuality(q), resize(), dispose() }

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export function webglSupported() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Moods per terrain theme: fog, sky gradient, key / rim / ambient lights,
// accent lights and floating particles.
// ---------------------------------------------------------------------------

const MOODS = {
  dungeon: {
    fog: 0x1a1424, sky: ['#120c1c', '#2b1a33', '#4a2c3a'], key: 0xffb06a, keyI: 2.6, rim: 0x3fd6ff, rimI: 1.6,
    hemi: [0xb8a0d8, 0x4a2a30, 1.3], accent: [0xff8a3d, 0xffb35a], accentKind: 'brazier', motes: 0xffa65a,
    floor: ['#5d4f45', '#6f5f52', '#4a3d36', '#7d6b5a'], wall: ['#3a3038', '#4c3f45', '#2a2229'], top: '#6d5b58',
  },
  crypt: {
    fog: 0x1a1830, sky: ['#070914', '#151a33', '#2a2448'], key: 0xffd2a0, keyI: 2.4, rim: 0xb36bff, rimI: 2.2,
    hemi: [0x9aa3e0, 0x2a2030, 1.2], accent: [0x7fe7ff, 0xb98bff], accentKind: 'candles', motes: 0x9ad9ff,
    floor: ['#5d5a68', '#6c6878', '#4a4757', '#7a7486'], wall: ['#3a3846', '#484556', '#2c2a36'], top: '#5b5870',
  },
  cave: {
    fog: 0x0e1719, sky: ['#060c0e', '#11242a', '#1e3a3c'], key: 0xffa45c, keyI: 2.0, rim: 0x2ff2d0, rimI: 1.8,
    hemi: [0x7fc8c0, 0x3a2410, 1.2], accent: [0x2ff2d0, 0xff4fb8], accentKind: 'crystals', motes: 0x7dfff0,
    floor: ['#4c3f33', '#5c4b3b', '#3b3029', '#6b5845'], wall: ['#2c231d', '#3a2e25', '#1d1712'], top: '#5a4a3c',
  },
  forest: {
    fog: 0x22302c, sky: ['#2b2a45', '#d0805a', '#ffcf8a'], key: 0xffc77a, keyI: 3.0, rim: 0x6fe0ff, rimI: 1.4,
    hemi: [0xbfe0f0, 0x4a3a20, 1.3], accent: [0xfff07a, 0xb8ff7a], accentKind: 'fireflies', motes: 0xf8ff9a,
    floor: ['#3e6b2f', '#4f7d36', '#2f5426', '#6a8f3c'], trail: ['#7a6342', '#8b7350', '#634f35'],
  },
  swamp: {
    fog: 0x16231b, sky: ['#0b1210', '#1c2f24', '#3b4a2a'], key: 0xc9ff8a, keyI: 1.8, rim: 0xff4fb8, rimI: 1.8,
    hemi: [0x9fd8a8, 0x3a2a10, 1.2], accent: [0x8dff4f, 0xff4fb8], accentKind: 'chem', motes: 0xa6ff6a,
    floor: ['#43532c', '#4f6332', '#34421f', '#5d6d38'], trail: ['#5e5236', '#6d603f', '#4a4029'],
  },
  plain: {
    fog: 0x1c1520, sky: ['#120c16', '#2a1c2a', '#4a3030'], key: 0xffb873, keyI: 2.4, rim: 0x48d8ff, rimI: 1.4,
    hemi: [0xc0a8d8, 0x4a2a28, 1.3], accent: [0xffa04a], accentKind: 'brazier', motes: 0xffb36a,
    floor: ['#5a4a3f', '#665446', '#4c3e35', '#75624f'],
  },
};

const ELEMENT_COLORS = {
  Fire: 0xff7a2a, Cold: 0x7fe7ff, Lightning: 0x9fd8ff, Radiant: 0xffe27a, Force: 0xb070ff, Psychic: 0xff6fd0,
  Necrotic: 0x7dff9a, Poison: 0x9dff4f, Acid: 0xc6ff3d, Thunder: 0x9fb8ff,
  Piercing: 0xd8c08a, Slashing: 0xffffff, Bludgeoning: 0xffffff,
};

// ---------------------------------------------------------------------------
// Painted textures (canvas brush strokes)
// ---------------------------------------------------------------------------

function rngFrom(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function strokes(ctx, x, y, w, h, colors, count, rnd, opts = {}) {
  const { minLen = 6, maxLen = 26, minW = 2, maxW = 7, alpha = [0.08, 0.28], angle = null } = opts;
  for (let i = 0; i < count; i += 1) {
    ctx.save();
    ctx.globalAlpha = alpha[0] + rnd() * (alpha[1] - alpha[0]);
    ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
    ctx.translate(x + rnd() * w, y + rnd() * h);
    ctx.rotate(angle === null ? rnd() * Math.PI : angle + (rnd() - 0.5) * 0.6);
    const len = minLen + rnd() * (maxLen - minLen);
    const wid = minW + rnd() * (maxW - minW);
    ctx.beginPath();
    ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function canvasTexture(canvas, repeat = 1) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

function brickTexture(colors, seed = 3) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  const rnd = rngFrom(seed);
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, 128, 128);
  const rowH = 128 / 6;
  for (let r = 0; r < 6; r += 1) {
    const off = r % 2 ? 21 : 0;
    for (let b = -1; b < 4; b += 1) {
      const x = b * 42 + off;
      ctx.fillStyle = colors[1 + Math.floor(rnd() * (colors.length - 1))];
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x + 2, r * rowH + 2, 38, rowH - 4);
      strokes(ctx, x + 2, r * rowH + 2, 38, rowH - 4, ['#ffffff', '#000000', colors[0]], 6, rnd, { alpha: [0.04, 0.12], minLen: 8, maxLen: 30, angle: 0 });
    }
  }
  ctx.globalAlpha = 1;
  strokes(ctx, 0, 0, 128, 128, ['#000000'], 25, rnd, { alpha: [0.05, 0.15] });
  return canvasTexture(c);
}

function blotTexture(colors, seed = 5, size = 128, count = 260) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const rnd = rngFrom(seed);
  ctx.fillStyle = colors[0];
  ctx.fillRect(0, 0, size, size);
  strokes(ctx, 0, 0, size, size, colors, count, rnd, { minLen: 6, maxLen: 34, minW: 3, maxW: 10, alpha: [0.1, 0.35] });
  return canvasTexture(c);
}

function skyTexture(stops) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  stops.forEach((col, i) => g.addColorStop(i / (stops.length - 1), col));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One painted image for the whole floor so no two cells look alike.
function floorTexture(map, mood) {
  const P = 48;
  const { cols, rows, tiles } = map;
  const c = document.createElement('canvas');
  c.width = cols * P;
  c.height = rows * P;
  const ctx = c.getContext('2d');
  const rnd = rngFrom((map.seed || 7) + cols * 31 + rows);
  const outdoor = map.theme === 'forest' || map.theme === 'swamp';
  ctx.fillStyle = mood.floor[0];
  ctx.fillRect(0, 0, c.width, c.height);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const ch = tiles ? tiles[y][x] : '.';
      const px = x * P;
      const py = y * P;
      if (outdoor) {
        const trail = ch === '.' || ch === '=';
        const cols2 = trail ? mood.trail : mood.floor;
        ctx.fillStyle = cols2[0];
        ctx.fillRect(px, py, P, P);
        strokes(ctx, px - 6, py - 6, P + 12, P + 12, cols2, trail ? 18 : 26, rnd,
          trail ? { minLen: 10, maxLen: 30, alpha: [0.15, 0.4] } : { minLen: 6, maxLen: 18, minW: 1.5, maxW: 4, alpha: [0.2, 0.5], angle: -Math.PI / 2 });
      } else {
        // flagstones with painted wear
        ctx.fillStyle = mood.floor[Math.floor(rnd() * mood.floor.length)];
        ctx.fillRect(px + 1, py + 1, P - 2, P - 2);
        strokes(ctx, px, py, P, P, [...mood.floor, '#000000'], 14, rnd, { minLen: 8, maxLen: 28, alpha: [0.1, 0.3] });
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = '#140d10';
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1, py + 1, P - 2, P - 2);
        if (rnd() < 0.25) {
          ctx.beginPath();
          ctx.moveTo(px + rnd() * P, py + rnd() * P);
          ctx.lineTo(px + rnd() * P, py + rnd() * P);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
  }
  // soft light pools and grime for depth
  for (let i = 0; i < cols * rows / 12; i += 1) {
    const gx = rnd() * c.width;
    const gy = rnd() * c.height;
    const r = 30 + rnd() * 90;
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    const dark = rnd() < 0.6;
    g.addColorStop(0, dark ? 'rgba(0,0,0,0.22)' : 'rgba(255,220,170,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
  }
  // grid
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = '#f0e2c8';
  ctx.lineWidth = 1;
  for (let x = 0; x <= cols; x += 1) {
    ctx.beginPath(); ctx.moveTo(x * P, 0); ctx.lineTo(x * P, c.height); ctx.stroke();
  }
  for (let y = 0; y <= rows; y += 1) {
    ctx.beginPath(); ctx.moveTo(0, y * P); ctx.lineTo(c.width, y * P); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = canvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Materials: toon shading + ink outlines
// ---------------------------------------------------------------------------

const gradientMap = (() => {
  const data = new Uint8Array([90, 160, 215, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
})();

const matCache = new Map();
function toon(color, { emissive = 0x000000, emissiveIntensity = 1, map = null, transparent = false, opacity = 1 } = {}) {
  const key = `${color}|${emissive}|${emissiveIntensity}|${map ? map.uuid : ''}|${transparent}|${opacity}`;
  if (!matCache.has(key)) {
    matCache.set(key, new THREE.MeshToonMaterial({
      color, gradientMap, emissive, emissiveIntensity, map, transparent, opacity, depthWrite: !transparent,
    }));
  }
  return matCache.get(key);
}

const INK = new THREE.MeshBasicMaterial({ color: 0x120a12, side: THREE.BackSide });

// Inverted-hull outline: a slightly larger back-face copy drawn in ink.
function inked(mesh, thickness = 0.045) {
  const outline = new THREE.Mesh(mesh.geometry, INK);
  mesh.geometry.computeBoundingSphere();
  const r = mesh.geometry.boundingSphere.radius || 1;
  const s = 1 + thickness / r;
  outline.scale.setScalar(s);
  outline.userData.outline = true;
  outline.raycast = () => {};
  mesh.add(outline);
  return mesh;
}

// Outline for detailed (imported) meshes: pushes back faces out along the
// normals, which works for any shape, unlike scaling a hull.
const inkExtrudeCache = new Map();
function inkExtrude(thickness) {
  const key = thickness.toFixed(5);
  if (!inkExtrudeCache.has(key)) {
    const m = new THREE.MeshBasicMaterial({ color: 0x120a12, side: THREE.BackSide });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += normalize(normal) * ${key};`);
    };
    m.customProgramCacheKey = () => `ink-${key}`;
    inkExtrudeCache.set(key, m);
  }
  return inkExtrudeCache.get(key);
}

function part(geometry, material, { pos = [0, 0, 0], rot = [0, 0, 0], scale = null, ink = true, shadow = true } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...pos);
  m.rotation.set(...rot);
  if (scale) m.scale.set(...scale);
  m.castShadow = shadow;
  m.receiveShadow = true;
  if (ink) inked(m);
  return m;
}

const G = {
  sphere: new THREE.SphereGeometry(1, 18, 14),
  lowSphere: new THREE.IcosahedronGeometry(1, 1),
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 14),
  cone: new THREE.ConeGeometry(1, 1, 14),
  capsule: new THREE.CapsuleGeometry(1, 1, 6, 12),
  torus: new THREE.TorusGeometry(1, 0.12, 8, 24),
  disc: new THREE.CylinderGeometry(1, 1, 1, 32),
  plane: new THREE.PlaneGeometry(1, 1),
};

// ---------------------------------------------------------------------------
// Figurines
// ---------------------------------------------------------------------------

const RACE_LOOK = {
  dwarf: { height: 0.8, bulk: 1.25, skin: 0xd9a37f, beard: true },
  elf: { height: 1.05, bulk: 0.85, skin: 0xf0c9a6, ears: true },
  halfling: { height: 0.7, bulk: 0.95, skin: 0xe8b28c },
  human: { height: 1, bulk: 1, skin: 0xe0ab88 },
  dragonborn: { height: 1.08, bulk: 1.2, skin: 0xb5523b, snout: true, horns: 0xe8d5b0 },
  gnome: { height: 0.68, bulk: 0.9, skin: 0xf1bf98, ears: true },
  'half-elf': { height: 1, bulk: 0.95, skin: 0xe6b894, ears: true },
  'half-orc': { height: 1.08, bulk: 1.3, skin: 0x8fa86b, tusks: true },
  tiefling: { height: 1, bulk: 0.95, skin: 0xb8455a, horns: 0x2a1a22, tail: true },
};

const CLASS_LOOK = {
  barbarian: { prop: 'greataxe', armor: null },
  bard: { prop: 'fiddle', armor: null, wideHat: true },
  cleric: { prop: 'mace', armor: 0xb9b2a6, shield: true, glow: 0xffe27a },
  druid: { prop: 'druidstaff', armor: null, glow: 0x9dff6a },
  fighter: { prop: 'sword', armor: 0x9aa3ad, shield: true },
  monk: { prop: null, armor: null, wraps: true },
  paladin: { prop: 'hammer', armor: 0xd6c08a, shield: true, glow: 0xffe27a },
  ranger: { prop: 'bow', armor: null, wideHat: true },
  rogue: { prop: 'daggers', armor: null, hood: true },
  sorcerer: { prop: 'orbs', armor: null, glow: 0xff6fd0 },
  warlock: { prop: 'tome', armor: null, glow: 0xb070ff, wideHat: true },
  wizard: { prop: 'staff', armor: null, hat: true, glow: 0x7fe7ff },
};

function darker(hex, k = 0.6) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return c.getHex();
}

function addProp(g, kind, look, H) {
  const metal = toon(0xc9ccd4);
  const wood = toon(0x6b4423);
  const glow = look.glow || 0x7fe7ff;
  const R = [0.27 * look.bulk, 0.42 * H, 0.05];
  const L = [-0.27 * look.bulk, 0.42 * H, 0.05];
  switch (kind) {
    case 'sword':
      g.add(part(G.box, metal, { pos: [R[0], R[1] + 0.22, R[2]], scale: [0.04, 0.5, 0.08] }));
      g.add(part(G.box, toon(0xd4a24c), { pos: [R[0], R[1] - 0.03, R[2]], scale: [0.16, 0.04, 0.06] }));
      break;
    case 'greataxe':
      g.add(part(G.cyl, wood, { pos: [R[0], R[1] + 0.15, R[2]], scale: [0.025, 0.8, 0.025] }));
      g.add(part(G.box, metal, { pos: [R[0] + 0.1, R[1] + 0.5, R[2]], rot: [0, 0, 0.2], scale: [0.2, 0.22, 0.03] }));
      break;
    case 'hammer':
      g.add(part(G.cyl, wood, { pos: [R[0], R[1] + 0.12, R[2]], scale: [0.025, 0.6, 0.025] }));
      g.add(part(G.box, toon(0xe8d08a, { emissive: glow, emissiveIntensity: 0.6 }), { pos: [R[0], R[1] + 0.44, R[2]], scale: [0.2, 0.12, 0.12] }));
      break;
    case 'mace':
      g.add(part(G.cyl, wood, { pos: [R[0], R[1] + 0.1, R[2]], scale: [0.025, 0.4, 0.025] }));
      g.add(part(G.lowSphere, metal, { pos: [R[0], R[1] + 0.32, R[2]], scale: [0.08, 0.08, 0.08] }));
      break;
    case 'staff':
    case 'druidstaff':
      g.add(part(G.cyl, wood, { pos: [R[0], R[1] + 0.2, R[2]], scale: [0.025, 1.0 * H, 0.025] }));
      g.add(part(G.lowSphere, toon(glow, { emissive: glow, emissiveIntensity: 2.2 }), { pos: [R[0], R[1] + 0.25 + 0.5 * H, R[2]], scale: [0.07, 0.07, 0.07], ink: false }));
      if (kind === 'druidstaff') g.add(part(G.lowSphere, toon(0x4f8f3a), { pos: [R[0], R[1] + 0.2 + 0.5 * H, R[2]], scale: [0.11, 0.07, 0.11] }));
      break;
    case 'bow':
      g.add(part(new THREE.TorusGeometry(0.28, 0.018, 6, 16, Math.PI), wood, { pos: [L[0] - 0.04, L[1] + 0.05, L[2]], rot: [0, Math.PI / 2, Math.PI / 2] }));
      g.add(part(G.cyl, toon(0x5a3a22), { pos: [0, 0.6 * H, -0.18], rot: [0.3, 0, 0], scale: [0.06, 0.3, 0.06] }));
      break;
    case 'daggers':
      g.add(part(G.cone, metal, { pos: [R[0], R[1] + 0.12, R[2]], scale: [0.03, 0.22, 0.03] }));
      g.add(part(G.cone, metal, { pos: [L[0], L[1] + 0.12, L[2]], scale: [0.03, 0.22, 0.03] }));
      break;
    case 'lute':
      g.add(part(G.sphere, toon(0x9a6232), { pos: [0.05, 0.5 * H, 0.2], scale: [0.13, 0.15, 0.05] }));
      g.add(part(G.box, wood, { pos: [0.18, 0.62 * H, 0.2], rot: [0, 0, -0.9], scale: [0.04, 0.3, 0.03] }));
      break;
    case 'fiddle':
      g.add(part(G.sphere, toon(0x7a3a1a), { pos: [-0.08, 0.66 * H, 0.12], rot: [0.3, 0, 0.9], scale: [0.07, 0.11, 0.035] }));
      g.add(part(G.box, toon(0x2a1a12), { pos: [-0.18, 0.74 * H, 0.1], rot: [0.3, 0, 0.9], scale: [0.025, 0.16, 0.02] }));
      g.add(part(G.cyl, toon(0xd8ccb4), { pos: [0.08, 0.6 * H, 0.17], rot: [0, 0, -0.7], scale: [0.01, 0.42, 0.01], ink: false }));
      break;
    case 'orbs':
      for (const p of [R, L]) {
        g.add(part(G.lowSphere, toon(glow, { emissive: glow, emissiveIntensity: 2.5 }), { pos: [p[0], p[1] + 0.05, p[2] + 0.06], scale: [0.06, 0.06, 0.06], ink: false }));
      }
      break;
    case 'tome':
      g.add(part(G.box, toon(0x3a1f4a), { pos: [L[0], L[1] + 0.05, L[2] + 0.06], scale: [0.14, 0.18, 0.05] }));
      g.add(part(G.lowSphere, toon(glow, { emissive: glow, emissiveIntensity: 2.5 }), { pos: [R[0], R[1] + 0.08, R[2] + 0.06], scale: [0.06, 0.06, 0.06], ink: false }));
      break;
    default:
      break;
  }
}

// Muted "sculpted miniature" palette: colours are pulled towards ash and
// bone so figures read like painted resin, with the token colour kept for
// trims (scarf, sash, hat band).
function mute(hex, k = 0.55) {
  const c = new THREE.Color(hex);
  const ash = new THREE.Color(0x8a8076);
  return c.lerp(ash, k).getHex();
}

// An open coat with a torn, jagged hem — the signature of the style.
function raggedCloak(seed, { top = 0.16, bottom = 0.3, height = 0.7, open = 0.5, tear = 0.22 } = {}) {
  const rnd = rngFrom(seed);
  const segs = 22;
  const geo = new THREE.CylinderGeometry(top, bottom, height, segs, 6, true, Math.PI / 2 + open / 2, Math.PI * 2 - open);
  const pos = geo.attributes.position;
  const cuts = Array.from({ length: segs + 1 }, () => rnd());
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const t = (height / 2 - y) / height; // 0 top → 1 hem
    const seg = i % (segs + 1);
    const flutter = (rnd() - 0.5) * 0.03 * t;
    pos.setX(i, pos.getX(i) * (1 + flutter * 4));
    pos.setZ(i, pos.getZ(i) * (1 + flutter * 4));
    if (t > 0.8) {
      // tear the hem into uneven strips
      const strip = cuts[seg] > 0.5 ? 1 : 0.35;
      pos.setY(i, y + tear * height * (1 - strip) * (t - 0.8) * 5 * (0.6 + rnd() * 0.4));
    }
  }
  geo.computeVertexNormals();
  return geo;
}

function wideHat(mat, band, H, headY) {
  const g = new THREE.Group();
  const brim = new THREE.CylinderGeometry(0.26, 0.28, 0.02, 18);
  const pos = brim.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    if (r > 0.2) pos.setY(i, pos.getY(i) - (r - 0.2) * 0.5 + Math.sin(Math.atan2(pos.getZ(i), pos.getX(i)) * 3) * 0.02);
  }
  brim.computeVertexNormals();
  g.add(part(brim, mat, { pos: [0, headY + 0.08, 0], rot: [0.12, 0, 0.05] }));
  g.add(part(new THREE.CylinderGeometry(0.1, 0.13, 0.2, 12), mat, { pos: [0, headY + 0.18, -0.01], rot: [0.15, 0, -0.12] }));
  g.add(part(G.cyl, band, { pos: [0, headY + 0.11, 0], rot: [0.12, 0, 0.05], scale: [0.132, 0.035, 0.132], ink: false }));
  return g;
}

// A stylised gaunt humanoid; returns the group (feet at y = 0) and its height.
function humanoid(o) {
  const H = (o.height || 1) * 1.12;
  const B = (o.bulk || 1) * 0.92;
  const seed = Math.floor((o.seed || 1) * 1000);
  const g = new THREE.Group();
  const ghostOpts = (col, op) => (o.ghost ? { transparent: true, opacity: op, emissive: col, emissiveIntensity: 0.7 } : {});
  const skin = toon(mute(o.skin, 0.25), ghostOpts(o.skin, 0.55));
  const cloth = toon(mute(o.cloth, 0.6), ghostOpts(o.cloth, 0.5));
  const coatCol = o.coat !== undefined ? mute(o.coat, 0.15) : mute(darker(o.cloth, 0.38), 0.35);
  const coat = new THREE.MeshToonMaterial({
    color: coatCol, gradientMap, side: THREE.DoubleSide,
    transparent: Boolean(o.ghost), opacity: o.ghost ? 0.45 : 1,
    emissive: o.ghost ? o.cloth : 0x000000, emissiveIntensity: o.ghost ? 0.6 : 1,
  });
  const trimCol = o.trim !== undefined ? o.trim : o.cloth;
  const trim = toon(trimCol, { emissive: trimCol, emissiveIntensity: 0.15 });
  const leather = toon(0x3a2a20);
  const armor = o.armor ? toon(mute(o.armor, 0.3)) : null;

  // long thin legs with boots
  if (!o.ghost) {
    for (const sgn of [-1, 1]) {
      g.add(part(G.capsule, o.bones ? skin : toon(mute(0x2a2228, 0.2)), { pos: [0.07 * B * sgn, 0.2 * H, 0], rot: [0, 0, -0.04 * sgn], scale: [0.045 * B, 0.15 * H, 0.045 * B] }));
      g.add(part(G.box, leather, { pos: [0.075 * B * sgn, 0.035, 0.03], rot: [0, 0.1 * sgn, 0], scale: [0.09 * B, 0.07, 0.15] }));
    }
  }
  // tattered long coat
  if (o.cloak !== 'none') {
    const short = o.cloak === 'short';
    const coatH = (short ? 0.32 : 0.62) * H;
    const coatMesh = new THREE.Mesh(raggedCloak(seed, { top: 0.13 * B, bottom: (short ? 0.2 : 0.27) * B, height: coatH, open: o.armor ? 0.9 : 0.55 }), coat);
    coatMesh.position.set(0, (short ? 0.56 : 0.36) * H, -0.01);
    coatMesh.castShadow = true;
    inked(coatMesh, 0.02);
    g.add(coatMesh);
  }
  // narrow torso with a slight hunch
  g.add(part(G.cyl, armor || cloth, { pos: [0, 0.6 * H, 0.01], rot: [0.08, 0, 0], scale: [0.12 * B, 0.3 * H, 0.1 * B] }));
  if (armor) g.add(part(G.sphere, armor, { pos: [0, 0.72 * H, 0], scale: [0.19 * B, 0.06 * H, 0.12 * B] }));
  // sash and scarf in the token colour
  g.add(part(G.cyl, trim, { pos: [0, 0.47 * H, 0.005], rot: [0, 0, 0.12], scale: [0.13 * B, 0.03, 0.11 * B], ink: false }));
  g.add(part(G.torus, trim, { pos: [0, 0.77 * H, 0], rot: [Math.PI / 2, 0, 0], scale: [0.1, 0.1, 0.4] }));
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.015), trim);
  tail.position.set(0.06, 0.66 * H, 0.09);
  tail.rotation.set(0.2, 0, -0.25);
  g.add(tail);
  // long arms, slightly bent forward
  for (const sgn of [-1, 1]) {
    g.add(part(G.capsule, o.wraps ? toon(0xd8ccb4) : (armor || cloth), { pos: [0.19 * B * sgn, 0.55 * H, 0.03], rot: [-0.15, 0, 0.18 * sgn], scale: [0.04 * B, 0.17 * H, 0.04 * B] }));
    g.add(part(G.sphere, skin, { pos: [0.23 * B * sgn, 0.37 * H, 0.07], scale: [0.035, 0.04, 0.035] }));
  }
  // small, angular head
  const headY = 0.86 * H;
  g.add(part(G.lowSphere, skin, { pos: [0, headY, 0.01], scale: [0.09, 0.11, 0.095] }));
  if (o.snout) g.add(part(G.cone, skin, { pos: [0, headY - 0.02, 0.12], rot: [Math.PI / 2, 0, 0], scale: [0.06, 0.13, 0.05] }));
  if (o.tusks) for (const sgn of [-1, 1]) g.add(part(G.cone, toon(0xe8dcc0), { pos: [0.04 * sgn, headY - 0.05, 0.09], scale: [0.013, 0.045, 0.013], ink: false }));
  if (o.ears) for (const sgn of [-1, 1]) g.add(part(G.cone, skin, { pos: [0.1 * sgn, headY + 0.02, 0], rot: [0, 0, -1.25 * sgn], scale: [0.025, 0.11, 0.025] }));
  if (o.horns) for (const sgn of [-1, 1]) g.add(part(G.cone, toon(o.horns), { pos: [0.06 * sgn, headY + 0.11, -0.02], rot: [-0.5, 0, -0.4 * sgn], scale: [0.025, 0.13, 0.025] }));
  if (o.beard) g.add(part(G.cone, toon(mute(o.hair || 0x8a4a2a, 0.3)), { pos: [0, headY - 0.09, 0.06], rot: [Math.PI, 0, 0], scale: [0.09, 0.2, 0.06] }));
  if (o.hood) {
    const hood = new THREE.Mesh(raggedCloak(seed + 7, { top: 0.02, bottom: 0.13, height: 0.24, open: 1.4, tear: 0.4 }), coat);
    hood.position.set(0, headY + 0.03, -0.01);
    hood.rotation.x = 0.1;
    inked(hood, 0.015);
    g.add(hood);
  } else if (o.hat) {
    g.add(part(G.cyl, cloth, { pos: [0, headY + 0.08, 0], scale: [0.22, 0.02, 0.22] }));
    g.add(part(G.cone, cloth, { pos: [0.03, headY + 0.27, -0.03], rot: [-0.3, 0, -0.25], scale: [0.11, 0.38, 0.11] }));
  } else if (o.wideHat) {
    g.add(wideHat(toon(mute(0x2a2026, 0.2)), trim, H, headY));
  } else if (o.helm) {
    const metal = toon(o.armor ? mute(o.armor, 0.3) : 0x8a8a94);
    g.add(part(G.sphere, metal, { pos: [0, headY + 0.03, -0.005], scale: [0.11, 0.1, 0.115] }));
    g.add(part(G.box, metal, { pos: [0, headY - 0.02, 0.09], scale: [0.03, 0.09, 0.02] }));
    g.add(part(G.cone, trim, { pos: [0, headY + 0.15, -0.02], rot: [-0.5, 0, 0], scale: [0.025, 0.12, 0.025] }));
  } else if (o.crown) {
    const gold = toon(0xd4a24c, { emissive: 0x5a3a00, emissiveIntensity: 0.6 });
    g.add(part(G.torus, gold, { pos: [0, headY + 0.08, 0], rot: [Math.PI / 2, 0, 0], scale: [0.09, 0.09, 0.5] }));
    for (let k = 0; k < 5; k += 1) {
      const a = (k / 5) * Math.PI * 2;
      g.add(part(G.cone, gold, { pos: [Math.cos(a) * 0.085, headY + 0.12, Math.sin(a) * 0.085], scale: [0.018, 0.06, 0.018], ink: false }));
    }
  } else if (!o.bones && !o.ghost) {
    // unkempt hair
    const hair = toon(mute(o.hair || 0x3a2418, 0.2));
    g.add(part(G.lowSphere, hair, { pos: [0, headY + 0.04, -0.02], scale: [0.1, 0.08, 0.1] }));
    for (let k = 0; k < 4; k += 1) {
      g.add(part(G.cone, hair, { pos: [(k - 1.5) * 0.04, headY + 0.07, -0.03], rot: [-0.6, 0, (k - 1.5) * 0.5], scale: [0.025, 0.09, 0.025], ink: false }));
    }
  }
  if (o.tail) g.add(part(G.capsule, skin, { pos: [0, 0.3 * H, -0.2], rot: [-1.0, 0, 0], scale: [0.02, 0.2, 0.02] }));
  // eyes: dark slits, or glowing for creatures
  const eyeCol = o.eyes || 0x0e0a0c;
  const eyeMat = o.eyes ? toon(eyeCol, { emissive: eyeCol, emissiveIntensity: 3.5 }) : toon(eyeCol);
  for (const sgn of [-1, 1]) g.add(part(G.sphere, eyeMat, { pos: [0.033 * sgn, headY + 0.01, 0.085], scale: [0.016, 0.009, 0.01], ink: false, shadow: false }));
  return { group: g, height: H };
}

function quadruped(o) {
  const g = new THREE.Group();
  const L = o.length || 1;
  const H = o.height || 0.6;
  const fur = toon(o.color);
  const dark = toon(darker(o.color, 0.6));
  g.add(part(G.sphere, fur, { pos: [0, H * 0.62, 0], scale: [0.24 * L, 0.2 * H * 1.4, 0.42 * L] }));
  const legs = o.legs || 4;
  for (let i = 0; i < legs; i += 1) {
    const side = i % 2 ? 1 : -1;
    const row = Math.floor(i / 2);
    const rows = legs / 2;
    const z = (row / Math.max(1, rows - 1) - 0.5) * 0.6 * L;
    if (legs === 8) {
      g.add(part(G.capsule, dark, { pos: [side * 0.32 * L, H * 0.4, z], rot: [0, 0, side * 1.0], scale: [0.03, 0.22, 0.03] }));
    } else {
      g.add(part(G.capsule, dark, { pos: [side * 0.13 * L, H * 0.25, z], scale: [0.05 * L, 0.16 * H * 1.4, 0.05 * L] }));
    }
  }
  const headZ = 0.45 * L;
  g.add(part(G.sphere, fur, { pos: [0, H * 0.8, headZ], scale: [0.15 * L, 0.14 * L, 0.17 * L] }));
  if (o.snout !== false) g.add(part(G.cone, dark, { pos: [0, H * 0.76, headZ + 0.17 * L], rot: [Math.PI / 2, 0, 0], scale: [0.07 * L, 0.16 * L, 0.06 * L] }));
  if (o.ears) for (const s of [-1, 1]) g.add(part(G.cone, dark, { pos: [0.08 * L * s, H * 0.95, headZ - 0.02], scale: [0.04 * L, 0.1 * L, 0.03 * L] }));
  if (o.tail !== false) g.add(part(G.capsule, dark, { pos: [0, H * 0.7, -0.5 * L], rot: [-1.1, 0, 0], scale: [0.04 * L, 0.2 * L, 0.04 * L] }));
  const eyeCol = o.eyes || 0xffd24a;
  for (const s of [-1, 1]) {
    g.add(part(G.sphere, toon(eyeCol, { emissive: eyeCol, emissiveIntensity: 3 }), { pos: [0.07 * L * s, H * 0.86, headZ + 0.13 * L], scale: [0.025, 0.025, 0.02], ink: false, shadow: false }));
  }
  if (o.wings) {
    const wingMat = toon(darker(o.color, 0.8));
    const wingGeo = new THREE.ConeGeometry(1, 1, 3);
    for (const s of [-1, 1]) {
      g.add(part(wingGeo, wingMat, { pos: [s * 0.42 * L, H * 1.0, -0.05], rot: [0, 0, s * 1.35], scale: [0.3 * L, 0.55 * L, 0.04] }));
    }
  }
  if (o.horns) for (const s of [-1, 1]) g.add(part(G.cone, toon(0xe8dcc0), { pos: [0.07 * L * s, H * 1.0, headZ - 0.05], rot: [-0.6, 0, 0], scale: [0.025 * L, 0.14 * L, 0.025 * L] }));
  return { group: g, height: H * 1.05 };
}

function blob(o) {
  const g = new THREE.Group();
  const col = o.color;
  const mat = toon(col, { emissive: col, emissiveIntensity: o.glow || 0.5, transparent: Boolean(o.opacity), opacity: o.opacity || 1 });
  const body = part(G.sphere, mat, { pos: [0, 0.32, 0], scale: [0.4, 0.32, 0.4] });
  body.userData.wobble = true;
  g.add(body);
  if (o.tentacles) {
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2;
      g.add(part(G.capsule, toon(darker(col, 0.7)), { pos: [Math.cos(a) * 0.36, 0.12, Math.sin(a) * 0.36], rot: [Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9], scale: [0.04, 0.16, 0.04] }));
    }
  }
  if (o.eye) {
    g.add(part(G.sphere, toon(0xfff2c8), { pos: [0, 0.42, 0.3], scale: [0.12, 0.12, 0.08] }));
    g.add(part(G.sphere, toon(0x1a0a14, { emissive: 0xff2a6a, emissiveIntensity: 1.5 }), { pos: [0, 0.42, 0.37], scale: [0.05, 0.05, 0.03], ink: false }));
  }
  return { group: g, height: 0.7 };
}

function elementalModel(color) {
  const g = new THREE.Group();
  const core = part(G.lowSphere, toon(color, { emissive: color, emissiveIntensity: 2.5 }), { pos: [0, 0.6, 0], scale: [0.26, 0.4, 0.26], ink: false });
  core.userData.wobble = true;
  g.add(core);
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2;
    g.add(part(G.lowSphere, toon(color, { emissive: color, emissiveIntensity: 1.5, transparent: true, opacity: 0.7 }), { pos: [Math.cos(a) * 0.25, 0.3 + (i % 2) * 0.4, Math.sin(a) * 0.25], scale: [0.1, 0.12, 0.1], ink: false }));
  }
  return { group: g, height: 1.0 };
}

function treantModel(color) {
  const g = new THREE.Group();
  g.add(part(G.cyl, toon(0x5b3a22), { pos: [0, 0.4, 0], scale: [0.14, 0.8, 0.14] }));
  for (let i = 0; i < 3; i += 1) {
    g.add(part(G.lowSphere, toon(color), { pos: [(i - 1) * 0.15, 0.85 + (i % 2) * 0.1, 0], scale: [0.22, 0.2, 0.22] }));
  }
  for (const s of [-1, 1]) g.add(part(G.capsule, toon(0x5b3a22), { pos: [0.2 * s, 0.55, 0.05], rot: [0, 0, 0.9 * s], scale: [0.03, 0.18, 0.03] }));
  return { group: g, height: 1.1 };
}

const NAMED_COLORS = [
  [/red|fire|magma|hell|flame/, 0xc8402a], [/black|shadow/, 0x2a2430], [/green|hag/, 0x4f8f3a], [/blue|storm/, 0x3a6fc8],
  [/white|ice|frost|winter/, 0xdfe8f0], [/gold/, 0xd4a24c], [/silver/, 0xb8c0cc], [/brass/, 0xc89a4a], [/bronze/, 0xa86a3a],
  [/copper/, 0xc07a4a], [/wolf|worg/, 0x6d6a72], [/rat/, 0x6a5040], [/bear|owlbear/, 0x6b4a2e], [/frog|toad/, 0x5f9a3a],
  [/croc|lizard/, 0x5a7a3a], [/spider|ettercap/, 0x3a2a44], [/boar/, 0x5a4030], [/snake/, 0x6a8a3a], [/ape/, 0x4a3a30],
];

function colorFor(name, fallback) {
  const n = name.toLowerCase();
  for (const [re, c] of NAMED_COLORS) if (re.test(n)) return c;
  return fallback;
}

function monsterModel(token) {
  const id = (token.monsterId || '').toLowerCase();
  const name = `${id} ${token.label}`.toLowerCase();
  const icon = token.icon || '';
  const tint = colorFor(name, 0x7a6a5a);
  if (/dragon|wyrmling|drake|wyvern/.test(name)) return quadruped({ color: colorFor(name, 0xa83a2a), length: 1.2, height: 0.7, wings: true, horns: true, eyes: 0xffd24a });
  if (/spider|ettercap/.test(name)) return quadruped({ color: 0x3a2a44, length: 0.9, height: 0.5, legs: 8, snout: false, tail: false, eyes: 0xff3a5a });
  if (/skeleton|lich/.test(name)) return humanoid({ skin: 0xe8e0c8, cloth: 0x4a4458, bones: true, eyes: 0x7fe7ff, height: 1, bulk: 0.8 });
  if (/ghost|specter|wraith|banshee|wisp|shadow|wight/.test(name)) return humanoid({ skin: 0xa8d8ff, cloth: 0x6a7ab8, ghost: true, eyes: 0x7fe7ff, height: 1.05, hood: true });
  if (/zombie|ghoul|ghast|mummy/.test(name)) return humanoid({ skin: 0x8a9a7a, cloth: 0x4a4a3a, eyes: 0xc6ff3d, height: 1, bulk: 1.05 });
  if (/goblin/.test(name)) return humanoid({ skin: 0x7fa04a, cloth: 0x6a4a2a, height: 0.72, bulk: 0.9, ears: true, eyes: 0xffd24a });
  if (/hobgoblin|bugbear/.test(name)) return humanoid({ skin: /bug/.test(name) ? 0x9a6a3a : 0xc0603a, cloth: 0x4a2a2a, height: 1.15, bulk: 1.25, ears: true, eyes: 0xffd24a, armor: 0x6a6a74 });
  if (/kobold/.test(name)) return humanoid({ skin: 0xa8502a, cloth: 0x5a3a2a, height: 0.68, bulk: 0.85, snout: true, tail: true, eyes: 0xffd24a });
  if (/orc|gnoll/.test(name)) return humanoid({ skin: /gnoll/.test(name) ? 0xa8885a : 0x6f8a5a, cloth: 0x4a2a2a, height: 1.08, bulk: 1.3, tusks: true, eyes: 0xff5a3a });
  if (/ogre|troll|giant|ettin|minotaur/.test(name)) return humanoid({ skin: colorFor(name, /troll/.test(name) ? 0x5a7a4a : 0xa88a6a), cloth: 0x5a3a2a, height: 1.35, bulk: 1.6, tusks: true, horns: /minotaur/.test(name) ? 0xe8dcc0 : null, eyes: 0xff7a2a });
  if (/imp|devil|demon|quasit|fiend/.test(name) || icon === 'fiend') return humanoid({ skin: 0xa82a3a, cloth: 0x2a1018, horns: 0x2a1a22, tail: true, eyes: 0xffd24a, height: 0.8 });
  if (/hag|witch|cult|mage|priest|acolyte|druid/.test(name)) return humanoid({ skin: /hag/.test(name) ? 0x6a9a4a : 0xd8a888, cloth: /cult/.test(name) ? 0x6a1a2a : 0x3a2a5a, hood: true, eyes: 0xb070ff });
  if (icon === 'beast' || icon === 'monstrosity') {
    const big = /bear|owlbear|horse|tiger|lion|ape|elk|boar|croc|basilisk|chimera|ankheg/.test(name);
    return quadruped({ color: tint, length: big ? 1.15 : 0.8, height: big ? 0.65 : 0.45, ears: /wolf|worg|rat|cat|tiger|lion|bear/.test(name), wings: /bat|owl|hawk|eagle|stirge|harpy|chimera/.test(name), horns: /goat|boar|chimera/.test(name) });
  }
  if (icon === 'ooze') return blob({ color: colorFor(name, 0x7dff6a), opacity: 0.75, glow: 0.8 });
  if (icon === 'aberration') return blob({ color: 0x8a4a9a, tentacles: true, eye: true, glow: 0.2 });
  if (icon === 'elemental') return elementalModel(colorFor(name, /water/.test(name) ? 0x3a9aff : /air/.test(name) ? 0xcfe8ff : /earth/.test(name) ? 0x8a6a4a : 0xff7a2a));
  if (icon === 'plant') return treantModel(0x4f8f3a);
  if (icon === 'fey') return humanoid({ skin: 0xc8f0d8, cloth: 0x4fbf8a, height: 0.75, ears: true, eyes: 0x9dff6a });
  if (icon === 'construct') return humanoid({ skin: 0x8a8a96, cloth: 0x5a5a66, armor: 0x8a8a96, eyes: 0x7fe7ff, bulk: 1.3 });
  if (icon === 'celestial') return humanoid({ skin: 0xffe8c8, cloth: 0xf0e0a0, eyes: 0xffe27a, height: 1.1 });
  if (icon === 'giant') return humanoid({ skin: 0xb8906a, cloth: 0x5a4a3a, height: 1.4, bulk: 1.6 });
  if (icon === 'swarm') return blob({ color: 0x3a3030, opacity: 0.85, glow: 0 });
  if (icon === 'dragon') return quadruped({ color: tint, length: 1.2, height: 0.7, wings: true, horns: true });
  // humanoid NPCs and custom DM tokens
  return humanoid({ skin: 0xd8a888, cloth: token.color ? new THREE.Color(token.color).getHex() : 0x7a2a2a, hood: true, eyes: icon ? 0xffd24a : null });
}

const hexOr = (v, fallback) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? new THREE.Color(v).getHex() : fallback);
const triOr = (v, fallback) => (v === 'yes' ? true : v === 'no' ? false : fallback);

function heroModel(c) {
  const baseRace = RACE_LOOK[c.raceId] || RACE_LOOK[(c.race || '').toLowerCase()] || RACE_LOOK.human;
  const baseLook = CLASS_LOOK[c.clsId || c.icon] || { prop: 'sword', armor: null };
  const sk = c.skin || {};
  const race = {
    ...baseRace,
    skin: hexOr(sk.skin, baseRace.skin),
    ears: triOr(sk.ears, baseRace.ears),
    beard: triOr(sk.beard, baseRace.beard),
    tusks: triOr(sk.tusks, baseRace.tusks),
    horns: sk.horns === 'none' ? null : hexOr(sk.horns, baseRace.horns),
    eyes: sk.eyes === 'none' || !sk.eyes ? baseRace.eyes : hexOr(sk.eyes, baseRace.eyes),
  };
  const head = sk.headwear && sk.headwear !== 'auto' ? sk.headwear : null;
  const look = {
    ...baseLook,
    prop: sk.prop && sk.prop !== 'auto' ? (sk.prop === 'none' ? null : sk.prop) : baseLook.prop,
    armor: sk.armor === 'none' ? null : hexOr(sk.armor, baseLook.armor),
    shield: triOr(sk.shield, baseLook.shield),
    glow: hexOr(sk.glow, baseLook.glow),
    hood: head ? head === 'hood' : baseLook.hood,
    hat: head ? head === 'hat' : baseLook.hat,
    wideHat: head ? head === 'wideHat' : baseLook.wideHat,
    helm: head === 'helm',
    crown: head === 'crown',
  };
  const cloth = new THREE.Color(c.color || '#3498db').getHex();
  const hairs = [0x2a1a12, 0x6a3a1a, 0xc89a4a, 0xe8d8b8, 0x8a2a1a, 0x1a1a2a];
  let h = 0;
  for (const ch of c.id || c.name || 'x') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const m = humanoid({
    ...race,
    cloth,
    coat: sk.coat && /^#/.test(sk.coat) ? hexOr(sk.coat) : undefined,
    trim: sk.trim && /^#/.test(sk.trim) ? hexOr(sk.trim) : undefined,
    cloak: sk.cloak || 'long',
    armor: look.armor,
    hood: look.hood,
    hat: look.hat,
    wideHat: look.wideHat,
    helm: look.helm,
    crown: look.crown,
    wraps: look.wraps,
    hair: hexOr(sk.hair, hairs[h % hairs.length]),
    seed: (h % 997) / 997,
  });
  addProp(m.group, look.prop, { ...race, bulk: race.bulk, glow: look.glow }, race.height);
  if (look.shield) {
    m.group.add(part(G.disc, toon(darker(cloth, 0.8)), { pos: [-0.3 * race.bulk, 0.48 * race.height, 0.08], rot: [Math.PI / 2, 0, Math.PI / 2], scale: [0.17, 0.03, 0.17] }));
    m.group.add(part(G.disc, toon(0xd4a24c), { pos: [-0.32 * race.bulk, 0.48 * race.height, 0.08], rot: [Math.PI / 2, 0, Math.PI / 2], scale: [0.06, 0.035, 0.06], ink: false }));
  }
  return m;
}

// A small spinning preview of a hero (used by the stylist in the sheet).
export function createFigurePreview(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.className = 'figure-preview-canvas';
  container.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 1.0, 3.4);
  camera.lookAt(0, 0.62, 0);
  scene.add(new THREE.HemisphereLight(0xc0a8d8, 0x3a2420, 1.4));
  const key = new THREE.DirectionalLight(0xffc28a, 2.6);
  key.position.set(-2, 3, 2);
  const rim = new THREE.DirectionalLight(0x48d8ff, 2.2);
  rim.position.set(2, 1.5, -2.5);
  scene.add(key, rim);
  const plinth = part(G.disc, toon(0x2a1c22), { pos: [0, -0.04, 0], scale: [0.5, 0.08, 0.5] });
  scene.add(plinth);
  const holder = new THREE.Group();
  scene.add(holder);
  let disposed = false;
  let last = performance.now();
  const resize = () => {
    const w = container.clientWidth || 200;
    const h = container.clientHeight || 220;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  function loop(now) {
    if (disposed) return;
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    holder.rotation.y += dt * 0.7;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
  return {
    show(char) {
      holder.clear();
      const m = heroModel(char);
      m.group.scale.setScalar(1.25);
      holder.add(m.group);
      const ring = part(G.disc, toon(new THREE.Color(char.color || '#888').getHex(), { emissive: new THREE.Color(char.color || '#888').getHex(), emissiveIntensity: 0.15 }), { pos: [0, 0.01, 0], scale: [0.42, 0.04, 0.42], ink: false });
      holder.add(ring);
    },
    dispose() {
      disposed = true;
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Shaders: oil paint (Kuwahara) and the final grade with ink edges.
// ---------------------------------------------------------------------------

const KuwaharaShader = {
  name: 'Kuwahara',
  defines: { R: 3 },
  uniforms: { tDiffuse: { value: null }, resolution: { value: new THREE.Vector2(1, 1) } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    varying vec2 vUv;
    void sector(int x0, int y0, inout vec3 mean, inout float sigma) {
      vec3 m = vec3(0.0); vec3 s = vec3(0.0);
      vec2 texel = 1.0 / resolution;
      for (int j = 0; j <= R; j++) {
        for (int i = 0; i <= R; i++) {
          vec3 c = texture2D(tDiffuse, vUv + vec2(float(x0 + i), float(y0 + j)) * texel).rgb;
          m += c; s += c * c;
        }
      }
      float n = float((R + 1) * (R + 1));
      m /= n;
      vec3 v = abs(s / n - m * m);
      mean = m; sigma = v.r + v.g + v.b;
    }
    void main() {
      vec3 best = vec3(0.0); float bestS = 1e9;
      vec3 m; float s;
      sector(-R, -R, m, s); if (s < bestS) { bestS = s; best = m; }
      sector(0, -R, m, s);  if (s < bestS) { bestS = s; best = m; }
      sector(-R, 0, m, s);  if (s < bestS) { bestS = s; best = m; }
      sector(0, 0, m, s);   if (s < bestS) { bestS = s; best = m; }
      gl_FragColor = vec4(best, 1.0);
    }`,
};

const GradeShader = {
  name: 'PaintGrade',
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    shadowTint: { value: new THREE.Color(0x3a2a6a) },
    highlightTint: { value: new THREE.Color(0xffd8a0) },
    edge: { value: 1.0 },
  },
  vertexShader: KuwaharaShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time;
    uniform vec3 shadowTint;
    uniform vec3 highlightTint;
    uniform float edge;
    varying vec2 vUv;
    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float L(vec2 o) { return lum(texture2D(tDiffuse, vUv + o / resolution).rgb); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // ink: luminance edges
      float gx = -L(vec2(-1, 1)) - 2.0 * L(vec2(-1, 0)) - L(vec2(-1, -1)) + L(vec2(1, 1)) + 2.0 * L(vec2(1, 0)) + L(vec2(1, -1));
      float gy = -L(vec2(-1, -1)) - 2.0 * L(vec2(0, -1)) - L(vec2(1, -1)) + L(vec2(-1, 1)) + 2.0 * L(vec2(0, 1)) + L(vec2(1, 1));
      float e = smoothstep(0.12, 0.45, length(vec2(gx, gy))) * edge;
      c = mix(c, c * 0.3, e * 0.5);
      // split tone: violet shadows, warm highlights
      float l = lum(c);
      c += shadowTint * (1.0 - smoothstep(0.0, 0.4, l)) * 0.06;
      c = mix(c, c * highlightTint * 1.12, smoothstep(0.5, 1.0, l) * 0.25);
      c = mix(vec3(lum(c)), c, 1.2);
      // brush-paper grain and vignette
      float g = hash(floor(vUv * resolution / 2.0) + floor(time * 8.0));
      c += (g - 0.5) * 0.018;
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot(d, d) * 0.7;
      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }`,
};

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export function createTable(container, hooks) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = 'table3d-canvas';
  container.append(renderer.domElement);

  const labels = new CSS2DRenderer();
  labels.domElement.className = 'table3d-labels';
  container.append(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.position.set(0, 16, 15);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.22;
  controls.minPolarAngle = 0.25;
  controls.minDistance = 5;
  controls.maxDistance = 45;
  controls.screenSpacePanning = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.6);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  const rim = new THREE.DirectionalLight(0x3fd6ff, 1.4);
  scene.add(hemi, key, key.target, rim);

  // post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const paint = new ShaderPass(KuwaharaShader);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.6, 0.86);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(paint);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(grade);

  const world = new THREE.Group();
  const tokensGroup = new THREE.Group();
  const fxGroup = new THREE.Group();
  scene.add(world, tokensGroup, fxGroup);

  const state = {
    view: null,
    mapKey: null,
    cols: 24,
    rows: 16,
    tiles: null,
    tokens: new Map(), // id → entry
    quality: 'high',
    targeting: false,
    hovered: null,
    drag: null,
    shake: 0,
    clock: new THREE.Clock(),
    effects: [], // { update(dt) → false when done }
    motes: null,
    water: null,
    focusTarget: null,
    disposed: false,
    lastCurrent: null,
    framedOnce: false,
  };

  const toWorld = (x, y, size = 1) => new THREE.Vector3(x + size / 2 - state.cols / 2, 0, y + size / 2 - state.rows / 2);

  // ---- imported models (public/models/manifest.json) ----
  // Each entry: { id, file, title, use: ['class:bard', 'monster:zombie|ghoul',
  // 'type:undead', 'prop:water'], height, tint, glow, hover, rotate }.
  const library = { entries: [], ready: new Map(), version: 0 };
  const gltfLoader = new GLTFLoader();

  function prepareModel(entry, gltf) {
    const sceneRoot = gltf.scene;
    sceneRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(sceneRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const height = entry.height || 1.15;
    const scale = height / Math.max(1e-6, entry.prop ? Math.max(size.x, size.y, size.z) : size.y);
    const tint = new THREE.Color(entry.tint || '#9a9088').getHex();
    const glow = entry.glow ? new THREE.Color(entry.glow).getHex() : 0x000000;
    const meshes = [];
    sceneRoot.traverse((o) => {
      if (o.isMesh) meshes.push(o);
    });
    // collect first: the outlines added below are meshes too
    meshes.forEach((o) => {
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const old = Array.isArray(o.material) ? o.material[0] : o.material;
      const map = old && old.map ? old.map : null;
      o.material = new THREE.MeshToonMaterial({
        color: map ? 0xffffff : tint,
        map,
        gradientMap,
        emissive: glow,
        emissiveIntensity: entry.glow ? 0.35 : 1,
        side: old && old.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
      });
      o.castShadow = true;
      o.receiveShadow = true;
      if (!o.isSkinnedMesh) {
        const ink = new THREE.Mesh(o.geometry, inkExtrude(0.012 / scale));
        ink.userData.outline = true;
        ink.raycast = () => {};
        o.add(ink);
      }
    });
    return {
      scene: sceneRoot,
      animations: gltf.animations || [],
      scale,
      offset: new THREE.Vector3(-center.x * scale, -box.min.y * scale, -center.z * scale),
      height,
    };
  }

  function loadLibrary() {
    fetch('models/manifest.json').then((r) => (r.ok ? r.json() : null)).then((manifest) => {
      if (!manifest || !Array.isArray(manifest.models)) return;
      library.entries = manifest.models.filter((m) => m && m.id && m.file);
      for (const entry of library.entries) {
        gltfLoader.load(`models/${entry.file}`, (gltf) => {
          if (state.disposed) return;
          try {
            library.ready.set(entry.id, prepareModel(entry, gltf));
          } catch (err) {
            console.warn(`Моделът ${entry.file} не може да се подготви:`, err);
            return;
          }
          library.version += 1;
          if (state.view) {
            placeProps();
            syncTokens(state.view);
          }
        }, undefined, () => { /* file not added yet: keep the built-in figures */ });
      }
    }).catch(() => {});
  }

  function libraryFor(token, char) {
    const name = `${token.monsterId || ''} ${token.label || ''}`.toLowerCase();
    for (const entry of library.entries) {
      if (!library.ready.has(entry.id)) continue;
      for (const rule of entry.use || []) {
        const [kind, value = ''] = String(rule).split(':');
        if (kind === 'class' && char && char.clsId === value) return entry;
        if (kind === 'monster' && !char && value && new RegExp(value, 'i').test(name)) return entry;
        if (kind === 'type' && !char && token.icon === value) return entry;
      }
    }
    return null;
  }

  function instantiate(entry) {
    const src = library.ready.get(entry.id);
    const obj = cloneSkinned(src.scene);
    obj.scale.setScalar(src.scale);
    obj.position.copy(src.offset);
    const turn = new THREE.Group();
    turn.rotation.y = entry.rotate || 0;
    turn.add(obj);
    const group = new THREE.Group();
    group.add(turn);
    if (entry.hover) {
      turn.position.y = entry.hover;
      turn.userData.hover = entry.hover;
    }
    let mixer = null;
    const clips = {};
    if (src.animations.length) {
      mixer = new THREE.AnimationMixer(obj);
      const find = (re) => src.animations.find((a) => re.test(a.name));
      const idle = find(/idle|stand|breath/i) || src.animations[0];
      const walk = find(/walk|run|move/i);
      clips.idle = mixer.clipAction(idle);
      if (walk) clips.walk = mixer.clipAction(walk);
      clips.idle.play();
    }
    return { group, height: src.height + (entry.hover || 0), mixer, clips, imported: true };
  }

  // ---- environment kit (Blender-made, public/models/env/*.glb) ----
  const ENV_NAMES = ['wall-a', 'wall-b', 'wall-crypt', 'rock-a', 'rock-b', 'rock-c', 'tree-a', 'tree-b', 'tree-c',
    'deadtree-a', 'deadtree-b', 'crate', 'barrel', 'bones', 'gravestone', 'mushrooms', 'pillar', 'door', 'crystals'];
  const envKit = new Map(); // name → BufferGeometry with vertex colours
  const envMat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap });
  function loadEnvKit() {
    let pending = ENV_NAMES.length;
    const done = () => {
      pending -= 1;
      if (pending === 0 && envKit.size && state.view) {
        state.mapKey = null; // rebuild the terrain with the kit
        update(state.view);
      }
    };
    for (const name of ENV_NAMES) {
      gltfLoader.load(`models/env/${name}.glb`, (gltf) => {
        let geo = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if (o.isMesh && !geo) {
            geo = o.geometry.clone();
            geo.applyMatrix4(o.matrixWorld);
          }
        });
        if (geo) {
          if (!geo.attributes.normal) geo.computeVertexNormals();
          envKit.set(name, geo);
        }
        done();
      }, undefined, done);
    }
  }

  // Adds instanced copies of a kit piece (with ink outlines) to the world.
  // items: [{ x, z, y, rot, scale: [sx, sy, sz], tint }]
  function placeKit(name, items, { ink = 0.02, shadow = true } = {}) {
    const geo = envKit.get(name);
    if (!geo || !items.length) return false;
    const mesh = new THREE.InstancedMesh(geo, envMat, items.length);
    const outline = ink ? new THREE.InstancedMesh(geo, inkExtrude(ink), items.length) : null;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    items.forEach((it, i) => {
      q.setFromEuler(new THREE.Euler(0, it.rot || 0, 0));
      m4.compose(new THREE.Vector3(it.x, it.y || 0, it.z), q, new THREE.Vector3(...(it.scale || [1, 1, 1])));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, new THREE.Color().setScalar(it.tint || 1));
      if (outline) outline.setMatrixAt(i, m4);
    });
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (outline) world.add(outline);
    world.add(mesh);
    return true;
  }

  // Set pieces such as a ship on the water.
  const propsGroup = new THREE.Group();
  scene.add(propsGroup);
  function placeProps() {
    clearGroup(propsGroup);
    for (const entry of library.entries) {
      if (!library.ready.has(entry.id)) continue;
      const rule = (entry.use || []).find((u) => String(u).startsWith('prop:'));
      if (!rule) continue;
      const where = rule.split(':')[1];
      const cells = where === 'water' ? state.waterCells : state.floorCells;
      if (!cells || !cells.length) continue;
      // the wet (or open) cell with the most neighbours of the same kind
      const set = new Set(cells.map((c) => `${c.x},${c.y}`));
      let best = cells[0];
      let bestN = -1;
      for (const c of cells) {
        let n = 0;
        for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) if (set.has(`${c.x + dx},${c.y + dy}`)) n += 1;
        if (n > bestN) { bestN = n; best = c; }
      }
      const inst = instantiate({ ...entry, hover: 0 });
      const p = toWorld(best.x, best.y);
      inst.group.position.set(p.x, where === 'water' ? -0.05 : 0, p.z);
      inst.group.scale.setScalar(entry.propScale || 1.6);
      inst.group.rotation.y = Math.random() * Math.PI * 2;
      inst.group.userData.bob = where === 'water';
      inst.group.userData.mixer = inst.mixer;
      propsGroup.add(inst.group);
    }
  }

  // ---- quality ----
  function setQuality(q) {
    state.quality = q === 'low' ? 'low' : 'high';
    const high = state.quality === 'high';
    paint.enabled = high;
    bloom.enabled = true;
    bloom.strength = high ? 0.55 : 0.35;
    renderer.shadowMap.enabled = high;
    key.castShadow = high;
    resize();
  }

  function resize() {
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, state.quality === 'high' ? 1.5 : 1);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    paint.uniforms.resolution.value.set(w * dpr, h * dpr);
    grade.uniforms.resolution.value.set(w * dpr, h * dpr);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // ---- terrain ----
  function clearGroup(g) {
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse?.((o) => {
        if (o.isLight && o.dispose) o.dispose();
      });
    }
  }

  function moodFor(map) {
    return MOODS[map.tiles ? map.theme : 'plain'] || MOODS.dungeon;
  }

  function buildTerrain(map) {
    clearGroup(world);
    state.cols = map.cols;
    state.rows = map.rows;
    state.tiles = map.tiles || null;
    const mood = moodFor(map);
    const { cols, rows } = map;

    scene.background = skyTexture(mood.sky);
    scene.fog = new THREE.FogExp2(mood.fog, map.tiles ? 0.012 : 0.008);
    hemi.color.setHex(mood.hemi[0]);
    hemi.groundColor.setHex(mood.hemi[1]);
    hemi.intensity = mood.hemi[2];
    key.color.setHex(mood.key);
    key.intensity = mood.keyI;
    rim.color.setHex(mood.rim);
    rim.intensity = mood.rimI;
    const span = Math.max(cols, rows);
    key.position.set(-span * 0.45, span * 0.8, span * 0.35);
    key.target.position.set(0, 0, 0);
    rim.position.set(span * 0.5, span * 0.35, -span * 0.6);
    const sc = key.shadow.camera;
    sc.left = -span * 0.75; sc.right = span * 0.75; sc.top = span * 0.75; sc.bottom = -span * 0.75;
    sc.near = 1; sc.far = span * 3;
    sc.updateProjectionMatrix();
    grade.uniforms.shadowTint.value.setHex(mood.fog).lerp(new THREE.Color(0x3a2a6a), 0.6);

    // floor
    let floorMat;
    if (!map.tiles && map.background) {
      const tex = new THREE.TextureLoader().setCrossOrigin('anonymous').load(map.background, undefined, undefined, () => {
        floorMat.map = floorTexture(map, mood);
        floorMat.needsUpdate = true;
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      floorMat = new THREE.MeshToonMaterial({ map: tex, gradientMap });
    } else {
      floorMat = new THREE.MeshToonMaterial({ map: floorTexture(map, mood), gradientMap });
    }
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(cols, rows), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.userData.ground = true;
    world.add(floor);

    // a plinth under the board so it floats like a miniature diorama
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(cols + 0.8, 1.2, rows + 0.8), toon(0x2a1c22));
    plinth.position.y = -0.62;
    plinth.receiveShadow = true;
    inked(plinth, 0.03);
    world.add(plinth);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(cols + 0.95, 0.12, rows + 0.95), toon(0xb8893a, { emissive: 0x3a2400, emissiveIntensity: 0.4 }));
    trim.position.y = -0.08;
    world.add(trim);

    state.water = null;
    state.waterCells = [];
    state.floorCells = [];
    if (!map.tiles) {
      addAccents(map, mood, []);
      addMotes(map, mood);
      return;
    }

    const rnd = rngFrom((map.seed || 11) + 99);
    const walls = [];
    const trees = [];
    const water = [];
    const doors = [];
    const bridges = [];
    const floorCells = [];
    const passable = (x, y) => y >= 0 && y < rows && x >= 0 && x < cols && !'#T~'.includes(map.tiles[y][x]);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const ch = map.tiles[y][x];
        if (ch === '#') {
          const nearFloor = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].some(([dx, dy]) => passable(x + dx, y + dy));
          walls.push({ x, y, nearFloor });
        } else if (ch === 'T') trees.push({ x, y });
        else if (ch === '~') water.push({ x, y });
        else if (ch === '+') doors.push({ x, y });
        else if (ch === '=') bridges.push({ x, y });
        else floorCells.push({ x, y });
      }
    }

    // walls from the Blender kit: stone blocks (dungeon/crypt) or boulders (cave);
    // interior walls stay as low dark blocks so rooms read clearly
    let kitWalls = false;
    if (walls.length && envKit.size) {
      const cave = map.theme === 'cave';
      const near = walls.filter((w) => w.nearFloor);
      const names = cave ? ['rock-a', 'rock-b', 'rock-c'] : map.theme === 'crypt' ? ['wall-crypt'] : ['wall-a', 'wall-b'];
      const groups = new Map(names.map((n) => [n, []]));
      near.forEach((w) => {
        const p = toWorld(w.x, w.y);
        const name = names[Math.floor(rnd() * names.length)];
        const h = 0.85 + rnd() * 0.3;
        groups.get(name).push(cave
          ? { x: p.x + (rnd() - 0.5) * 0.15, z: p.z + (rnd() - 0.5) * 0.15, rot: rnd() * 6.28, scale: [1.05 + rnd() * 0.3, 0.7 + rnd() * 0.8, 1.05 + rnd() * 0.3], tint: 0.42 + rnd() * 0.2 }
          : { x: p.x, z: p.z, rot: Math.floor(rnd() * 4) * Math.PI / 2, scale: [1, h, 1], tint: 0.42 + rnd() * 0.16 });
      });
      kitWalls = [...groups].every(([n, items]) => !items.length || placeKit(n, items, { ink: 0.015 }));
      if (kitWalls) {
        const far = walls.filter((w) => !w.nearFloor);
        if (far.length) {
          const mesh = new THREE.InstancedMesh(G.box, toon(darker(new THREE.Color(mood.wall[2]).getHex(), 0.8)), far.length);
          const m4 = new THREE.Matrix4();
          far.forEach((w, i) => {
            const p = toWorld(w.x, w.y);
            const h = 0.25 + rnd() * 0.1;
            m4.compose(new THREE.Vector3(p.x, h / 2, p.z), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
            mesh.setMatrixAt(i, m4);
          });
          mesh.receiveShadow = true;
          world.add(mesh);
        }
      }
    }
    if (walls.length && !kitWalls) {
      const cave = map.theme === 'cave';
      const geo = cave ? new THREE.DodecahedronGeometry(0.62, 0) : new THREE.BoxGeometry(1, 1, 1);
      const side = toon(0xffffff, { map: cave ? blotTexture(mood.wall, 21) : brickTexture(mood.wall, 17) });
      const mesh = new THREE.InstancedMesh(geo, side, walls.length);
      const ink = new THREE.InstancedMesh(geo, INK, walls.length);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      walls.forEach((w, i) => {
        const p = toWorld(w.x, w.y);
        const h = w.nearFloor ? 1.1 + rnd() * 0.5 : 0.22 + rnd() * 0.12;
        if (cave) {
          e.set(rnd() * 3, rnd() * 3, rnd() * 3);
          q.setFromEuler(e);
          const s = 1.05 + rnd() * 0.35;
          m4.compose(new THREE.Vector3(p.x, h * 0.45, p.z), q, new THREE.Vector3(s, h * 1.1, s));
        } else {
          q.identity();
          m4.compose(new THREE.Vector3(p.x, h / 2, p.z), q, new THREE.Vector3(1, h, 1));
        }
        mesh.setMatrixAt(i, m4);
        const tint = new THREE.Color().setHSL(0, 0, w.nearFloor ? 0.85 + rnd() * 0.25 : 0.28 + rnd() * 0.1);
        mesh.setColorAt(i, tint);
        const big = m4.clone().multiply(new THREE.Matrix4().makeScale(1.04, 1.02, 1.04));
        ink.setMatrixAt(i, big);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      world.add(ink, mesh);
    }

    // trees from the kit: leafy trees in the forest, dead ones in the swamp
    let kitTrees = false;
    if (trees.length && envKit.size) {
      const names = map.theme === 'swamp' ? ['deadtree-a', 'deadtree-b'] : ['tree-a', 'tree-b', 'tree-c'];
      const groups = new Map(names.map((n) => [n, []]));
      trees.forEach((t) => {
        const p = toWorld(t.x, t.y);
        const sc = 0.95 + rnd() * 0.45;
        groups.get(names[Math.floor(rnd() * names.length)]).push({
          x: p.x + (rnd() - 0.5) * 0.3, z: p.z + (rnd() - 0.5) * 0.3, rot: rnd() * 6.28, scale: [sc, sc * (0.9 + rnd() * 0.3), sc], tint: 0.85 + rnd() * 0.3,
        });
      });
      kitTrees = [...groups].every(([n, items]) => !items.length || placeKit(n, items, { ink: 0.018 }));
    }
    if (trees.length && !kitTrees) {
      const swamp = map.theme === 'swamp';
      const trunkGeo = new THREE.CylinderGeometry(0.09, 0.16, 1, 7);
      const crownGeo = new THREE.IcosahedronGeometry(0.55, 1);
      const trunkMat = toon(swamp ? 0x3a2e22 : 0x5b3a22);
      const crownMat = toon(0xffffff, { map: blotTexture(swamp ? ['#2f3f22', '#3f5a2a', '#55702f', '#22301a'] : ['#2f5a26', '#3f7a2f', '#5f9a3a', '#c8b04a'], 31) });
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length * 2);
      const crownInk = new THREE.InstancedMesh(crownGeo, INK, trees.length * 2);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      trees.forEach((t, i) => {
        const p = toWorld(t.x, t.y);
        const h = 0.6 + rnd() * 0.5;
        m4.compose(new THREE.Vector3(p.x, h / 2, p.z), q, new THREE.Vector3(1, h, 1));
        trunks.setMatrixAt(i, m4);
        for (let k = 0; k < 2; k += 1) {
          const s = (swamp ? 0.55 : 0.7) + rnd() * 0.3 - k * 0.18;
          const pos = new THREE.Vector3(p.x + (rnd() - 0.5) * 0.25, h + 0.25 + k * 0.45, p.z + (rnd() - 0.5) * 0.25);
          q.setFromEuler(new THREE.Euler(rnd(), rnd() * 6, rnd()));
          m4.compose(pos, q, new THREE.Vector3(s, s * (swamp ? 0.6 : 0.85), s));
          crowns.setMatrixAt(i * 2 + k, m4);
          crowns.setColorAt(i * 2 + k, new THREE.Color().setHSL(0, 0, 0.8 + rnd() * 0.4));
          crownInk.setMatrixAt(i * 2 + k, m4.clone().multiply(new THREE.Matrix4().makeScale(1.07, 1.07, 1.07)));
          q.identity();
        }
      });
      trunks.castShadow = true;
      crowns.castShadow = true;
      crowns.receiveShadow = true;
      world.add(trunks, crownInk, crowns);
    }

    // water: one animated painted surface per wet cell
    if (water.length) {
      const waterMat = new THREE.ShaderMaterial({
        transparent: true,
        fog: true,
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
          time: { value: 0 },
          deep: { value: new THREE.Color(map.theme === 'swamp' ? 0x1f3a2a : 0x0f3a5a) },
          shallow: { value: new THREE.Color(map.theme === 'swamp' ? 0x6aa84a : 0x2fd6d0) },
        }]),
        vertexShader: /* glsl */`
          #include <fog_pars_vertex>
          varying vec2 vWorld;
          void main() {
            vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
            vWorld = wp.xz;
            vec4 mvPosition = viewMatrix * wp;
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: /* glsl */`
          #include <fog_pars_fragment>
          uniform float time; uniform vec3 deep; uniform vec3 shallow;
          varying vec2 vWorld;
          void main() {
            float w = sin(vWorld.x * 2.3 + time * 1.3) * 0.5 + sin(vWorld.y * 3.1 - time * 1.1) * 0.5;
            float bands = smoothstep(0.55, 0.9, sin((vWorld.x + vWorld.y) * 4.0 + w * 2.0 + time) * 0.5 + 0.5);
            vec3 col = mix(deep, shallow, 0.35 + 0.25 * w) + bands * 0.25 * shallow;
            gl_FragColor = vec4(col, 0.88);
            #include <fog_fragment>
          }`,
      });
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.InstancedMesh(geo, waterMat, water.length);
      const m4 = new THREE.Matrix4();
      water.forEach((w, i) => {
        const p = toWorld(w.x, w.y);
        m4.makeTranslation(p.x, 0.04, p.z);
        mesh.setMatrixAt(i, m4);
      });
      world.add(mesh);
      state.water = waterMat;
    }

    // doors and bridges
    const wood = toon(0x6b4423);
    const kitDoors = envKit.has('door') && placeKit('door', doors.map((d) => {
      const p = toWorld(d.x, d.y);
      const horizontal = !passable(d.x - 1, d.y) && !passable(d.x + 1, d.y);
      return { x: p.x, z: p.z, rot: horizontal ? 0 : Math.PI / 2 };
    }), { ink: 0.012 });
    for (const d of kitDoors ? [] : doors) {
      const p = toWorld(d.x, d.y);
      const horizontal = !passable(d.x - 1, d.y) && !passable(d.x + 1, d.y);
      const door = part(G.box, wood, { pos: [p.x, 0.55, p.z], scale: horizontal ? [1, 1.1, 0.14] : [0.14, 1.1, 1] });
      door.add(part(G.sphere, toon(0xd4a24c, { emissive: 0x5a3a00 }), { pos: [horizontal ? 0.3 : 0.6, 0, horizontal ? 0.6 : 0.3], scale: [0.06, 0.06, 0.06], ink: false }));
      world.add(door);
    }
    for (const b of bridges) {
      const p = toWorld(b.x, b.y);
      for (let k = 0; k < 4; k += 1) {
        world.add(part(G.box, wood, { pos: [p.x - 0.36 + k * 0.24, 0.1, p.z], scale: [0.2, 0.08, 0.98], rot: [0, (rnd() - 0.5) * 0.08, 0] }));
      }
    }

    state.waterCells = water;
    state.floorCells = floorCells;
    if (envKit.size) scatterDecor(map, floorCells, walls, rnd);
    addAccents(map, mood, floorCells, walls, rnd);
    addMotes(map, mood);
    placeProps();
  }

  // Small props along the walls: crates and barrels in dungeons, bones and
  // graves in crypts, crystals and mushrooms in caves, and so on.
  const DECOR = {
    dungeon: [['crate', 1], ['barrel', 1], ['bones', 0.6], ['pillar', 0.3]],
    crypt: [['bones', 1], ['gravestone', 0.8], ['pillar', 0.5]],
    cave: [['crystals', 1], ['mushrooms', 0.8], ['bones', 0.4], ['rock-a', 0.4]],
    forest: [['mushrooms', 1], ['rock-b', 0.6], ['crate', 0.15]],
    swamp: [['mushrooms', 1], ['bones', 0.5], ['deadtree-b', 0.2]],
  };
  function scatterDecor(map, floorCells, walls, rnd) {
    const kinds = DECOR[map.theme];
    if (!kinds) return;
    const wallSet = new Set(walls.map((w) => `${w.x},${w.y}`));
    const outdoor = map.theme === 'forest' || map.theme === 'swamp';
    const groups = new Map();
    const total = kinds.reduce((a, [, w]) => a + w, 0);
    for (const c of floorCells) {
      const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => wallSet.has(`${c.x + dx},${c.y + dy}`));
      if (!outdoor && !sides.length) continue;
      if (rnd() > (outdoor ? 0.035 : 0.12)) continue;
      let pickW = rnd() * total;
      const [name] = kinds.find(([, w]) => (pickW -= w) <= 0) || kinds[0];
      const p = toWorld(c.x, c.y);
      const [dx, dy] = sides[0] || [0, 0];
      const small = name.startsWith('rock') || name.startsWith('deadtree') ? 0.45 : 0.75 + rnd() * 0.3;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ x: p.x + dx * 0.3 + (rnd() - 0.5) * 0.2, z: p.z + dy * 0.3 + (rnd() - 0.5) * 0.2, rot: rnd() * 6.28, scale: [small, small, small], tint: 0.85 + rnd() * 0.3 });
    }
    for (const [name, items] of groups) placeKit(name, items, { ink: 0.01 });
  }

  // Braziers, candles, crystals, fireflies or chem lamps — each with light.
  function addAccents(map, mood, floorCells, walls = [], rnd = Math.random) {
    const count = Math.min(6, Math.max(2, Math.floor((map.cols * map.rows) / 110)));
    const spots = [];
    const pool = floorCells.length ? floorCells : [{ x: 1, y: 1 }, { x: map.cols - 2, y: map.rows - 2 }, { x: 1, y: map.rows - 2 }, { x: map.cols - 2, y: 1 }];
    const wallSet = new Set(walls.map((w) => `${w.x},${w.y}`));
    const nearWall = pool.filter((c) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => wallSet.has(`${c.x + dx},${c.y + dy}`)));
    const src = nearWall.length > count ? nearWall : pool;
    for (let i = 0; i < count && src.length; i += 1) {
      const c = src[Math.floor(rnd() * src.length)];
      if (spots.some((s) => Math.abs(s.x - c.x) + Math.abs(s.y - c.y) < 5)) continue;
      spots.push(c);
    }
    spots.forEach((c, i) => {
      const color = mood.accent[i % mood.accent.length];
      const p = toWorld(c.x, c.y);
      const offset = new THREE.Vector3((rnd() - 0.5) * 0.5, 0, (rnd() - 0.5) * 0.5);
      p.add(offset);
      const light = new THREE.PointLight(color, 6, 7, 1.6);
      const lamp = new THREE.Group();
      lamp.position.copy(p);
      if (mood.accentKind === 'brazier') {
        lamp.add(part(G.cyl, toon(0x3a2a22), { pos: [0, 0.25, 0], scale: [0.05, 0.5, 0.05] }));
        lamp.add(part(G.cyl, toon(0x5a4030), { pos: [0, 0.52, 0], scale: [0.18, 0.08, 0.18] }));
        const flame = part(G.cone, toon(color, { emissive: color, emissiveIntensity: 3 }), { pos: [0, 0.68, 0], scale: [0.12, 0.28, 0.12], ink: false, shadow: false });
        flame.userData.flicker = true;
        lamp.add(flame);
        light.position.y = 0.9;
      } else if (mood.accentKind === 'candles') {
        for (let k = 0; k < 3; k += 1) {
          const a = (k / 3) * Math.PI * 2;
          lamp.add(part(G.cyl, toon(0xe8dcc0), { pos: [Math.cos(a) * 0.12, 0.1 + k * 0.03, Math.sin(a) * 0.12], scale: [0.035, 0.2 + k * 0.06, 0.035] }));
          const f = part(G.sphere, toon(color, { emissive: color, emissiveIntensity: 3 }), { pos: [Math.cos(a) * 0.12, 0.25 + k * 0.06, Math.sin(a) * 0.12], scale: [0.03, 0.05, 0.03], ink: false, shadow: false });
          f.userData.flicker = true;
          lamp.add(f);
        }
        light.position.y = 0.5;
      } else if (mood.accentKind === 'crystals') {
        for (let k = 0; k < 4; k += 1) {
          lamp.add(part(G.cone, toon(color, { emissive: color, emissiveIntensity: 1.6 }), { pos: [(rnd() - 0.5) * 0.3, 0.2, (rnd() - 0.5) * 0.3], rot: [(rnd() - 0.5) * 0.6, 0, (rnd() - 0.5) * 0.6], scale: [0.07, 0.3 + rnd() * 0.35, 0.07] }));
        }
        light.position.y = 0.5;
      } else if (mood.accentKind === 'chem') {
        lamp.add(part(G.cyl, toon(0x2a2a30), { pos: [0, 0.4, 0], scale: [0.04, 0.8, 0.04] }));
        const bulb = part(G.sphere, toon(color, { emissive: color, emissiveIntensity: 2.6, transparent: true, opacity: 0.9 }), { pos: [0, 0.85, 0], scale: [0.12, 0.16, 0.12] });
        bulb.userData.flicker = true;
        lamp.add(bulb);
        light.position.y = 0.9;
      } else {
        const orb = part(G.sphere, toon(color, { emissive: color, emissiveIntensity: 3 }), { pos: [0, 0.6, 0], scale: [0.05, 0.05, 0.05], ink: false, shadow: false });
        orb.userData.float = true;
        lamp.add(orb);
        light.position.y = 0.6;
        light.intensity = 3;
      }
      lamp.add(light);
      lamp.userData.light = light;
      world.add(lamp);
    });
  }

  function addMotes(map, mood) {
    const n = state.quality === 'high' ? 260 : 120;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      pos[i * 3] = (Math.random() - 0.5) * map.cols;
      pos[i * 3 + 1] = Math.random() * 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * map.rows;
      seed[i] = Math.random() * 100;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.PointsMaterial({ color: mood.motes, size: 0.07, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    pts.userData.motes = true;
    world.add(pts);
    state.motes = pts;
  }

  // ---- tokens ----
  function labelFor(entry) {
    const el = document.createElement('div');
    el.className = 'nameplate';
    const portrait = document.createElement('span');
    portrait.className = 'np-portrait';
    const name = document.createElement('span');
    name.className = 'np-name';
    const bar = document.createElement('span');
    bar.className = 'np-hp';
    const fill = document.createElement('i');
    bar.append(fill);
    el.append(portrait, name, bar);
    const obj = new CSS2DObject(el);
    obj.center.set(0.5, 1);
    entry.label = { obj, el, name, fill, bar, portrait };
    return obj;
  }

  function setPortrait(entry, token, char) {
    const key = `${token.image || ''}|${token.icon || (char && char.icon) || ''}`;
    if (entry.portraitKey === key) return;
    entry.portraitKey = key;
    const box = entry.label.portrait;
    box.replaceChildren();
    const icon = token.icon || (char && char.icon);
    if (!token.image && !icon) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    const img = document.createElement('img');
    img.alt = '';
    const useIcon = () => {
      img.onerror = null;
      img.src = `icons/${icon || 'monstrosity'}.svg`;
      img.classList.add('icon');
    };
    if (token.image) {
      img.src = token.image;
      img.onerror = useIcon;
    } else useIcon();
    box.append(img);
  }

  function buildModel(token, char) {
    const entry = char && char.skin ? null : libraryFor(token, char);
    if (entry) return instantiate(entry);
    if (char) return heroModel(char);
    return monsterModel(token);
  }

  function ring(color, radius, width = 0.06) {
    const geo = new THREE.RingGeometry(radius - width, radius, 48);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.035;
    m.raycast = () => {};
    return m;
  }

  function createEntry(token, char) {
    const root = new THREE.Group();
    root.userData.tokenId = token.id;
    const model = buildModel(token, char);
    const pivot = new THREE.Group(); // tilts for death / downed
    const scale = token.size * (char ? 1.25 : 1.2);
    model.group.scale.setScalar(scale);
    pivot.add(model.group);
    root.add(pivot);

    // base disc in the token's colour
    const baseColor = new THREE.Color(char ? char.color : token.color || '#7b241c').getHex();
    const base = part(G.disc, toon(baseColor, { emissive: baseColor, emissiveIntensity: 0.12 }), { pos: [0, 0.03, 0], scale: [0.42 * token.size, 0.06, 0.42 * token.size] });
    root.add(base);
    const rnd = rngFrom(Math.floor(Math.random() * 1e6));
    const debris = toon(0x4a3a2e);
    const stone = toon(0x6a625a);
    for (let k = 0; k < 4; k += 1) {
      const a = rnd() * Math.PI * 2;
      const r = (0.24 + rnd() * 0.12) * token.size;
      if (rnd() < 0.55) {
        root.add(part(G.box, debris, { pos: [Math.cos(a) * r, 0.08, Math.sin(a) * r], rot: [rnd() * 0.5, rnd() * 3, rnd() * 0.4], scale: [0.2 * token.size, 0.03, 0.05] }));
      } else {
        root.add(part(G.lowSphere, stone, { pos: [Math.cos(a) * r, 0.07, Math.sin(a) * r], scale: [0.045, 0.035, 0.05] }));
      }
    }

    // invisible hit box for picking
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * token.size, 0.45 * token.size, Math.max(1, model.height * scale) + 0.2, 10), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = (Math.max(1, model.height * scale) + 0.2) / 2;
    hit.userData.tokenId = token.id;
    root.add(hit);

    const selRing = ring(0x7fe7ff, 0.5 * token.size);
    const turnRing = ring(0xffc65a, 0.56 * token.size, 0.09);
    const hoverRing = ring(0xff4a5a, 0.62 * token.size, 0.05);
    selRing.visible = false;
    turnRing.visible = false;
    hoverRing.visible = false;
    root.add(selRing, turnRing, hoverRing);

    const entry = {
      id: token.id, root, pivot, model: model.group, height: model.height * scale, hit, selRing, turnRing, hoverRing,
      mixer: model.mixer || null, clips: model.clips || {}, imported: Boolean(model.imported), walking: false,
      modelKey: null, pos: new THREE.Vector3(), from: null, to: null, t: 1, dur: 0, facing: 0, lunge: null,
      flash: 0, tilt: 0, tiltTarget: 0, opacity: 1, seed: Math.random() * 10,
    };
    const lbl = labelFor(entry);
    lbl.position.set(0, entry.height + 0.25, 0);
    root.add(lbl);
    tokensGroup.add(root);
    return entry;
  }

  function modelKeyFor(token, char) {
    const lib = char && char.skin ? `skin:${JSON.stringify(char.skin)}` : (libraryFor(token, char) || {}).id || '';
    return char ? `${char.raceId}|${char.clsId}|${char.color}|${char.icon}|${token.size}|${lib}` : `${token.monsterId}|${token.icon}|${token.label}|${token.color}|${token.size}|${lib}`;
  }

  function syncTokens(view) {
    const seen = new Set();
    const current = currentTokenId(view);
    for (const token of view.tokens) {
      seen.add(token.id);
      const char = token.characterId ? view.characters.find((c) => c.id === token.characterId) : null;
      let entry = state.tokens.get(token.id);
      const mk = modelKeyFor(token, char);
      if (entry && entry.modelKey !== mk) {
        tokensGroup.remove(entry.root);
        state.tokens.delete(token.id);
        entry = null;
      }
      const target = toWorld(token.x, token.y, token.size);
      if (!entry) {
        entry = createEntry(token, char);
        entry.modelKey = mk;
        entry.pos.copy(target);
        entry.root.position.copy(target);
        entry.facing = Math.PI * 0.15;
        state.tokens.set(token.id, entry);
      } else if (!entry.pos.equals(target) && !(state.drag && state.drag.id === token.id)) {
        // walk / hop to the new cell
        entry.from = entry.root.position.clone();
        entry.to = target.clone();
        entry.t = 0;
        entry.dur = Math.min(1.4, 0.25 + entry.from.distanceTo(target) * 0.12);
        const d = target.clone().sub(entry.from);
        if (d.lengthSq() > 0.01) entry.facing = Math.atan2(d.x, d.z);
        entry.pos.copy(target);
      }
      entry.token = token;
      entry.char = char;
      const down = char ? char.hp <= 0 : Boolean(token.dead);
      entry.tiltTarget = down ? 1 : 0;
      entry.opacityTarget = token.hidden ? 0.45 : 1;
      entry.selRing.visible = hooks.selectedId() === token.id;
      entry.turnRing.visible = current === token.id;

      // nameplate
      const lb = entry.label;
      lb.name.textContent = token.label;
      lb.el.classList.toggle('pc', Boolean(char));
      lb.el.classList.toggle('dead', down);
      lb.el.classList.toggle('current', current === token.id);
      lb.el.classList.toggle('selected', hooks.selectedId() === token.id);
      lb.el.classList.toggle('hidden-token', Boolean(token.hidden));
      let pct = null;
      if (char) pct = (char.hp / char.maxHp) * 100;
      else if (token.maxHp) pct = (token.hp / token.maxHp) * 100;
      else if (token.hpPct !== null && token.hpPct !== undefined) pct = token.hpPct;
      lb.bar.style.display = pct === null || down ? 'none' : '';
      if (pct !== null) {
        const p = Math.max(0, Math.min(100, pct));
        lb.fill.style.width = `${p}%`;
        lb.fill.style.background = p > 50 ? 'linear-gradient(90deg,#2fd6a0,#7dffcb)' : p > 20 ? 'linear-gradient(90deg,#ffb03a,#ffd27a)' : 'linear-gradient(90deg,#ff2a6a,#ff7aa0)';
      }
      setPortrait(entry, token, char);
    }
    for (const [id, entry] of state.tokens) {
      if (!seen.has(id)) {
        tokensGroup.remove(entry.root);
        entry.label.obj.element.remove();
        state.tokens.delete(id);
      }
    }
    if (current && current !== state.lastCurrent) focus(current);
    state.lastCurrent = current;
  }

  function currentTokenId(view) {
    const e = view.initiative.entries.find((x) => x.id === view.initiative.currentId);
    if (!e) return null;
    if (e.tokenId) return e.tokenId;
    const t = e.characterId && view.tokens.find((x) => x.characterId === e.characterId);
    return t ? t.id : null;
  }

  // ---- public: update ----
  function update(view) {
    state.view = view;
    const map = view.map;
    const key = `${map.theme}|${map.cols}|${map.rows}|${map.background}|${map.tiles ? map.tiles.join('') : ''}`;
    if (key !== state.mapKey) {
      state.mapKey = key;
      buildTerrain(map);
      frameBoard();
    }
    syncTokens(view);
  }

  function frameBoard() {
    const span = Math.max(state.cols, state.rows);
    controls.target.set(0, 0, 0);
    camera.position.set(0, span * 0.5, span * 0.48);
    controls.maxDistance = span * 2;
    controls.update();
  }

  function focus(id) {
    const e = state.tokens.get(id);
    if (!e) return;
    state.focusTarget = e.pos.clone();
    const dist = camera.position.distanceTo(controls.target);
    if (dist > 16) state.zoomTo = 13;
  }

  // ---- fx ----
  function headOf(entry) {
    return entry.root.position.clone().add(new THREE.Vector3(0, entry.height * 0.7 + 0.2, 0));
  }

  function floatText(entry, text, cls) {
    const el = document.createElement('div');
    el.className = `float-text ${cls}`;
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.copy(headOf(entry)).add(new THREE.Vector3(0, 0.3, 0));
    fxGroup.add(obj);
    let life = 0;
    state.effects.push((dt) => {
      life += dt;
      obj.position.y += dt * 0.6;
      if (life > 1.3) {
        fxGroup.remove(obj);
        el.remove();
        return false;
      }
      return true;
    });
  }

  function burst(at, color, count = 26, speed = 2.2, life = 0.7) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const vel = [];
    for (let i = 0; i < count; i += 1) {
      pos.set([at.x, at.y, at.z], i * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
      vel.push(v);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.14, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    fxGroup.add(pts);
    let t = 0;
    state.effects.push((dt) => {
      t += dt;
      const arr = geo.attributes.position.array;
      for (let i = 0; i < count; i += 1) {
        vel[i].y -= dt * 3;
        arr[i * 3] += vel[i].x * dt;
        arr[i * 3 + 1] += vel[i].y * dt;
        arr[i * 3 + 2] += vel[i].z * dt;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = Math.max(0, 1 - t / life);
      if (t > life) {
        fxGroup.remove(pts);
        geo.dispose();
        mat.dispose();
        return false;
      }
      return true;
    });
  }

  function projectile(from, to, color, arrow, onHit) {
    const group = new THREE.Group();
    if (arrow) {
      group.add(part(G.cyl, toon(0x6b4423), { rot: [Math.PI / 2, 0, 0], scale: [0.02, 0.5, 0.02], ink: false }));
      group.add(part(G.cone, toon(0xc9ccd4), { pos: [0, 0, 0.27], rot: [Math.PI / 2, 0, 0], scale: [0.04, 0.1, 0.04], ink: false }));
    } else {
      group.add(new THREE.Mesh(G.sphere, new THREE.MeshBasicMaterial({ color })));
      group.children[0].scale.setScalar(0.13);
      const halo = new THREE.Mesh(G.sphere, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar(0.28);
      group.add(halo);
    }
    group.position.copy(from);
    fxGroup.add(group);
    const dist = from.distanceTo(to);
    const dur = Math.min(0.9, 0.15 + dist * 0.06);
    let t = 0;
    let trail = 0;
    state.effects.push((dt) => {
      t += dt;
      const k = Math.min(1, t / dur);
      const p = from.clone().lerp(to, k);
      p.y += Math.sin(k * Math.PI) * dist * (arrow ? 0.12 : 0.06);
      group.lookAt(p);
      group.position.copy(p);
      trail += dt;
      if (!arrow && trail > 0.03) {
        trail = 0;
        burst(p, color, 3, 0.4, 0.35);
      }
      if (k >= 1) {
        fxGroup.remove(group);
        onHit();
        return false;
      }
      return true;
    });
  }

  function flashHit(entry, crit) {
    entry.flash = crit ? 1.4 : 1;
    if (crit) state.shake = 0.35;
  }

  function fx(e) {
    const to = e.to && state.tokens.get(e.to);
    const from = e.from && state.tokens.get(e.from);
    if (e.kind === 'attack' && to) {
      const color = ELEMENT_COLORS[e.element] || 0xffffff;
      const impact = () => {
        if (e.hit) {
          flashHit(to, e.crit);
          burst(headOf(to), e.crit ? 0xffd24a : color, e.crit ? 50 : 26, e.crit ? 3.2 : 2.2);
          floatText(to, `${e.crit ? '✦ ' : '−'}${e.damage}`, e.crit ? 'crit' : 'dmg');
        } else {
          floatText(to, 'пропуск', 'miss');
        }
      };
      if (from) {
        const d = to.root.position.clone().sub(from.root.position);
        from.facing = Math.atan2(d.x, d.z);
        if (e.ranged) {
          from.lunge = { t: 0, dir: d.clone().normalize().multiplyScalar(-0.12), dur: 0.3 };
          const arrow = !e.spell && /Piercing/.test(e.element || '');
          setTimeout(() => projectile(headOf(from), headOf(to), color, arrow, impact), 120);
        } else {
          from.lunge = { t: 0, dir: d.clone().normalize().multiplyScalar(Math.min(0.55, d.length() * 0.45)), dur: 0.38 };
          setTimeout(impact, 170);
        }
      } else {
        impact();
      }
    } else if (e.kind === 'area') {
      const color = ELEMENT_COLORS[e.element] || 0xff7a2a;
      const targets = (e.targets || []).map((id) => state.tokens.get(id)).filter(Boolean);
      if (from) {
        for (const t of targets) {
          const a = headOf(from);
          const b = headOf(t);
          for (let k = 0; k < 6; k += 1) setTimeout(() => projectile(a, b.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)), color, false, () => burst(b, color, 10, 1.6)), k * 60);
        }
      }
      setTimeout(() => {
        for (const t of targets) {
          flashHit(t, false);
          floatText(t, '🔥', 'dmg');
        }
        state.shake = 0.3;
      }, 500);
    } else if (e.kind === 'heal' && to) {
      const color = 0x9dffb0;
      const rise = () => {
        const at = to.root.position.clone();
        for (let k = 0; k < 5; k += 1) setTimeout(() => burst(at.clone().add(new THREE.Vector3(0, 0.3 + k * 0.2, 0)), k % 2 ? 0xffe27a : color, 12, 1.0, 0.8), k * 90);
        floatText(to, `+${e.amount}`, 'heal');
      };
      if (from && from !== to) projectile(headOf(from), headOf(to), color, false, rise);
      else rise();
    }
  }

  // ---- interaction ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...state.tokens.values()].map((e) => e.hit), false);
    return hits.length ? hits[0].object.userData.tokenId : null;
  }

  function groundCell(ev, size) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, p)) return null;
    const x = Math.round(p.x + state.cols / 2 - size / 2);
    const y = Math.round(p.z + state.rows / 2 - size / 2);
    return { x: Math.max(0, Math.min(state.cols - size, x)), y: Math.max(0, Math.min(state.rows - size, y)), point: p };
  }

  const ghost = ring(0xffffff, 0.45, 0.08);
  ghost.visible = false;
  scene.add(ghost);

  function onDown(ev) {
    if (ev.button !== 0) return;
    const id = pick(ev);
    if (!id) {
      state.press = { x: ev.clientX, y: ev.clientY, empty: true };
      return;
    }
    // Take the event away from the camera controls.
    ev.stopPropagation();
    ev.preventDefault();
    const entry = state.tokens.get(id);
    if (state.targeting) {
      hooks.onTarget(id);
      return;
    }
    const movable = entry && entry.token && hooks.canMove(entry.token) && !entry.token.dead;
    state.drag = { id, x: ev.clientX, y: ev.clientY, moved: false, movable, pointerId: ev.pointerId };
    if (movable) renderer.domElement.setPointerCapture?.(ev.pointerId);
  }

  function onMove(ev) {
    const d = state.drag;
    if (d) {
      if (!d.movable) return;
      if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 6) return;
      d.moved = true;
      const entry = state.tokens.get(d.id);
      const cell = groundCell(ev, entry.token.size);
      if (!cell) return;
      d.cell = cell;
      const w = toWorld(cell.x, cell.y, entry.token.size);
      entry.root.position.set(cell.point.x, 0.35, cell.point.z);
      ghost.visible = true;
      ghost.scale.setScalar(entry.token.size);
      ghost.position.set(w.x, 0.04, w.z);
      return;
    }
    // hover highlight
    const id = pick(ev);
    if (id !== state.hovered) {
      if (state.hovered && state.tokens.get(state.hovered)) state.tokens.get(state.hovered).hoverRing.visible = false;
      state.hovered = id;
      const e = id && state.tokens.get(id);
      for (const other of state.tokens.values()) other.label.el.classList.toggle('hover', other.id === id);
      if (e) {
        e.hoverRing.visible = true;
        e.hoverRing.material.color.setHex(state.targeting ? 0xff4a5a : 0xffffff);
      }
      renderer.domElement.style.cursor = id ? (state.targeting ? 'crosshair' : 'pointer') : '';
    }
  }

  function onUp(ev) {
    const d = state.drag;
    if (d) {
      state.drag = null;
      ghost.visible = false;
      renderer.domElement.releasePointerCapture?.(d.pointerId);
      const entry = state.tokens.get(d.id);
      if (!d.moved) {
        hooks.onSelect(d.id);
        return;
      }
      if (entry && d.cell && (d.cell.x !== entry.token.x || d.cell.y !== entry.token.y)) {
        hooks.onMove(d.id, d.cell.x, d.cell.y).then((ok) => {
          if (!ok && entry) {
            entry.from = entry.root.position.clone();
            entry.to = entry.pos.clone();
            entry.t = 0;
            entry.dur = 0.3;
          }
        });
      } else if (entry) {
        entry.root.position.copy(entry.pos);
      }
      return;
    }
    const p = state.press;
    state.press = null;
    if (p && p.empty && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 5 && !state.targeting) hooks.onSelect(null);
  }

  // capture phase on the container so token drags never reach OrbitControls
  container.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  function setTargeting(on) {
    state.targeting = Boolean(on);
    for (const e of state.tokens.values()) {
      e.hoverRing.visible = false;
    }
    state.hovered = null;
    renderer.domElement.style.cursor = on ? 'crosshair' : '';
  }

  // ---- animation loop ----
  const tmp = new THREE.Vector3();
  function animate() {
    if (state.disposed) return;
    requestAnimationFrame(animate);
    if (document.hidden) return;
    const realDt = Math.min(0.5, state.clock.getDelta());
    const dt = Math.min(0.05, realDt);
    const time = state.clock.elapsedTime;

    if (state.zoomTo) {
      const v = camera.position.clone().sub(controls.target);
      const len = v.length();
      const next = len + (state.zoomTo - len) * Math.min(1, realDt * 3);
      camera.position.copy(controls.target).add(v.setLength(next));
      if (Math.abs(next - state.zoomTo) < 0.1) state.zoomTo = null;
    }
    if (state.focusTarget) {
      const delta = state.focusTarget.clone().sub(controls.target);
      if (delta.length() < 0.05) state.focusTarget = null;
      else {
        const step = delta.multiplyScalar(Math.min(1, realDt * 3.5));
        controls.target.add(step);
        camera.position.add(step);
      }
    }
    controls.update();

    for (const e of state.tokens.values()) {
      const root = e.root;
      if (state.drag && state.drag.id === e.id && state.drag.moved) {
        root.rotation.y = e.facing;
        continue;
      }
      if (e.to) {
        e.t += dt / e.dur;
        const k = Math.min(1, e.t);
        const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        tmp.copy(e.from).lerp(e.to, ease);
        tmp.y = Math.abs(Math.sin(k * Math.PI * Math.max(1, Math.round(e.dur * 4)))) * 0.18;
        root.position.copy(tmp);
        if (k >= 1) {
          root.position.copy(e.to);
          e.to = null;
        }
      }
      if (e.lunge) {
        e.lunge.t += dt / e.lunge.dur;
        const k = Math.min(1, e.lunge.t);
        const off = Math.sin(k * Math.PI);
        e.model.position.set(e.lunge.dir.x * off / e.model.scale.x, 0, e.lunge.dir.z * off / e.model.scale.x);
        if (k >= 1) {
          e.lunge = null;
          e.model.position.set(0, 0, 0);
        }
      }
      if (e.mixer) {
        const moving = Boolean(e.to);
        if (e.clips.walk && moving !== e.walking) {
          e.walking = moving;
          const [from, to] = moving ? [e.clips.idle, e.clips.walk] : [e.clips.walk, e.clips.idle];
          to.reset().play();
          from.crossFadeTo(to, 0.2, false);
        }
        e.mixer.update(dt);
      }
      e.model.traverse((o) => {
        if (o.userData.hover) o.position.y = o.userData.hover + Math.sin(time * 1.6 + e.seed) * 0.08;
      });
      // facing
      const diff = ((e.facing - root.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      root.rotation.y += diff * Math.min(1, dt * 8);
      // breathing / idle
      const alive = e.tiltTarget === 0;
      if (!e.mixer) e.model.scale.y = e.model.scale.x * (1 + (alive ? Math.sin(time * 2.2 + e.seed) * 0.02 : 0));
      // down / dead topple
      e.tilt += (e.tiltTarget - e.tilt) * Math.min(1, dt * 5);
      e.pivot.rotation.z = -e.tilt * Math.PI / 2 * 0.95;
      e.pivot.position.y = -e.tilt * 0.08;
      e.pivot.position.x = e.tilt * e.height * 0.3;
      // hit flash
      if (e.flash > 0) {
        e.flash = Math.max(0, e.flash - dt * 3);
        const s = 1 + Math.sin(e.flash * 30) * 0.05 * e.flash;
        e.pivot.scale.set(s, s, s);
        e.model.traverse((o) => {
          if (o.isMesh && !o.userData.outline && o.material.emissive) {
            if (!o.userData.baseEmissive) {
              o.userData.baseEmissive = o.material.emissive.clone();
              o.userData.baseIntensity = o.material.emissiveIntensity;
              o.material = o.material.clone();
            }
            o.material.emissive.copy(o.userData.baseEmissive).lerp(new THREE.Color(0xff3a4a), Math.min(1, e.flash));
            o.material.emissiveIntensity = o.userData.baseIntensity + e.flash * 1.5;
          }
        });
      }
      // wobble (oozes, elementals)
      e.model.traverse((o) => {
        if (o.userData.wobble) {
          o.scale.x = o.scale.z = (o.userData.sx || (o.userData.sx = o.scale.x)) * (1 + Math.sin(time * 3 + e.seed) * 0.06);
        }
      });
      // rings
      if (e.turnRing.visible) e.turnRing.rotation.y += dt * 1.5;
      if (e.selRing.visible) e.selRing.material.opacity = 0.6 + Math.sin(time * 5) * 0.3;
      // hidden tokens fade
      const op = e.opacityTarget ?? 1;
      if (Math.abs((e.opacity ?? 1) - op) > 0.01) {
        e.opacity = op;
        e.model.traverse((o) => {
          if (o.isMesh && !o.userData.outline) {
            if (!o.userData.ownMat) {
              o.material = o.material.clone();
              o.userData.ownMat = true;
            }
            o.material.transparent = op < 1;
            o.material.opacity = op;
          }
        });
      }
    }

    // accents flicker, motes drift, water flows
    world.traverse((o) => {
      if (o.userData.flicker) o.scale.y = (o.userData.sy || (o.userData.sy = o.scale.y)) * (0.85 + Math.sin(time * 13 + o.id) * 0.1 + Math.random() * 0.08);
      if (o.userData.float) o.position.y = 0.6 + Math.sin(time * 1.5 + o.id) * 0.25;
      if (o.userData.light) o.userData.light.intensity = (o.userData.base || (o.userData.base = o.userData.light.intensity)) * (0.85 + Math.sin(time * 9 + o.id) * 0.08 + Math.random() * 0.07);
    });
    if (state.motes) {
      const arr = state.motes.geometry.attributes.position.array;
      const seeds = state.motes.geometry.attributes.seed.array;
      for (let i = 0; i < seeds.length; i += 1) {
        arr[i * 3 + 1] += dt * (0.12 + (seeds[i] % 1) * 0.15);
        arr[i * 3] += Math.sin(time + seeds[i]) * dt * 0.08;
        if (arr[i * 3 + 1] > 4) arr[i * 3 + 1] = 0;
      }
      state.motes.geometry.attributes.position.needsUpdate = true;
    }
    if (state.water) state.water.uniforms.time.value = time;
    for (const prop of propsGroup.children) {
      if (prop.userData.bob) {
        prop.position.y = -0.05 + Math.sin(time * 0.9) * 0.05;
        prop.rotation.z = Math.sin(time * 0.7) * 0.03;
      }
      if (prop.userData.mixer) prop.userData.mixer.update(dt);
    }

    // effects
    state.effects = state.effects.filter((f) => f(dt));

    // camera shake
    let shakeOffset = null;
    if (state.shake > 0) {
      state.shake = Math.max(0, state.shake - dt);
      shakeOffset = new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(state.shake * 0.5);
      camera.position.add(shakeOffset);
    }
    grade.uniforms.time.value = time;
    composer.render(dt);
    labels.render(scene, camera);
    if (shakeOffset) camera.position.sub(shakeOffset);
  }

  setQuality('high');
  loadLibrary();
  loadEnvKit();
  animate();

  function dispose() {
    state.disposed = true;
    ro.disconnect();
    container.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    labels.domElement.remove();
  }

  function zoom(dir) {
    const v = camera.position.clone().sub(controls.target);
    const len = Math.max(controls.minDistance, Math.min(controls.maxDistance, v.length() * (dir > 0 ? 0.8 : 1.25)));
    camera.position.copy(controls.target).add(v.setLength(len));
  }

  function screenPosition(id) {
    const e = state.tokens.get(id);
    if (!e) return null;
    const p = e.root.position.clone().add(new THREE.Vector3(0, e.height * 0.45, 0)).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  return { update, fx, focus, setTargeting, setQuality, resize, dispose, zoom, frame: frameBoard, screenPosition };
}
