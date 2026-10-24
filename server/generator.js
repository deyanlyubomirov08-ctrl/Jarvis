'use strict';

// Random adventure generator: story, theme, encounters balanced by XP
// budget for the party, and loot.

const lib = require('./library');
const { mulberry32 } = require('./mapgen');

// Medium-difficulty XP per character by level (DMG).
const XP_MEDIUM = [0, 50, 100, 150, 250, 500, 600, 750, 900, 1100, 1200, 1600, 2000, 2200, 2500, 2800, 3200, 3900, 4200, 4900, 5700];

const THEME_TYPES = {
  dungeon: ['humanoid', 'construct', 'monstrosity', 'ooze', 'undead'],
  crypt: ['undead'],
  cave: ['beast', 'monstrosity', 'ooze', 'aberration', 'humanoid', 'elemental'],
  forest: ['beast', 'fey', 'plant', 'humanoid', 'monstrosity'],
  swamp: ['beast', 'plant', 'humanoid', 'fey', 'undead'],
};

const PLACES = {
  dungeon: ['Подземията на Черния замък', 'Тъмницата под Сивата кула', 'Залите на Забравения орден', 'Лабиринтът на Магьосника'],
  crypt: ['Гробницата на Сребърната дама', 'Костницата при Стария манастир', 'Криптата на Седемте крале', 'Катакомбите на Мъртвия град'],
  cave: ['Пещерите на Шепнещия камък', 'Кристалните пещери', 'Бърлогата под Вълчия връх', 'Подземната река Мрака'],
  forest: ['Сенчестата гора', 'Дъбравата на Друидите', 'Гората на Обесения', 'Зелената пустош'],
  swamp: ['Гнилото блато', 'Тресавището на Мъглите', 'Черните мочурища', 'Блатото на Удавниците'],
};

const HOOKS = [
  'Старейшината на {village} ви моли за помощ: {victim} изчезна преди три нощи.',
  'Странник умира в ръцете ви и прошепва: „{place}… спрете ги…“',
  'Обява в кръчмата обещава {gold} жълтици за всеки, който прочисти {place}.',
  'Пророчески сън показва на всички ви едно и също място — {place}.',
  'Керван с лекарства за {village} е изчезнал близо до {place}.',
  'Магьосница ви наема да намерите древен артефакт, скрит в {place}.',
];
const VILLAGES = ['Бреза', 'Тихо поле', 'Каменец', 'Върбица', 'Мочурище', 'Звездец', 'Сиви бор'];
const VICTIMS = ['дъщерята на ковача', 'местният жрец', 'малкият овчар', 'бирникът на графа', 'старата билкарка', 'двама ловци'];
const GOALS = [
  'Злодеят иска да призове древна сила при следващото пълнолуние.',
  'Злодеят събира пленници, за да ги принесе в жертва.',
  'Злодеят търси изгубената корона, която дава власт над мъртвите.',
  'Злодеят трови изворите на долината.',
  'Злодеят иска да отмъсти на селяните за стара обида.',
];
const TWISTS = [
  'Изчезналият всъщност е избягал доброволно — и има своите причини.',
  'Злодеят е бивш герой, предаден от същото село.',
  'Някой от селото работи тайно за злодея.',
  'Под мястото дреме нещо много по-древно и по-опасно.',
  'Злодеят е само пешка — истинският господар наблюдава отдалеч.',
];
const ENCOUNTER_TITLES = ['Пазачите на входа', 'Засада в тъмното', 'Залата на сенките', 'Мостът над бездната', 'Гнездото', 'Ритуалната зала', 'Стражите на съкровището'];
const ENCOUNTER_TEXTS = [
  'Пред вас се раздвижват сенки — {monsters} ви забелязват и нападат!',
  'Тишината се разкъсва от рев. {monsters} изскачат от прикритието си!',
  'Миризма на кръв и пепел… {monsters} пазят прохода и няма да ви пуснат без бой.',
  'В центъра на залата {monsters} се обръщат към вас с жажда за битка.',
];

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

const HARMLESS = /horse|mule|pony|camel|elephant|mammoth|goat|deer|elk|cat$|owl$|hawk|eagle|raven|vulture|bat$|sea|octopus|shark|whale|crab|quipper|reef|eel|plesiosaurus|mastiff|merfolk|sahuagin|vulture|weasel|badger|boar$|lizard$|hyena$|jackal$/;

// Only hostile land-based creatures make sense as random enemies.
function usable(m) {
  if (m.cr <= 0 || !m.actions.some((a) => a.attackBonus !== undefined)) return false;
  if (HARMLESS.test(m.id) || /good/.test(m.alignment)) return false;
  if (m.type.startsWith('humanoid') && !/evil|non-lawful|non-good|chaotic/.test(m.alignment)) return false;
  return /walk|fly/.test(m.speedText);
}

function poolFor(theme, maxCr) {
  const types = THEME_TYPES[theme] || THEME_TYPES.dungeon;
  return lib.monsters.filter((m) => usable(m) && m.cr <= maxCr && types.some((t) => m.type.startsWith(t)));
}

// Picks a mix of monsters whose XP total approaches `budget`.
function buildEncounter(rng, pool, budget, maxMonsters = 6) {
  const candidates = pool.filter((m) => m.xp <= budget);
  if (!candidates.length) return [[pool.reduce((a, b) => (a.xp <= b.xp ? a : b)).id, 1]];
  const leader = pick(rng, candidates);
  const counts = new Map([[leader.id, 1]]);
  let spent = leader.xp;
  let total = 1;
  const minions = candidates.filter((m) => m.xp <= Math.max(25, leader.xp / 2));
  const minion = minions.length ? pick(rng, minions) : leader;
  while (total < maxMonsters && spent + minion.xp <= budget) {
    counts.set(minion.id, (counts.get(minion.id) || 0) + 1);
    spent += minion.xp;
    total += 1;
  }
  return [...counts.entries()];
}

function lootFor(rng, level) {
  const rarities = level <= 4 ? ['Common', 'Uncommon'] : level <= 10 ? ['Uncommon', 'Rare'] : ['Rare', 'Very Rare'];
  const magic = lib.items.filter((i) => i.category === 'magic' && rarities.includes(i.rarity));
  const out = [];
  if (rng() < 0.7) out.push('magic-potion-of-healing');
  if (rng() < 0.5 && magic.length) out.push(pick(rng, magic).id);
  return out;
}

function monsterNames(list) {
  return list.map(([id, n]) => {
    const m = lib.monster(id);
    return n > 1 ? `${n}× ${m.name}` : m.name;
  }).join(', ');
}

// options: { level, partySize, theme, encounters, seed }
function generate(options = {}) {
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : Math.floor(Math.random() * 2 ** 31);
  const rng = mulberry32(seed);
  const level = Math.min(20, Math.max(1, Number.parseInt(options.level, 10) || 1));
  const party = Math.min(8, Math.max(1, Number.parseInt(options.partySize, 10) || 4));
  const theme = THEME_TYPES[options.theme] ? options.theme : pick(rng, Object.keys(THEME_TYPES));
  const count = Math.min(5, Math.max(1, Number.parseInt(options.encounters, 10) || 3));

  const place = pick(rng, PLACES[theme]);
  const village = pick(rng, VILLAGES);
  const budget = XP_MEDIUM[level] * party;

  // The boss is a tougher monster from the theme, at most CR level+2.
  const bossPool = poolFor(theme, level + 2)
    .filter((m) => m.xp <= Math.max(budget * 1.5, 100))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 8);
  const boss = bossPool.length ? pick(rng, bossPool) : null;

  const pool = poolFor(theme, Math.max(0.25, level));
  const encounters = [];
  for (let i = 0; i < count; i += 1) {
    const last = i === count - 1;
    let monsters;
    if (last && boss) {
      const rest = budget - boss.xp;
      monsters = [[boss.id, 1]];
      if (rest > 0) {
        const minions = buildEncounter(rng, pool.filter((m) => m.xp <= rest / 2), rest, 4);
        monsters.push(...minions.filter(([id]) => id !== boss.id));
      }
    } else {
      monsters = buildEncounter(rng, pool, budget * (0.6 + i * 0.15));
    }
    encounters.push({
      title: last ? `Леговището на ${boss ? boss.name : 'злодея'}` : pick(rng, ENCOUNTER_TITLES),
      text: fill(pick(rng, ENCOUNTER_TEXTS), { monsters: monsterNames(monsters) }),
      monsters,
      loot: lootFor(rng, level),
      gold: Math.round((10 + rng() * 40) * level * (last ? 4 : 1)),
    });
  }

  const vars = { village, victim: pick(rng, VICTIMS), place, gold: 50 * level };
  const villain = boss ? boss.name : 'неизвестен злодей';
  return {
    id: `random-${seed}`,
    seed,
    title: `${place}`,
    level,
    theme,
    summary: `${fill(pick(rng, HOOKS), vars)} ${pick(rng, GOALS)}`,
    intro: `${fill(pick(rng, HOOKS), vars)} Пътят ви отвежда до ${place}. Говори се, че там се е скрил ${villain}. ${pick(rng, GOALS)}`,
    twist: pick(rng, TWISTS),
    encounters,
    outro: `${villain} е победен и ${place} отново е тихо място. Жителите на ${village} ще помнят имената ви.`,
  };
}

module.exports = { generate, XP_MEDIUM, poolFor, buildEncounter };
