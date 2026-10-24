'use strict';

// Downloads the D&D 5e SRD (OGL 1.0a / CC-BY-4.0 content, via the
// 5e-bits/5e-database project) and game-icons.net icons (CC BY 3.0), and
// writes compact copies into server/srd/ and public/icons/.
//
//   node scripts/build-srd.js

const fs = require('fs');
const path = require('path');

const DB = 'https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en/5e-SRD-';
const ICONS = 'https://raw.githubusercontent.com/game-icons/icons/master/';
const IMAGE_HOST = 'https://www.dnd5eapi.co';
const OUT = path.join(__dirname, '..', 'server', 'srd');
const ICON_OUT = path.join(__dirname, '..', 'public', 'icons');

// icon name -> game-icons path
const ICON_SOURCES = {
  aberration: 'lorc/tentacle-strike',
  beast: 'lorc/wolf-head',
  celestial: 'lorc/angel-wings',
  construct: 'lorc/stone-crafting',
  dragon: 'lorc/dragon-head',
  elemental: 'lorc/fire-ring',
  fey: 'lorc/fairy',
  fiend: 'lorc/imp',
  giant: 'delapouite/giant',
  humanoid: 'lorc/hood',
  monstrosity: 'lorc/beast-eye',
  ooze: 'lorc/dripping-goo',
  plant: 'lorc/vine-whip',
  undead: 'lorc/skull-crossed-bones',
  swarm: 'lorc/evil-minion',
  goblin: 'delapouite/goblin-head',
  orc: 'delapouite/orc-head',
  ghost: 'lorc/ghost',
  barbarian: 'lorc/battle-axe',
  bard: 'lorc/lyre',
  cleric: 'lorc/holy-symbol',
  druid: 'lorc/oak',
  fighter: 'lorc/crossed-swords',
  monk: 'lorc/fist',
  paladin: 'lorc/rune-sword',
  ranger: 'lorc/bowman',
  rogue: 'lorc/cloak-dagger',
  sorcerer: 'lorc/magic-swirl',
  warlock: 'lorc/crowned-skull',
  wizard: 'lorc/pointy-hat',
  weapon: 'lorc/broadsword',
  armor: 'lorc/breastplate',
  potion: 'lorc/potion-ball',
  scroll: 'lorc/scroll-unfurled',
  wand: 'lorc/crystal-wand',
  ring: 'lorc/emerald',
  wondrous: 'lorc/swap-bag',
  gear: 'lorc/swap-bag',
  book: 'lorc/book-cover',
  treasure: 'lorc/gem-pendant',
};

async function getJson(name) {
  const res = await fetch(`${DB}${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

const ABIL = { STR: 'str', DEX: 'dex', CON: 'con', INT: 'int', WIS: 'wis', CHA: 'cha' };

function feet(value) {
  const m = /(\d+)/.exec(String(value || ''));
  return m ? Number(m[1]) : 0;
}

function shorten(text, max = 600) {
  const s = Array.isArray(text) ? text.join('\n') : String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function monsterIcon(m) {
  const n = m.index;
  if (n.includes('goblin') || n.includes('hobgoblin') || n.includes('bugbear')) return 'goblin';
  if (n.includes('orc')) return 'orc';
  if (n.includes('spider')) return 'beast';
  if (n.includes('ghost') || n.includes('specter') || n.includes('wraith') || n.includes('banshee')) return 'ghost';
  if (m.type.startsWith('swarm')) return 'swarm';
  const t = m.type.split(' ')[0];
  return ICON_SOURCES[t] ? t : 'monstrosity';
}

function compactAction(a) {
  const out = { name: a.name, desc: shorten(a.desc, 400) };
  if (typeof a.attack_bonus === 'number') out.attackBonus = a.attack_bonus;
  const dmg = (a.damage || []).filter((d) => d.damage_dice);
  if (dmg.length) {
    out.damage = dmg.map((d) => d.damage_dice).join('+');
    out.damageType = dmg[0].damage_type ? dmg[0].damage_type.name : '';
  }
  if (out.attackBonus !== undefined) {
    const reach = /reach (\d+) ft/.exec(a.desc || '');
    const range = /range (\d+)(?:\/(\d+))? ft/.exec(a.desc || '');
    out.reach = reach ? Number(reach[1]) : 5;
    if (range) out.range = Number(range[1]);
    out.ranged = /Ranged/.test(a.desc || '') && !/Melee or Ranged/.test(a.desc || '');
  }
  if (a.dc) {
    out.dc = a.dc.dc_value;
    out.save = a.dc.dc_type ? ABIL[a.dc.dc_type.name] : undefined;
  }
  if (a.name === 'Multiattack' && Array.isArray(a.actions)) {
    out.multi = a.actions
      .filter((x) => x.type !== 'ability')
      .map((x) => ({ name: x.action_name, count: Number(x.count) || 1 }));
  }
  return out;
}

function buildMonsters(raw) {
  return raw.map((m) => ({
    id: m.index,
    name: m.name,
    size: m.size,
    type: m.type,
    alignment: m.alignment,
    ac: (m.armor_class && m.armor_class[0] && m.armor_class[0].value) || 10,
    hp: m.hit_points,
    hitDice: m.hit_points_roll || m.hit_dice,
    speed: feet(m.speed && m.speed.walk) || feet(m.speed && (m.speed.fly || m.speed.swim)) || 30,
    speedText: Object.entries(m.speed || {}).map(([k, v]) => `${k} ${v}`).join(', '),
    abilities: {
      str: m.strength, dex: m.dexterity, con: m.constitution,
      int: m.intelligence, wis: m.wisdom, cha: m.charisma,
    },
    cr: m.challenge_rating,
    xp: m.xp,
    senses: Object.entries(m.senses || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', '),
    languages: m.languages,
    immunities: m.damage_immunities,
    resistances: m.damage_resistances,
    special: (m.special_abilities || []).map((s) => ({ name: s.name, desc: shorten(s.desc, 400) })),
    actions: (m.actions || []).map(compactAction),
    legendary: (m.legendary_actions || []).map((s) => ({ name: s.name, desc: shorten(s.desc, 300) })),
    image: m.image ? `${IMAGE_HOST}${m.image}` : null,
    icon: monsterIcon(m),
  }));
}

function itemIcon(cat, name) {
  const n = name.toLowerCase();
  if (cat === 'potion' || n.startsWith('potion')) return 'potion';
  if (cat === 'scroll' || n.includes('scroll')) return 'scroll';
  if (cat === 'wand' || cat === 'rod' || cat === 'staff' || n.includes('wand') || n.includes('staff') || n.includes('rod')) return 'wand';
  if (cat === 'ring' || n.startsWith('ring')) return 'ring';
  if (cat === 'weapon' || cat === 'ammunition') return 'weapon';
  if (cat === 'armor') return 'armor';
  if (cat === 'wondrous-items') return 'wondrous';
  return 'gear';
}

function buildItems(equipment, magic) {
  const items = equipment.map((e) => {
    const cat = e.equipment_category.index;
    const out = {
      id: e.index,
      name: e.name,
      category: cat,
      kind: e.weapon_category || e.armor_category || (e.gear_category && e.gear_category.name) || e.equipment_category.name,
      cost: e.cost ? `${e.cost.quantity} ${e.cost.unit}` : '',
      weight: e.weight || 0,
      rarity: 'Common',
      desc: shorten(e.desc, 400),
      icon: itemIcon(cat, e.name),
      image: null,
    };
    if (e.damage) {
      out.damage = e.damage.damage_dice;
      out.damageType = e.damage.damage_type ? e.damage.damage_type.name : '';
      out.ranged = e.weapon_range === 'Ranged';
      out.range = e.range ? e.range.normal : 5;
      out.properties = (e.properties || []).map((p) => p.index);
    }
    if (e.armor_class) {
      out.armorClass = e.armor_class.base;
      out.dexBonus = Boolean(e.armor_class.dex_bonus);
      out.maxDex = e.armor_class.max_bonus ?? null;
    }
    return out;
  });
  for (const m of magic) {
    if (m.variant) continue; // keep the parent entry of variant families
    const cat = m.equipment_category.index;
    items.push({
      id: `magic-${m.index}`,
      name: m.name,
      category: 'magic',
      kind: m.equipment_category.name,
      cost: '',
      weight: 0,
      rarity: (m.rarity && m.rarity.name) || 'Varies',
      desc: shorten(m.desc, 700),
      icon: itemIcon(cat, m.name),
      image: m.image ? `${IMAGE_HOST}${m.image}` : null,
    });
  }
  return items;
}

function buildRaces(races, subraces) {
  return races.map((r) => ({
    id: r.index,
    name: r.name,
    speed: r.speed,
    size: r.size,
    bonuses: Object.fromEntries((r.ability_bonuses || []).map((b) => [b.ability_score.index, b.bonus])),
    traits: (r.traits || []).map((t) => t.name),
    languages: (r.languages || []).map((l) => l.name),
    subraces: subraces.filter((s) => s.race.index === r.index).map((s) => ({
      id: s.index,
      name: s.name,
      bonuses: Object.fromEntries((s.ability_bonuses || []).map((b) => [b.ability_score.index, b.bonus])),
    })),
  }));
}

function buildClasses(classes) {
  return classes.map((c) => ({
    id: c.index,
    name: c.name,
    hitDie: c.hit_die,
    saves: (c.saving_throws || []).map((s) => s.index),
    proficiencies: (c.proficiencies || []).map((p) => p.name),
    spellcasting: c.spellcasting ? c.spellcasting.spellcasting_ability.index : null,
    icon: c.index,
  }));
}

function buildSpells(spells) {
  return spells.map((s) => ({
    id: s.index,
    name: s.name,
    level: s.level,
    school: s.school && s.school.name,
    castingTime: s.casting_time,
    range: s.range,
    duration: s.duration,
    concentration: s.concentration,
    classes: (s.classes || []).map((c) => c.index),
    damage: s.damage && s.damage.damage_at_slot_level
      ? Object.values(s.damage.damage_at_slot_level)[0]
      : s.damage && s.damage.damage_at_character_level
        ? Object.values(s.damage.damage_at_character_level)[0]
        : null,
    damageType: s.damage && s.damage.damage_type ? s.damage.damage_type.name : null,
    save: s.dc ? s.dc.dc_type.index : null,
    attack: s.attack_type || null,
    desc: shorten(s.desc, 700),
  }));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(ICON_OUT, { recursive: true });
  const [monsters, equipment, magic, races, subraces, classes, spells] = await Promise.all(
    ['Monsters', 'Equipment', 'Magic-Items', 'Races', 'Subraces', 'Classes', 'Spells'].map(getJson),
  );
  const write = (name, data) => {
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data));
    console.log(`${name}: ${data.length}`);
  };
  write('monsters', buildMonsters(monsters));
  write('items', buildItems(equipment, magic));
  write('races', buildRaces(races, subraces));
  write('classes', buildClasses(classes));
  write('spells', buildSpells(spells));

  for (const [name, src] of Object.entries(ICON_SOURCES)) {
    const res = await fetch(`${ICONS}${src}.svg`);
    if (!res.ok) {
      console.warn(`icon ${name} (${src}): HTTP ${res.status}`);
      continue;
    }
    fs.writeFileSync(path.join(ICON_OUT, `${name}.svg`), await res.text());
  }
  console.log(`icons: ${fs.readdirSync(ICON_OUT).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
