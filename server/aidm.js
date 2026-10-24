'use strict';

// The computer Dungeon Master: loads adventures onto the map, runs
// encounters, plays monster turns and hands out rewards. Every function
// mutates the room and returns chat entries for the caller to post.

const crypto = require('crypto');
const lib = require('./library');
const mapgen = require('./mapgen');
const combat = require('./combat');
const { roll } = require('./dice');
const chargen = require('./chargen');

const SIZE_SQUARES = { Tiny: 1, Small: 1, Medium: 1, Large: 2, Huge: 3, Gargantuan: 4 };
const XP_LEVELS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

const newId = () => crypto.randomBytes(8).toString('hex');
const say = (text) => ({ type: 'narration', text });

class DMError extends Error {}

// ---------- Helpers ----------

function occupiedCells(room, exceptId) {
  const set = new Set();
  for (const t of Object.values(room.tokens)) {
    if (t.id === exceptId || t.dead) continue;
    if (t.characterId && room.characters[t.characterId] && room.characters[t.characterId].hp <= 0) continue;
    for (let i = 0; i < t.size; i += 1) for (let j = 0; j < t.size; j += 1) set.add(`${t.x + i},${t.y + j}`);
  }
  return set;
}

function partyTokens(room) {
  return Object.values(room.tokens).filter((t) => t.characterId && room.characters[t.characterId]);
}

function encounterMonsters(room) {
  return Object.values(room.tokens).filter((t) => t.encounter && !t.characterId);
}

// ---------- Party & adventure setup ----------

function placeParty(room) {
  const { map } = room;
  const start = (map.areas && map.areas[0]) || { x: 0, y: 0, w: 3, h: 3 };
  const occupied = occupiedCells(room);
  for (const c of Object.values(room.characters)) {
    let token = Object.values(room.tokens).find((t) => t.characterId === c.id);
    if (token) {
      if (mapgen.isPassable(map.tiles, token.x, token.y)) continue;
    } else {
      token = {
        id: newId(), label: c.name, size: 1, color: c.color, characterId: c.id, ownerId: c.ownerId,
        hidden: false, hp: null, maxHp: null, icon: c.icon || null, image: c.portrait || null, x: 0, y: 0,
      };
      room.tokens[token.id] = token;
    }
    const [pos] = mapgen.placeIn(map.tiles, map.cols, map.rows, start, 1, occupied, 1);
    if (pos) Object.assign(token, pos);
  }
}

function loadAdventure(room, adventure, seed = Math.floor(Math.random() * 2 ** 31)) {
  if (room.adventure && room.adventure.status === 'combat') throw new DMError('Първо приключете текущата битка');
  const generated = mapgen.generate(adventure.theme, 30, 20, seed);
  room.map = {
    ...room.map,
    background: '',
    cols: generated.cols,
    rows: generated.rows,
    tiles: generated.tiles,
    theme: generated.theme,
    areas: generated.areas,
  };
  for (const [id, t] of Object.entries(room.tokens)) if (!t.characterId) delete room.tokens[id];
  room.initiative = { entries: [], turn: 0, round: 1, started: false, acted: false };
  room.adventure = {
    id: adventure.id,
    title: adventure.title,
    level: adventure.level,
    theme: adventure.theme,
    summary: adventure.summary,
    intro: adventure.intro,
    twist: adventure.twist || null,
    outro: adventure.outro,
    encounters: adventure.encounters.map((e) => ({ ...e, monsters: e.monsters.map(([m, n]) => [m, n]) })),
    index: -1,
    status: 'ready',
  };
  placeParty(room);
  return [say(`📜 ${adventure.title}`), say(adventure.intro)];
}

// ---------- Encounters ----------

function rollInitiative(room, rng) {
  const die = rng ? (s) => 1 + Math.floor(rng() * s) : undefined;
  const entries = [];
  for (const t of partyTokens(room)) {
    const c = room.characters[t.characterId];
    if (c.hp <= 0) continue;
    const r = roll(`1d20${combat.signed(combat.mod(c.abilities.dex))}`, die);
    entries.push({ id: newId(), name: c.name, value: r.total, characterId: c.id, tokenId: t.id, hidden: false });
  }
  for (const t of encounterMonsters(room)) {
    if (t.dead) continue;
    const m = lib.monster(t.monsterId);
    const r = roll(`1d20${combat.signed(combat.mod(m ? m.abilities.dex : 10))}`, die);
    entries.push({ id: newId(), name: t.label, value: r.total, characterId: null, tokenId: t.id, hidden: Boolean(t.hidden) });
  }
  entries.sort((a, b) => b.value - a.value);
  room.initiative = { entries, turn: 0, round: 1, started: true, acted: false };
  return entries;
}

function monsterToken(m, label, pos, hidden = false) {
  return {
    id: newId(),
    label,
    x: pos.x,
    y: pos.y,
    size: SIZE_SQUARES[m.size] || 1,
    color: '#7b241c',
    characterId: null,
    ownerId: null,
    hidden,
    hp: m.hp,
    maxHp: m.hp,
    ac: m.ac,
    monsterId: m.id,
    image: m.image,
    icon: m.icon,
    encounter: true,
    dead: false,
  };
}

function startEncounter(room, rng) {
  const adv = room.adventure;
  if (!adv) throw new DMError('Няма заредено приключение');
  if (adv.status === 'combat') throw new DMError('Битката още не е приключила');
  if (adv.status === 'victory') throw new DMError('Приключението е завършено');
  if (adv.index + 1 >= adv.encounters.length) throw new DMError('Няма повече срещи');
  if (!partyTokens(room).some((t) => room.characters[t.characterId].hp > 0)) {
    throw new DMError('Няма герои на картата — създайте поне един герой');
  }
  adv.index += 1;
  const enc = adv.encounters[adv.index];

  for (const [id, t] of Object.entries(room.tokens)) if (!t.characterId) delete room.tokens[id];
  placeParty(room);

  const areas = room.map.areas && room.map.areas.length ? room.map.areas : [{ x: 10, y: 5, w: 5, h: 5 }];
  const area = areas[Math.min(areas.length - 1, adv.index + 1)] || areas[areas.length - 1];
  const occupied = occupiedCells(room);
  for (const [monsterId, count] of enc.monsters) {
    const m = lib.monster(monsterId);
    if (!m) continue;
    const size = SIZE_SQUARES[m.size] || 1;
    const spots = mapgen.placeIn(room.map.tiles, room.map.cols, room.map.rows, area, count, occupied, size);
    spots.forEach((pos, i) => {
      const t = monsterToken(m, count > 1 ? `${m.name} ${i + 1}` : m.name, pos);
      room.tokens[t.id] = t;
    });
  }
  adv.status = 'combat';
  const order = rollInitiative(room, rng);
  return [
    say(`⚔️ Среща ${adv.index + 1}/${adv.encounters.length}: ${enc.title}`),
    say(enc.text),
    say(`Инициатива: ${order.filter((e) => !e.hidden).map((e) => `${e.name} (${e.value})`).join(', ')}`),
  ];
}

function levelUp(c) {
  const cls = lib.cls(c.clsId);
  const hitDie = cls ? cls.hitDie : 8;
  const gain = Math.max(1, Math.floor(hitDie / 2) + 1 + combat.mod(c.abilities.con));
  c.level += 1;
  c.maxHp += gain;
  c.hp += gain;
  const prof = chargen.proficiencyFor(c.level);
  const delta = prof - c.proficiency;
  c.proficiency = prof;
  for (const w of c.weapons || []) {
    if (typeof w.attackBonus === 'number') w.attackBonus += delta;
    if (typeof w.dc === 'number') w.dc += delta;
  }
  if (c.clsId) c.features = chargen.classFeatures(c.clsId, c.abilities, c.level);
}

function award(room, enc, monsters) {
  const out = [];
  const party = partyTokens(room).map((t) => room.characters[t.characterId]);
  if (!party.length) return out;
  const xp = monsters.reduce((s, t) => s + ((lib.monster(t.monsterId) || {}).xp || 0), 0);
  const share = Math.floor(xp / party.length);
  const goldShare = Math.floor((enc.gold || 0) / party.length);
  for (const c of party) {
    c.xp = (c.xp || 0) + share;
    c.gold = (c.gold || 0) + goldShare;
    while (c.level < 20 && c.xp >= XP_LEVELS[c.level]) {
      levelUp(c);
      out.push(say(`🌟 ${c.name} достига ниво ${c.level}! (макс. HP ${c.maxHp})`));
    }
  }
  out.unshift(say(`🏆 Всеки герой получава ${share} XP и ${goldShare} жълтици.`));
  const alive = party.filter((c) => c.hp > 0);
  (enc.loot || []).forEach((itemId, i) => {
    const it = lib.item(itemId);
    const owner = (alive.length ? alive : party)[i % (alive.length || party.length)];
    if (!it || !owner) return;
    owner.items = owner.items || [];
    owner.items.push({ id: it.id, name: it.name, icon: it.icon, image: it.image });
    out.push(say(`🎁 ${owner.name} намира: ${it.name} (${it.rarity})`));
  });
  return out;
}

// Called after every combat action.
function checkOutcome(room) {
  const adv = room.adventure;
  if (!adv || adv.status !== 'combat') return [];
  const monsters = encounterMonsters(room);
  const party = partyTokens(room).map((t) => room.characters[t.characterId]);
  if (monsters.length && monsters.every((t) => t.dead)) {
    const enc = adv.encounters[adv.index];
    const out = [say(`✨ Победа! „${enc.title}“ е преодоляна.`), ...award(room, enc, monsters)];
    room.initiative = { entries: [], turn: 0, round: 1, started: false, acted: false };
    if (adv.index + 1 >= adv.encounters.length) {
      adv.status = 'victory';
      out.push(say(`🏁 ${adv.outro}`));
      if (adv.twist) out.push(say(`🔮 Тайната на тази история: ${adv.twist}`));
    } else {
      adv.status = 'cleared';
      out.push(say('Можете да си починете или да продължите напред, когато сте готови.'));
    }
    return out;
  }
  // Safety valve: if nobody can reach anybody, the monsters retreat.
  if (room.initiative.round > 30 && monsters.some((t) => !t.dead)) {
    for (const t of monsters) if (!t.dead) { t.dead = true; t.fled = true; }
    return [say('Враговете не издържат и се оттеглят в мрака!'), ...checkOutcome(room)];
  }
  if (party.length && party.every((c) => c.hp <= 0)) {
    adv.status = 'defeat';
    room.initiative = { entries: [], turn: 0, round: 1, started: false, acted: false };
    return [say('💀 Всички герои са повалени. Мракът ги поглъща… Можете да опитате срещата отново.')];
  }
  return [];
}

function rest(room) {
  const adv = room.adventure;
  if (adv && adv.status === 'combat') throw new DMError('Не може да почивате по време на битка');
  for (const c of Object.values(room.characters)) {
    c.hp = c.maxHp;
    c.tempHp = 0;
    for (const f of c.features || []) f.uses = f.maxUses;
  }
  return [say('🔥 Героите палят огън и почиват. Раните заздравяват — всички са с пълни точки живот.')];
}

function retry(room, rng) {
  const adv = room.adventure;
  if (!adv || adv.status !== 'defeat') throw new DMError('Няма загубена среща за повторение');
  for (const c of Object.values(room.characters)) {
    c.hp = c.maxHp;
    for (const f of c.features || []) f.uses = f.maxUses;
  }
  adv.index -= 1;
  adv.status = 'ready';
  return [say('⏳ Времето се връща назад… Героите получават втори шанс.'), ...startEncounter(room, rng)];
}

// ---------- Turns ----------

function currentEntry(room) {
  const init = room.initiative;
  return init.entries[init.turn] || null;
}

function advanceTurn(room) {
  const init = room.initiative;
  if (!init.entries.length) return;
  init.started = true;
  init.acted = false;
  init.bonusActed = false;
  init.turn += 1;
  if (init.turn >= init.entries.length) {
    init.turn = 0;
    init.round += 1;
  }
}

// What should happen automatically for the current initiative entry:
// 'skip' (dead / downed), 'monster' (AI plays it) or null (wait for a human).
function pendingAutomation(room) {
  const adv = room.adventure;
  const e = currentEntry(room);
  if (!e || !room.initiative.started) return null;
  if (adv && adv.status !== 'combat') return null;
  if (e.characterId) {
    const c = room.characters[e.characterId];
    return !c || c.hp <= 0 ? 'skip' : null;
  }
  const t = room.tokens[e.tokenId];
  if (!t || t.dead) return 'skip';
  return room.autoMonsters ? 'monster' : null;
}

// BFS over top-left positions where a token of `size` fits.
function bfs(room, token, occupied) {
  const { tiles, cols, rows } = room.map;
  const size = token.size;
  const fits = (x, y) => {
    if (x < 0 || y < 0 || x + size > cols || y + size > rows) return false;
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        if (!mapgen.isPassable(tiles, x + i, y + j) || occupied.has(`${x + i},${y + j}`)) return false;
      }
    }
    return true;
  };
  const key = (x, y) => `${x},${y}`;
  const dist = new Map([[key(token.x, token.y), 0]]);
  const parent = new Map();
  const queue = [[token.x, token.y]];
  while (queue.length) {
    const [x, y] = queue.shift();
    const d = dist.get(key(x, y));
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (dist.has(key(nx, ny)) || !fits(nx, ny)) continue;
        dist.set(key(nx, ny), d + 1);
        parent.set(key(nx, ny), [x, y]);
        queue.push([nx, ny]);
      }
    }
  }
  const pathTo = (x, y) => {
    const path = [];
    let cur = [x, y];
    while (cur && !(cur[0] === token.x && cur[1] === token.y)) {
      path.unshift(cur);
      cur = parent.get(key(cur[0], cur[1]));
    }
    return path;
  };
  return { dist, pathTo };
}

function monsterActions(m) {
  const attacks = m.actions.filter((a) => typeof a.attackBonus === 'number' && a.damage);
  return {
    melee: attacks.filter((a) => !a.ranged),
    ranged: attacks.filter((a) => a.ranged || a.range),
    area: m.actions.filter((a) => a.dc && a.save && a.damage && typeof a.attackBonus !== 'number'),
    multi: (m.actions.find((a) => a.multi) || {}).multi || null,
  };
}

function bestOf(list) {
  return list.reduce((a, b) => {
    const avg = (x) => (x.damage.match(/\d+d\d+/g) || []).reduce((s, d) => {
      const [n, sides] = d.split('d').map(Number);
      return s + n * (sides + 1) / 2;
    }, 0);
    return avg(b) > avg(a) ? b : a;
  });
}

function monsterTurn(room, token, rng) {
  const m = lib.monster(token.monsterId);
  const out = [];
  const alivePcs = () => partyTokens(room)
    .filter((t) => room.characters[t.characterId].hp > 0)
    .map((t) => combat.combatant(room, t));
  let targets = alivePcs();
  if (!m || !targets.length) {
    out.push(say(`${token.label} изчаква.`));
    return out;
  }
  const acts = monsterActions(m);
  const self = combat.combatant(room, token);

  // Breath weapons and similar: once per encounter, when the party is close.
  if (acts.area.length && !token.usedArea && rng() < 0.7) {
    const near = targets.filter((t) => combat.distance(token, t.token) <= 6);
    if (near.length) {
      const primary = near.reduce((a, b) => (combat.distance(token, a.token) <= combat.distance(token, b.token) ? a : b));
      const hit = targets.filter((t) => combat.distance(primary.token, t.token) <= 1);
      token.usedArea = true;
      out.push(...combat.resolveAreaSave(room, token.label, acts.area[0], hit, rng).messages);
      return out;
    }
  }

  const reachOf = (a) => Math.max(1, Math.floor((a.reach || 5) / 5));
  const meleeReach = acts.melee.length ? Math.max(...acts.melee.map(reachOf)) : 1;
  const adjacent = () => targets.filter((t) => combat.distance(token, t.token) <= meleeReach);

  const meleeRound = () => {
    let plan = [];
    if (acts.multi) {
      for (const { name, count } of acts.multi) {
        const a = acts.melee.find((x) => x.name === name);
        if (a) for (let i = 0; i < count; i += 1) plan.push(a);
      }
    }
    if (!plan.length) plan = [bestOf(acts.melee)];
    for (const a of plan) {
      targets = alivePcs();
      const inReach = targets.filter((t) => combat.distance(token, t.token) <= reachOf(a));
      if (!inReach.length) break;
      const target = inReach.reduce((x, y) => (x.hp <= y.hp ? x : y));
      out.push(...combat.resolveAttack(room, token.label, a, target, rng).messages);
    }
  };
  const rangedShot = () => {
    const a = bestOf(acts.ranged);
    const inRange = targets.filter((t) => combat.distance(token, t.token) * 5 <= (a.range || 30));
    if (!inRange.length) return false;
    const target = inRange.reduce((x, y) => (combat.distance(token, x.token) <= combat.distance(token, y.token) ? x : y));
    out.push(...combat.resolveAttack(room, token.label, a, target, rng).messages);
    return true;
  };

  if (acts.melee.length && adjacent().length) {
    meleeRound();
    return out;
  }
  if (acts.ranged.length && !acts.melee.length) {
    if (rangedShot()) return out;
  }
  // Prefer ranged attacks for monsters that are already at range and fragile.
  if (acts.ranged.length && self.hp <= (token.maxHp || 0) / 2 && rangedShot()) return out;

  // Move towards the closest reachable hero.
  const { dist, pathTo } = bfs(room, token, occupiedCells(room, token.id));
  let best = null;
  for (const [k, d] of dist) {
    const [x, y] = k.split(',').map(Number);
    const probe = { x, y, size: token.size };
    for (const t of targets) {
      if (combat.distance(probe, t.token) <= meleeReach && (!best || d < best.d)) best = { x, y, d, target: t };
    }
  }
  const speed = Math.max(1, Math.floor(((m && m.speed) || 30) / 5));
  if (best) {
    const path = pathTo(best.x, best.y);
    const step = path[Math.min(speed, path.length) - 1];
    if (step) {
      token.x = step[0];
      token.y = step[1];
      out.push(say(`${token.label} се придвижва към ${best.target.name}.`));
    }
    if (acts.melee.length && adjacent().length) meleeRound();
    else if (acts.ranged.length) rangedShot();
  } else if (!(acts.ranged.length && rangedShot())) {
    out.push(say(`${token.label} ръмжи, но не може да стигне до героите.`));
  }
  return out;
}

// Runs one automated step. Returns chat entries; `more` tells the caller
// whether another automated step follows.
function step(room, rng) {
  const kind = pendingAutomation(room);
  if (!kind) return { messages: [], more: false };
  const e = currentEntry(room);
  const out = [];
  if (kind === 'skip') {
    if (e.characterId) out.push(say(`${e.name} лежи в безсъзнание и пропуска хода си.`));
  } else {
    out.push(...monsterTurn(room, room.tokens[e.tokenId], rng));
  }
  const outcome = checkOutcome(room);
  out.push(...outcome);
  if (!outcome.length) advanceTurn(room);
  const nextKind = pendingAutomation(room);
  if (!nextKind) {
    const next = currentEntry(room);
    if (next && next.characterId && room.adventure && room.adventure.status === 'combat') {
      out.push(say(`➡️ На ход е ${next.name}.`));
    }
  }
  return { messages: out, more: Boolean(nextKind) };
}

module.exports = {
  DMError, loadAdventure, startEncounter, checkOutcome, rest, retry, step, advanceTurn,
  currentEntry, pendingAutomation, monsterTurn, rollInitiative, placeParty, XP_LEVELS, levelUp,
};
