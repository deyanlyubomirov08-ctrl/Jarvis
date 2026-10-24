'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RoomStore } = require('../server/rooms');
const aidm = require('../server/aidm');
const combat = require('../server/combat');
const adventures = require('../server/adventures');
const generator = require('../server/generator');
const lib = require('../server/library');
const { roll } = require('../server/dice');
const { mulberry32 } = require('../server/mapgen');

function aiRoom(heroes = 4) {
  const store = new RoomStore();
  const { room, player } = store.createRoom('AI', 'Домакин', 'ai');
  for (let i = 0; i < heroes; i += 1) store.createCharacter(room, player.id, '', { random: true });
  return { store, room, player };
}

// Plays the current hero's turn: attack the nearest living monster with the
// first weapon, ignoring range (the server checks range separately).
function heroTurn(room, rng) {
  const e = aidm.currentEntry(room);
  const c = room.characters[e.characterId];
  const me = Object.values(room.tokens).find((t) => t.characterId === c.id);
  const foes = Object.values(room.tokens).filter((t) => t.monsterId && !t.dead);
  if (foes.length) {
    const target = foes.reduce((a, b) => (combat.distance(me, a) <= combat.distance(me, b) ? a : b));
    combat.resolveAttack(room, c.name, c.weapons[0], combat.combatant(room, target), rng);
  }
  aidm.checkOutcome(room);
  if (room.adventure.status === 'combat') aidm.advanceTurn(room);
}

function playEncounter(room, rng) {
  for (let i = 0; i < 2000 && room.adventure.status === 'combat'; i += 1) {
    if (aidm.pendingAutomation(room)) aidm.step(room, rng);
    else heroTurn(room, rng);
  }
}

test('every ready-made adventure plays through without errors', () => {
  for (const adv of adventures.ADVENTURES) {
    for (let seed = 1; seed <= 5; seed += 1) {
      const rng = mulberry32(seed);
      const { room } = aiRoom(4);
      for (const c of Object.values(room.characters)) { c.level = adv.level + 2; c.maxHp *= 3; c.hp = c.maxHp; }
      aidm.loadAdventure(room, adv, seed);
      while (!['victory', 'defeat'].includes(room.adventure.status)) {
        aidm.startEncounter(room, rng);
        playEncounter(room, rng);
        assert.notStrictEqual(room.adventure.status, 'combat', `${adv.id} stuck in combat`);
        if (room.adventure.status === 'cleared') aidm.rest(room);
      }
      if (room.adventure.status === 'victory') {
        assert.ok(Object.values(room.characters).every((c) => c.xp > 0));
      }
    }
  }
});

test('random adventures are playable at several levels', () => {
  for (const level of [1, 3, 5, 8]) {
    const rng = mulberry32(level);
    const { room } = aiRoom(4);
    const adv = generator.generate({ level, partySize: 4, seed: level * 3 });
    assert.ok(adv.encounters.length >= 1);
    aidm.loadAdventure(room, adv, level);
    aidm.startEncounter(room, rng);
    assert.ok(Object.values(room.tokens).some((t) => t.monsterId));
    playEncounter(room, rng);
    assert.ok(['cleared', 'victory', 'defeat'].includes(room.adventure.status));
  }
});

test('monster tokens never end up on walls', () => {
  const rng = mulberry32(9);
  const { room } = aiRoom(3);
  aidm.loadAdventure(room, adventures.get('nameless-crypt'), 9);
  aidm.startEncounter(room, rng);
  for (let i = 0; i < 40 && room.adventure.status === 'combat'; i += 1) {
    if (aidm.pendingAutomation(room)) aidm.step(room, rng); else heroTurn(room, rng);
    for (const t of Object.values(room.tokens)) {
      assert.notStrictEqual(room.map.tiles[t.y][t.x], '#', `${t.label} in a wall`);
    }
  }
});

test('all SRD attack damage expressions parse', () => {
  for (const m of lib.monsters) {
    for (const a of m.actions) if (a.damage) assert.doesNotThrow(() => roll(a.damage), `${m.id}: ${a.damage}`);
  }
});

test('ready-made adventures reference real SRD monsters and items', () => {
  for (const adv of adventures.ADVENTURES) {
    for (const e of adv.encounters) {
      for (const [id] of e.monsters) assert.ok(lib.monster(id), `${adv.id}: ${id}`);
      for (const id of e.loot) assert.ok(lib.item(id), `${adv.id}: ${id}`);
    }
  }
});

test('players cannot see the encounters ahead or monster HP', () => {
  const { store, room, player } = aiRoom(1);
  aidm.loadAdventure(room, adventures.get('goblin-ambush'), 1);
  aidm.startEncounter(room, mulberry32(1));
  const view = store.viewFor(room, player.id);
  assert.strictEqual(view.isController, true);
  assert.strictEqual(view.adventure.encounters[1].title, '???');
  const goblin = view.tokens.find((t) => t.monsterId);
  assert.strictEqual(goblin.hp, null);
  assert.strictEqual(goblin.hpPct, 100);
});
