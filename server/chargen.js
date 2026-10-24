'use strict';

// Builds playable 5e characters from SRD races/classes: ability scores,
// HP, AC, structured attacks and a starting kit.

const lib = require('./library');

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

// Ability priority used to place the standard array / rolled scores.
const PRIORITY = {
  barbarian: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  bard: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
  cleric: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
  druid: ['wis', 'con', 'dex', 'int', 'cha', 'str'],
  fighter: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
  monk: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  paladin: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
  ranger: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
  rogue: ['dex', 'con', 'int', 'wis', 'cha', 'str'],
  sorcerer: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  warlock: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
  wizard: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
};

// Starting kits (SRD item ids). `unarmored` = class AC formula without armor.
const KITS = {
  barbarian: { weapons: ['greataxe', 'handaxe'], armor: null, unarmored: 'con', gear: ['explorers-pack'] },
  bard: { weapons: ['rapier', 'dagger'], armor: 'leather-armor', gear: ['entertainers-pack'], cantrip: 'vicious-mockery' },
  cleric: { weapons: ['mace'], armor: 'scale-mail', shield: true, gear: ['priests-pack'], cantrip: 'sacred-flame' },
  druid: { weapons: ['scimitar'], armor: 'leather-armor', shield: true, gear: ['herbalism-kit', 'explorers-pack'], cantrip: 'produce-flame' },
  fighter: { weapons: ['longsword', 'crossbow-light'], armor: 'chain-mail', shield: true, gear: ['dungeoneers-pack'] },
  monk: { weapons: ['shortsword'], armor: null, unarmored: 'wis', unarmed: true, gear: ['explorers-pack'] },
  paladin: { weapons: ['longsword', 'javelin'], armor: 'chain-mail', shield: true, gear: ['priests-pack'] },
  ranger: { weapons: ['longbow', 'shortsword'], armor: 'scale-mail', gear: ['explorers-pack'] },
  rogue: { weapons: ['rapier', 'shortbow', 'dagger'], armor: 'leather-armor', gear: ['burglars-pack', 'thieves-tools'] },
  sorcerer: { weapons: ['dagger', 'crossbow-light'], armor: null, gear: ['component-pouch', 'explorers-pack'], cantrip: 'fire-bolt' },
  warlock: { weapons: ['dagger', 'crossbow-light'], armor: 'leather-armor', gear: ['component-pouch', 'scholars-pack'], cantrip: 'eldritch-blast' },
  wizard: { weapons: ['quarterstaff', 'dagger'], armor: null, gear: ['spellbook', 'component-pouch', 'scholars-pack'], cantrip: 'fire-bolt' },
};

// Damage cantrips (die per tier, ability, attack roll or save).
const CANTRIPS = {
  'fire-bolt': { die: 'd10', type: 'Fire', ranged: true, range: 120 },
  'eldritch-blast': { die: 'd10', type: 'Force', ranged: true, range: 120 },
  'sacred-flame': { die: 'd8', type: 'Radiant', save: 'dex', range: 60 },
  'produce-flame': { die: 'd8', type: 'Fire', ranged: true, range: 30 },
  'vicious-mockery': { die: 'd4', type: 'Psychic', save: 'wis', range: 60 },
  'ray-of-frost': { die: 'd8', type: 'Cold', ranged: true, range: 60 },
};

// Simplified class features usable in combat. `uses` scale with level and
// refresh on rest; `bonus` features don't use up the turn's action.
function classFeatures(clsId, abilities, level) {
  const m = (a) => mod(abilities[a]);
  switch (clsId) {
    case 'cleric':
      return [{ id: 'cure-wounds', name: 'Лекуващи рани', kind: 'heal', dice: `1d8${signed(m('wis'))}`, range: 5, uses: level + 1, maxUses: level + 1 }];
    case 'druid':
      return [{ id: 'healing-word', name: 'Лечебна дума', kind: 'heal', dice: `1d4${signed(m('wis'))}`, range: 60, bonus: true, uses: level + 1, maxUses: level + 1 }];
    case 'bard':
      return [{ id: 'healing-word', name: 'Лечебна дума', kind: 'heal', dice: `1d4${signed(m('cha'))}`, range: 60, bonus: true, uses: level + 1, maxUses: level + 1 }];
    case 'paladin':
      return [{ id: 'lay-on-hands', name: 'Полагане на ръце', kind: 'heal', dice: '5', range: 5, uses: level, maxUses: level }];
    case 'fighter':
      return [{ id: 'second-wind', name: 'Второ дихание', kind: 'heal', self: true, dice: `1d10+${level}`, bonus: true, uses: 1, maxUses: 1 }];
    default:
      return [];
  }
}

const NAMES = {
  first: ['Аран', 'Бранимир', 'Велин', 'Гордан', 'Драгомир', 'Елара', 'Жива', 'Зорана', 'Ивайло', 'Калина',
    'Лиора', 'Мирела', 'Нара', 'Огнян', 'Радослава', 'Светлин', 'Тихомир', 'Умбра', 'Фаелин', 'Хелга',
    'Цветан', 'Ясен', 'Торин', 'Силвана', 'Бренна', 'Каел', 'Мира', 'Роан', 'Изолда', 'Вук'],
  epithet: ['Смелия', 'Сивия', 'Бързоногия', 'Тихата', 'Сребърната ръка', 'от Северните хълмове', 'Огнекосата',
    'Скитника', 'Каменното сърце', 'Звездоглед', 'Белия вълк', 'Ловеца на сенки', 'от Дъбравата', 'Песнопоеца'],
};

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];

const mod = (score) => Math.floor((score - 10) / 2);
const proficiencyFor = (level) => 2 + Math.floor((Math.max(1, level) - 1) / 4);
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

function pick(list, rng = Math.random) {
  return list[Math.floor(rng() * list.length)];
}

function roll4d6(rng = Math.random) {
  const d = [0, 0, 0, 0].map(() => 1 + Math.floor(rng() * 6)).sort((a, b) => a - b);
  return d[1] + d[2] + d[3];
}

function randomName(rng = Math.random) {
  return `${pick(NAMES.first, rng)} ${pick(NAMES.epithet, rng)}`;
}

// Places a list of scores (highest first) by class priority.
function assignScores(clsId, scores) {
  const sorted = [...scores].sort((a, b) => b - a);
  const order = PRIORITY[clsId] || ABILITIES;
  const out = {};
  order.forEach((a, i) => { out[a] = sorted[i]; });
  return out;
}

function weaponAttack(item, abilities, prof) {
  const finesse = (item.properties || []).includes('finesse');
  const thrown = (item.properties || []).includes('thrown');
  let ability = item.ranged ? 'dex' : 'str';
  if (finesse && abilities.dex > abilities.str) ability = 'dex';
  const m = mod(abilities[ability]);
  return {
    name: item.name,
    attackBonus: prof + m,
    damage: `${item.damage}${m ? signed(m) : ''}`,
    damageType: item.damageType,
    ranged: Boolean(item.ranged),
    range: item.ranged ? item.range : thrown ? 20 : 5,
  };
}

function cantripAttack(id, abilityScore, prof, level) {
  const c = CANTRIPS[id];
  const spell = lib.spell(id);
  if (!c || !spell) return null;
  const dice = level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1;
  const m = mod(abilityScore);
  const out = {
    name: `${spell.name} (заклинание)`,
    damage: `${dice}${c.die}`,
    damageType: c.type,
    ranged: true,
    range: c.range,
    spell: true,
  };
  if (c.save) {
    out.save = c.save;
    out.dc = 8 + prof + m;
  } else {
    out.attackBonus = prof + m;
  }
  return out;
}

function armorClass(kit, abilities) {
  const dex = mod(abilities.dex);
  let ac = 10 + dex;
  if (kit.armor) {
    const a = lib.item(kit.armor);
    if (a) {
      const dexPart = a.dexBonus ? (a.maxDex === null || a.maxDex === undefined ? dex : Math.min(dex, a.maxDex)) : 0;
      ac = a.armorClass + dexPart;
    }
  } else if (kit.unarmored) {
    ac = 10 + dex + mod(abilities[kit.unarmored]);
  }
  if (kit.shield) ac += 2;
  return ac;
}

function itemRef(id) {
  const it = lib.item(id);
  return it ? { id: it.id, name: it.name, icon: it.icon, image: it.image } : null;
}

// options: { name, race, subrace, cls, level, abilities (base, before racial
// bonuses), method: 'standard' | 'roll' }. Missing values are randomised.
function build(options = {}, rng = Math.random) {
  const race = lib.race(options.race) || pick(lib.races, rng);
  const cls = lib.cls(options.cls) || pick(lib.classes, rng);
  const level = Math.min(20, Math.max(1, Number.parseInt(options.level, 10) || 1));
  const subrace = race.subraces.find((s) => s.id === options.subrace) || race.subraces[0] || null;

  let base;
  if (options.abilities && ABILITIES.every((a) => Number.isFinite(Number(options.abilities[a])))) {
    base = Object.fromEntries(ABILITIES.map((a) => [a, Math.min(20, Math.max(3, Number(options.abilities[a])))]));
  } else if (options.method === 'roll') {
    base = assignScores(cls.id, ABILITIES.map(() => roll4d6(rng)));
  } else {
    base = assignScores(cls.id, STANDARD_ARRAY);
  }
  const abilities = { ...base };
  for (const [a, b] of Object.entries(race.bonuses || {})) abilities[a] = Math.min(20, abilities[a] + b);
  if (subrace) for (const [a, b] of Object.entries(subrace.bonuses || {})) abilities[a] = Math.min(20, abilities[a] + b);
  // Half-elves get +1 to two other abilities; give them to the class's top picks.
  if (race.id === 'half-elf') {
    const extra = (PRIORITY[cls.id] || ABILITIES).filter((a) => a !== 'cha').slice(0, 2);
    for (const a of extra) abilities[a] = Math.min(20, abilities[a] + 1);
  }

  const prof = proficiencyFor(level);
  const conMod = mod(abilities.con);
  const maxHp = Math.max(1, cls.hitDie + conMod + (level - 1) * (Math.floor(cls.hitDie / 2) + 1 + conMod));
  const kit = KITS[cls.id] || KITS.fighter;

  const weapons = kit.weapons.map((id) => lib.item(id)).filter(Boolean).map((it) => weaponAttack(it, abilities, prof));
  if (kit.unarmed) {
    const m = Math.max(mod(abilities.str), mod(abilities.dex));
    weapons.push({ name: 'Удар без оръжие', attackBonus: prof + m, damage: `1d4${signed(m)}`, damageType: 'Bludgeoning', ranged: false, range: 5 });
  }
  if (kit.cantrip) {
    const castAbility = cls.spellcasting || 'int';
    const c = cantripAttack(kit.cantrip, abilities[castAbility], prof, level);
    if (c) weapons.unshift(c);
  }

  const items = [...kit.weapons, kit.armor, kit.shield ? 'shield' : null, ...kit.gear, 'magic-potion-of-healing']
    .filter(Boolean).map(itemRef).filter(Boolean);

  const saves = Object.fromEntries(ABILITIES.map((a) => [a, cls.saves.includes(a)]));
  const raceName = subrace ? `${race.nameBg} (${subrace.name})` : race.nameBg;

  return {
    name: String(options.name || '').trim().slice(0, 60) || randomName(rng),
    race: raceName,
    raceId: race.id,
    cls: cls.nameBg,
    clsId: cls.id,
    level,
    hp: maxHp,
    maxHp,
    tempHp: 0,
    ac: armorClass(kit, abilities),
    speed: race.speed || 30,
    proficiency: prof,
    abilities,
    saves,
    weapons,
    features: classFeatures(cls.id, abilities, level),
    items,
    attacks: weapons.map((w) => `${w.name}: ${w.save ? `спас. ${w.save.toUpperCase()} DC ${w.dc}` : signed(w.attackBonus)}, ${w.damage} ${w.damageType}`).join('\n'),
    inventory: items.map((i) => i.name).join(', '),
    notes: `Черти: ${(race.traits || []).join(', ') || '—'}`,
    icon: cls.id,
    color: pick(COLORS, rng),
  };
}

module.exports = { build, classFeatures, randomName, mod, proficiencyFor, STANDARD_ARRAY, KITS, CANTRIPS, weaponAttack };
