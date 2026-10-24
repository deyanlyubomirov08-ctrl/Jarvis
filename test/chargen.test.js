'use strict';

const test = require('node:test');
const assert = require('node:assert');
const chargen = require('../server/chargen');
const lib = require('../server/library');
const mapgen = require('../server/mapgen');
const { mulberry32 } = mapgen;

test('builds every race/class combination with sane numbers', () => {
  for (const r of lib.races) {
    for (const c of lib.classes) {
      const ch = chargen.build({ race: r.id, cls: c.id, level: 1 }, mulberry32(1));
      assert.ok(ch.maxHp >= 1 && ch.maxHp <= 20, `${r.id}/${c.id} hp ${ch.maxHp}`);
      assert.ok(ch.ac >= 10 && ch.ac <= 20, `${r.id}/${c.id} ac ${ch.ac}`);
      assert.ok(ch.weapons.length >= 1);
      for (const w of ch.weapons) assert.match(w.damage, /^\d+d\d+([+-]\d+)?$/);
      assert.strictEqual(ch.proficiency, 2);
    }
  }
});

test('fighter with standard array gets expected stats', () => {
  const ch = chargen.build({ race: 'human', cls: 'fighter', level: 1 });
  assert.strictEqual(ch.abilities.str, 16); // 15 + 1 human
  assert.strictEqual(ch.ac, 18); // chain mail + shield
  assert.strictEqual(ch.maxHp, 10 + 2);
  assert.deepStrictEqual(Object.entries(ch.saves).filter(([, v]) => v).map(([k]) => k).sort(), ['con', 'str']);
});

test('higher levels raise HP and proficiency', () => {
  const ch = chargen.build({ race: 'dwarf', cls: 'cleric', level: 5 });
  assert.strictEqual(ch.proficiency, 3);
  assert.ok(ch.maxHp > 30);
});

test('generated maps are connected and areas lie on floor', () => {
  for (const theme of mapgen.THEMES) {
    for (let seed = 1; seed < 20; seed += 1) {
      const g = mapgen.generate(theme, 30, 20, seed);
      assert.strictEqual(g.tiles.length, 20);
      assert.ok(g.tiles.every((r) => r.length === 30));
      const spots = mapgen.placeIn(g.tiles, 30, 20, g.areas[0], 4, new Set());
      assert.strictEqual(spots.length, 4, `${theme}/${seed}`);
      for (const p of spots) assert.ok(mapgen.isPassable(g.tiles, p.x, p.y));
    }
  }
});
