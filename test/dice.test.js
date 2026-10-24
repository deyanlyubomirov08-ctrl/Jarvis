'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { roll, DiceError } = require('../server/dice');

// Deterministic rng that returns values from a list.
const seq = (...values) => () => values.shift();

test('rolls simple expression with modifier', () => {
  const r = roll('2d6+3', seq(4, 5));
  assert.strictEqual(r.total, 12);
  assert.strictEqual(r.expression, '2d6+3');
});

test('implicit single die and percentile', () => {
  assert.strictEqual(roll('d20', seq(7)).total, 7);
  assert.strictEqual(roll('d%', seq(42)).parts[0].sides, 100);
});

test('keep highest / lowest (advantage, disadvantage)', () => {
  assert.strictEqual(roll('2d20kh1', seq(3, 17)).total, 17);
  assert.strictEqual(roll('2d20kl1', seq(3, 17)).total, 3);
});

test('drop lowest for ability scores', () => {
  const r = roll('4d6dl1', seq(1, 6, 4, 3));
  assert.strictEqual(r.total, 13);
  assert.deepStrictEqual(r.parts[0].rolls.map((x) => x.kept), [false, true, true, true]);
});

test('negative terms and leading sign', () => {
  assert.strictEqual(roll('1d8-1d4-2', seq(8, 3)).total, 3);
  assert.strictEqual(roll('-1+d4', seq(2)).total, 1);
});

test('detects natural 20 and natural 1 on a single kept d20', () => {
  assert.strictEqual(roll('1d20+5', seq(20)).crit, 'success');
  assert.strictEqual(roll('2d20kl1', seq(1, 15)).crit, 'fail');
  assert.strictEqual(roll('1d20', seq(10)).crit, null);
});

test('rejects invalid input', () => {
  for (const bad of ['', 'abc', '2d', '1d20++3', '1d20+', '1000d6', '1d1', '2d20kh3', '1d20 ; rm']) {
    assert.throws(() => roll(bad), DiceError, bad);
  }
});

test('real rng stays within bounds', () => {
  for (let i = 0; i < 500; i += 1) {
    const t = roll('1d6').total;
    assert.ok(t >= 1 && t <= 6);
  }
});
