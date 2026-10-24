'use strict';

// Read-only access to the bundled SRD data (server/srd/*.json).

const monsters = require('./srd/monsters.json');
const items = require('./srd/items.json');
const races = require('./srd/races.json');
const classes = require('./srd/classes.json');
const spells = require('./srd/spells.json');

const RACE_BG = {
  dwarf: 'Джудже', elf: 'Елф', halfling: 'Полуръст', human: 'Човек', dragonborn: 'Драконороден',
  gnome: 'Гном', 'half-elf': 'Полуелф', 'half-orc': 'Полуорк', tiefling: 'Тифлинг',
};
const CLASS_BG = {
  barbarian: 'Варвар', bard: 'Бард', cleric: 'Жрец', druid: 'Друид', fighter: 'Воин', monk: 'Монах',
  paladin: 'Паладин', ranger: 'Следотърсач', rogue: 'Мошеник', sorcerer: 'Чародей', warlock: 'Вещер', wizard: 'Магьосник',
};
const TYPE_BG = {
  aberration: 'Аберация', beast: 'Звяр', celestial: 'Небесно', construct: 'Конструкт', dragon: 'Дракон',
  elemental: 'Елементал', fey: 'Фея', fiend: 'Демон', giant: 'Великан', humanoid: 'Хуманоид',
  monstrosity: 'Чудовище', ooze: 'Слуз', plant: 'Растение', undead: 'Нежит', swarm: 'Рояк',
};

for (const r of races) r.nameBg = RACE_BG[r.id] || r.name;
for (const c of classes) c.nameBg = CLASS_BG[c.id] || c.name;

const byId = (list) => new Map(list.map((x) => [x.id, x]));
const monsterMap = byId(monsters);
const itemMap = byId(items);
const raceMap = byId(races);
const classMap = byId(classes);
const spellMap = byId(spells);

function monsterSummary(m) {
  return {
    id: m.id, name: m.name, type: m.type, size: m.size, cr: m.cr, xp: m.xp,
    hp: m.hp, ac: m.ac, image: m.image, icon: m.icon,
  };
}

function itemSummary(i) {
  return {
    id: i.id, name: i.name, category: i.category, kind: i.kind, rarity: i.rarity,
    damage: i.damage, armorClass: i.armorClass, image: i.image, icon: i.icon, cost: i.cost,
  };
}

function spellSummary(s) {
  return { id: s.id, name: s.name, level: s.level, school: s.school, classes: s.classes };
}

// Compact index the client downloads once and searches locally.
function catalog() {
  return {
    monsters: monsters.map(monsterSummary),
    items: items.map(itemSummary),
    spells: spells.map(spellSummary),
    races: races.map((r) => ({ id: r.id, name: r.name, nameBg: r.nameBg, speed: r.speed, bonuses: r.bonuses, traits: r.traits, subraces: r.subraces })),
    classes: classes.map((c) => ({ id: c.id, name: c.name, nameBg: c.nameBg, hitDie: c.hitDie, saves: c.saves, icon: c.icon })),
    typeNames: TYPE_BG,
  };
}

module.exports = {
  monsters, items, races, classes, spells,
  monster: (id) => monsterMap.get(id),
  item: (id) => itemMap.get(id),
  race: (id) => raceMap.get(id),
  cls: (id) => classMap.get(id),
  spell: (id) => spellMap.get(id),
  catalog,
  RACE_BG, CLASS_BG, TYPE_BG,
};
