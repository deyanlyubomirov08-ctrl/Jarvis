'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { RoomStore, GameError } = require('../server/rooms');

function setup() {
  const store = new RoomStore();
  const { room, player: dm } = store.createRoom('Тест', 'DM');
  const { player: alice } = store.joinRoom(room.code, 'Алиса');
  const { player: bob } = store.joinRoom(room.code, 'Боб');
  return { store, room, dm, alice, bob };
}

test('creates rooms with 6-char codes and a DM', () => {
  const { room, dm } = setup();
  assert.match(room.code, /^[A-Z0-9]{6}$/);
  assert.strictEqual(room.dmId, dm.id);
});

test('rejoin requires the matching secret', () => {
  const { store, room, alice } = setup();
  assert.strictEqual(store.joinRoom(room.code, '', alice.id, alice.secret).player.id, alice.id);
  assert.throws(() => store.joinRoom(room.code, '', alice.id, 'wrong'), GameError);
});

test('views never leak secrets', () => {
  const { store, room, alice } = setup();
  const json = JSON.stringify(store.viewFor(room, alice.id));
  for (const p of Object.values(room.players)) assert.ok(!json.includes(p.secret));
});

test('only owner or DM can edit a character; values are clamped', () => {
  const { store, room, dm, alice, bob } = setup();
  const c = store.createCharacter(room, alice.id, 'Гимли');
  assert.throws(() => store.updateCharacter(room, bob.id, c.id, { hp: 1 }), GameError);
  store.updateCharacter(room, alice.id, c.id, { level: 99, abilities: { str: 18, dex: 'x' } });
  assert.strictEqual(c.level, 20);
  assert.strictEqual(c.abilities.str, 18);
  assert.strictEqual(c.abilities.dex, 10);
  store.updateCharacter(room, dm.id, c.id, { hp: 3 });
  assert.strictEqual(c.hp, 3);
});

test('hidden tokens and monster HP are only visible to the DM', () => {
  const { store, room, dm, alice } = setup();
  store.addToken(room, dm.id, { label: 'Гоблин', hp: 7 });
  store.addToken(room, dm.id, { label: 'Засада', hidden: true });
  const dmView = store.viewFor(room, dm.id);
  const playerView = store.viewFor(room, alice.id);
  assert.strictEqual(dmView.tokens.length, 2);
  assert.strictEqual(playerView.tokens.length, 1);
  assert.strictEqual(playerView.tokens[0].hp, null);
  assert.strictEqual(dmView.tokens.find((t) => t.label === 'Гоблин').hp, 7);
});

test('players move only their own tokens, within bounds', () => {
  const { store, room, dm, alice, bob } = setup();
  const c = store.createCharacter(room, alice.id, 'Леголас');
  const t = store.addToken(room, alice.id, { characterId: c.id });
  const monster = store.addToken(room, dm.id, { label: 'Орк' });
  store.moveToken(room, alice.id, t.id, 500, -3);
  assert.deepStrictEqual([t.x, t.y], [room.map.cols - 1, 0]);
  assert.throws(() => store.moveToken(room, bob.id, t.id, 1, 1), GameError);
  assert.throws(() => store.moveToken(room, alice.id, monster.id, 1, 1), GameError);
  assert.throws(() => store.addToken(room, alice.id, { label: 'Дракон' }), GameError);
});

test('initiative sorts, advances turns and rounds', () => {
  const { store, room, dm } = setup();
  store.addInitiative(room, dm.id, { name: 'A', value: 5 });
  store.addInitiative(room, dm.id, { name: 'B', value: 18 });
  store.addInitiative(room, dm.id, { name: 'C', value: 11 });
  assert.deepStrictEqual(room.initiative.entries.map((e) => e.name), ['B', 'C', 'A']);
  store.nextTurn(room, dm.id);
  store.nextTurn(room, dm.id);
  store.nextTurn(room, dm.id);
  assert.strictEqual(room.initiative.turn, 0);
  assert.strictEqual(room.initiative.round, 2);
  store.prevTurn(room, dm.id);
  assert.strictEqual(room.initiative.round, 1);
  assert.strictEqual(room.initiative.entries[room.initiative.turn].name, 'A');
});

test('adding an entry keeps the current turn on the same combatant', () => {
  const { store, room, dm } = setup();
  store.addInitiative(room, dm.id, { name: 'A', value: 10 });
  store.addInitiative(room, dm.id, { name: 'B', value: 5 });
  store.nextTurn(room, dm.id);
  store.addInitiative(room, dm.id, { name: 'C', value: 20 });
  assert.strictEqual(room.initiative.entries[room.initiative.turn].name, 'B');
});

test('private messages are visible to author and DM only', () => {
  const { store, room, dm, alice, bob } = setup();
  const msg = store.addMessage(room, { type: 'roll', visibleTo: [alice.id, dm.id] });
  assert.ok(store.canSeeMessage(room, alice.id, msg));
  assert.ok(store.canSeeMessage(room, dm.id, msg));
  assert.ok(!store.canSeeMessage(room, bob.id, msg));
});

test('map background accepts only http(s) URLs', () => {
  const { store, room, dm } = setup();
  store.updateMap(room, dm.id, { background: 'javascript:alert(1)' });
  assert.strictEqual(room.map.background, '');
  store.updateMap(room, dm.id, { background: 'https://example.com/map.png' });
  assert.strictEqual(room.map.background, 'https://example.com/map.png');
});

test('persists and reloads through JSON', () => {
  const { store, room } = setup();
  const copy = new RoomStore();
  copy.load(JSON.parse(JSON.stringify(store.toJSON())));
  assert.strictEqual(copy.get(room.code).name, 'Тест');
});
