'use strict';

// Dice notation parser and roller.
// Supported: "d20", "2d6+3", "4d6kh3", "2d20kl1", "8d6dl2", "1d8+1d6-1", "d%".
// kh/kl = keep highest/lowest N, dh/dl = drop highest/lowest N.

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_TERMS = 20;

class DiceError extends Error {}

function defaultRng(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

function tokenize(input) {
  const src = String(input || '').toLowerCase().replace(/\s+/g, '');
  if (!src) throw new DiceError('Празен израз за зарове');
  if (src.length > 200) throw new DiceError('Изразът е твърде дълъг');

  const termRe = /^(\d*)d(\d+|%)(?:(kh|kl|dh|dl|k|d)(\d+))?|^(\d+)/;
  const terms = [];
  let i = 0;
  let sign = 1;
  let expectTerm = true;

  while (i < src.length) {
    const ch = src[i];
    if (!expectTerm) {
      if (ch === '+' || ch === '-') {
        sign = ch === '-' ? -1 : 1;
        expectTerm = true;
        i += 1;
        continue;
      }
      throw new DiceError(`Неочакван символ "${ch}"`);
    }
    if (ch === '+' || ch === '-') {
      // Leading sign, e.g. "-1" or "+d4".
      if (terms.length === 0 && sign === 1) {
        sign = ch === '-' ? -1 : 1;
        i += 1;
        continue;
      }
      throw new DiceError('Два поредни оператора');
    }
    const m = termRe.exec(src.slice(i));
    if (!m) throw new DiceError(`Невалиден израз при "${src.slice(i)}"`);

    if (m[5] !== undefined) {
      terms.push({ type: 'const', sign, value: parseInt(m[5], 10) });
    } else {
      const count = m[1] === '' ? 1 : parseInt(m[1], 10);
      const sides = m[2] === '%' ? 100 : parseInt(m[2], 10);
      let mod = null;
      if (m[3]) {
        const kind = m[3] === 'k' ? 'kh' : m[3] === 'd' ? 'dl' : m[3];
        mod = { kind, n: parseInt(m[4], 10) };
      }
      if (count < 1 || count > MAX_DICE) throw new DiceError(`Броят зарове трябва да е между 1 и ${MAX_DICE}`);
      if (sides < 2 || sides > MAX_SIDES) throw new DiceError(`Стените трябва да са между 2 и ${MAX_SIDES}`);
      if (mod && (mod.n < 0 || mod.n > count)) throw new DiceError('Невалиден брой за пазене/махане');
      terms.push({ type: 'dice', sign, count, sides, mod });
    }
    if (terms.length > MAX_TERMS) throw new DiceError('Твърде много членове');
    i += m[0].length;
    sign = 1;
    expectTerm = false;
  }
  if (expectTerm) throw new DiceError('Изразът завършва с оператор');
  return terms;
}

function applyModifier(values, mod) {
  const rolls = values.map((value) => ({ value, kept: true }));
  if (!mod) return rolls;
  const order = rolls
    .map((r, idx) => ({ value: r.value, idx }))
    .sort((a, b) => a.value - b.value || a.idx - b.idx);
  const n = values.length;
  let dropIdx = [];
  switch (mod.kind) {
    case 'kh': dropIdx = order.slice(0, n - mod.n); break;
    case 'kl': dropIdx = order.slice(mod.n); break;
    case 'dh': dropIdx = order.slice(n - mod.n); break;
    case 'dl': dropIdx = order.slice(0, mod.n); break;
    default: break;
  }
  for (const d of dropIdx) rolls[d.idx].kept = false;
  return rolls;
}

function roll(expression, rng = defaultRng) {
  const terms = tokenize(expression);
  let total = 0;
  const parts = terms.map((t) => {
    if (t.type === 'const') {
      total += t.sign * t.value;
      return { type: 'const', sign: t.sign, value: t.value };
    }
    const values = [];
    for (let k = 0; k < t.count; k += 1) values.push(rng(t.sides));
    const rolls = applyModifier(values, t.mod);
    const subtotal = rolls.filter((r) => r.kept).reduce((s, r) => s + r.value, 0);
    total += t.sign * subtotal;
    return {
      type: 'dice',
      sign: t.sign,
      count: t.count,
      sides: t.sides,
      mod: t.mod,
      rolls,
      subtotal,
    };
  });

  const d20 = parts.find((p) => p.type === 'dice' && p.sides === 20);
  let crit = null;
  if (d20) {
    const kept = d20.rolls.filter((r) => r.kept);
    if (kept.length === 1) {
      if (kept[0].value === 20) crit = 'success';
      else if (kept[0].value === 1) crit = 'fail';
    }
  }

  return { expression: normalize(terms), total, parts, crit };
}

function normalize(terms) {
  return terms
    .map((t, idx) => {
      const sign = t.sign < 0 ? '-' : idx === 0 ? '' : '+';
      if (t.type === 'const') return `${sign}${t.value}`;
      const mod = t.mod ? `${t.mod.kind}${t.mod.n}` : '';
      return `${sign}${t.count}d${t.sides}${mod}`;
    })
    .join('');
}

module.exports = { roll, tokenize, DiceError };
