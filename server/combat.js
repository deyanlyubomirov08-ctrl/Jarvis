'use strict';

// Attack resolution shared by players, the human DM and the computer DM.
// Functions return chat entries ({ type: 'roll' | 'narration', ... }) and
// leave posting them to the caller.

const { roll } = require('./dice');
const lib = require('./library');

const DEFAULT_ABILITIES = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
const ABILITY_BG = { str: 'Сила', dex: 'Ловкост', con: 'Издръжливост', int: 'Интелект', wis: 'Мъдрост', cha: 'Харизма' };

const mod = (score) => Math.floor(((score || 10) - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

function rngDie(rng) {
  return rng ? (sides) => 1 + Math.floor(rng() * sides) : undefined;
}

// Squares between two token footprints (0 = overlapping, 1 = adjacent).
function distance(a, b) {
  const dx = Math.max(0, b.x - (a.x + a.size - 1), a.x - (b.x + b.size - 1));
  const dy = Math.max(0, b.y - (a.y + a.size - 1), a.y - (b.y + b.size - 1));
  return Math.max(dx, dy);
}

// Uniform view of whatever stands behind a token.
function combatant(room, token) {
  if (token.characterId) {
    const c = room.characters[token.characterId];
    if (!c) return null;
    return {
      kind: 'pc', token, character: c, name: c.name, ac: c.ac, abilities: c.abilities,
      get hp() { return c.hp; },
      alive: c.hp > 0,
    };
  }
  const m = token.monsterId ? lib.monster(token.monsterId) : null;
  return {
    kind: 'monster', token, monster: m, name: token.label, ac: token.ac || (m && m.ac) || 10,
    abilities: (m && m.abilities) || DEFAULT_ABILITIES,
    get hp() { return token.hp; },
    alive: !token.dead && (token.maxHp ? token.hp > 0 : true),
  };
}

function applyDamage(target, amount) {
  if (target.kind === 'pc') {
    const c = target.character;
    const fromTemp = Math.min(c.tempHp || 0, amount);
    c.tempHp = (c.tempHp || 0) - fromTemp;
    c.hp = Math.max(0, c.hp - (amount - fromTemp));
    return c.hp === 0 ? `${c.name} пада в безсъзнание!` : null;
  }
  const t = target.token;
  if (t.maxHp) {
    t.hp = Math.max(0, (t.hp || 0) - amount);
    if (t.hp === 0) {
      t.dead = true;
      return `${t.label} е повален!`;
    }
  }
  return null;
}

function heal(target, amount) {
  if (target.kind === 'pc') {
    const c = target.character;
    c.hp = Math.min(c.maxHp, c.hp + amount);
  } else if (target.token.maxHp) {
    target.token.hp = Math.min(target.token.maxHp, target.token.hp + amount);
    if (target.token.hp > 0) target.token.dead = false;
  }
}

const doubleDice = (expr) => expr.replace(/(\d*)d(\d+)/g, (_, n, s) => `${(Number(n) || 1) * 2}d${s}`);

// attack: { name, attackBonus?, damage, damageType, save?, dc?, range?, ranged?, reach? }
function resolveAttack(room, attackerName, attack, target, rng) {
  const die = rngDie(rng);
  const out = [];
  if (!attack.damage) {
    out.push({ type: 'narration', text: `${attackerName} използва ${attack.name}.` });
    return { messages: out, hit: false, damage: 0 };
  }

  let hit;
  let crit = false;
  if (attack.save) {
    const saveMod = mod(target.abilities[attack.save]);
    const save = roll(`1d20${signed(saveMod)}`, die);
    out.push({
      type: 'roll',
      label: `${target.name}: спасителен хвърлей (${ABILITY_BG[attack.save] || attack.save}) срещу DC ${attack.dc} — ${attack.name}`,
      result: save,
    });
    hit = save.total < attack.dc;
  } else {
    const toHit = roll(`1d20${signed(attack.attackBonus || 0)}`, die);
    crit = toHit.crit === 'success';
    hit = crit || (toHit.crit !== 'fail' && toHit.total >= target.ac);
    out.push({
      type: 'roll',
      label: `${attackerName} атакува ${target.name} с ${attack.name} (AC ${target.ac}) — ${crit ? 'КРИТИЧЕН УДАР!' : hit ? 'попадение' : 'пропуск'}`,
      result: toHit,
    });
  }

  let damage = 0;
  if (hit) {
    const dmg = roll(crit ? doubleDice(attack.damage) : attack.damage, die);
    damage = Math.max(1, dmg.total);
    out.push({ type: 'roll', label: `Щета (${attack.damageType || '—'}) по ${target.name}`, result: { ...dmg, total: damage } });
    const note = applyDamage(target, damage);
    if (note) out.push({ type: 'narration', text: note });
  } else if (attack.save) {
    out.push({ type: 'narration', text: `${target.name} избягва ${attack.name}.` });
  }
  return { messages: out, hit, damage };
}

// Area save attack (e.g. breath weapon): half damage on a successful save.
function resolveAreaSave(room, attackerName, attack, targets, rng) {
  const die = rngDie(rng);
  const out = [];
  const dmg = roll(attack.damage, die);
  out.push({ type: 'narration', text: `${attackerName} използва ${attack.name}!` });
  out.push({ type: 'roll', label: `${attack.name}: щета`, result: dmg });
  for (const t of targets) {
    const save = roll(`1d20${signed(mod(t.abilities[attack.save]))}`, die);
    const ok = save.total >= attack.dc;
    const amount = ok ? Math.floor(dmg.total / 2) : dmg.total;
    out.push({ type: 'roll', label: `${t.name}: спасителен хвърлей DC ${attack.dc} — ${ok ? 'половин щета' : 'пълна щета'} (${amount})`, result: save });
    const note = applyDamage(t, amount);
    if (note) out.push({ type: 'narration', text: note });
  }
  return { messages: out };
}

// Healing feature: returns chat entries; the caller checks uses and range.
function useHeal(feature, healerName, target, rng) {
  const die = rngDie(rng);
  const r = roll(feature.dice, die);
  const amount = Math.max(1, r.total);
  const wasDown = target.kind === 'pc' && target.character.hp <= 0;
  heal(target, amount);
  const out = [{ type: 'roll', label: `${healerName}: ${feature.name} → ${target.name} (+${amount} HP)`, result: { ...r, total: amount } }];
  if (wasDown) out.push({ type: 'narration', text: `${target.name} отваря очи и се изправя отново!` });
  return out;
}

function inRange(attacker, target, attack) {
  const d = distance(attacker, target);
  if (attack.ranged || attack.save) return d * 5 <= (attack.range || 30) * 2; // long range allowed
  return d * 5 <= Math.max(5, attack.reach || attack.range || 5);
}

module.exports = {
  useHeal,
  distance, combatant, applyDamage, heal, resolveAttack, resolveAreaSave, inRange, doubleDice, mod, signed, ABILITY_BG,
};
