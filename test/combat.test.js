'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RoomStore } = require('../server/rooms');
const combat = require('../server/combat');
const { mulberry32 } = require('../server/mapgen');

function arena() {
  const store = new RoomStore();
  const { room, player } = store.createRoom('Арена', 'DM');
  const hero = store.createCharacter(room, player.id, 'Боримир', { race: 'human', cls: 'fighter' });
  const heroToken = store.addToken(room, player.id, { characterId: hero.id, x: 0, y: 0 });
  const goblin = store.addToken(room, player.id, { monsterId: 'goblin', x: 1, y: 0 });
  return { room, hero, heroToken, goblin };
}

test('attacks start with an fx entry naming attacker and target tokens', () => {
  const { room, hero, heroToken, goblin } = arena();
  const { messages, hit, damage } = combat.resolveAttack(room, hero.name, hero.weapons[0], combat.combatant(room, goblin), mulberry32(3), heroToken);
  const [first] = messages;
  assert.strictEqual(first.type, 'fx');
  assert.deepStrictEqual(
    { kind: first.fx.kind, from: first.fx.from, to: first.fx.to, hit: first.fx.hit, damage: first.fx.damage },
    { kind: 'attack', from: heroToken.id, to: goblin.id, hit, damage },
  );
  assert.strictEqual(first.fx.down, Boolean(goblin.dead));
});

test('healing and area attacks also describe their effect', () => {
  const { room, hero, heroToken, goblin } = arena();
  hero.hp = 1;
  const heal = combat.useHeal({ name: 'Второ дихание', dice: '1d10+1' }, hero.name, combat.combatant(room, heroToken), mulberry32(1), heroToken);
  assert.strictEqual(heal[0].fx.kind, 'heal');
  assert.strictEqual(heal[0].fx.to, heroToken.id);
  assert.ok(heal[0].fx.amount >= 2);

  const breath = { name: 'Fire Breath', damage: '2d6', save: 'dex', dc: 12, damageType: 'Fire' };
  const { messages } = combat.resolveAreaSave(room, 'Дракон', breath, [combat.combatant(room, heroToken)], mulberry32(2), goblin);
  assert.strictEqual(messages[0].fx.kind, 'area');
  assert.deepStrictEqual(messages[0].fx.targets, [heroToken.id]);
  assert.strictEqual(messages[0].fx.element, 'Fire');
});
