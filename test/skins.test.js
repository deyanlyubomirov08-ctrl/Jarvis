'use strict';

const test = require('node:test');
const assert = require('node:assert');
const skins = require('../server/skins');

test('keyword stylist understands colours, headwear, props and removals', () => {
  const { skin, reply } = skins.fallbackStylist({}, 'тъмночервено палто, сребърна броня, качулка и светещи сини очи', {});
  assert.strictEqual(skin.coat, '#6a1420');
  assert.strictEqual(skin.armor, '#b8c0cc');
  assert.strictEqual(skin.headwear, 'hood');
  assert.strictEqual(skin.eyes, '#2a4a9a');
  assert.match(reply, /палто: тъмночервено/);

  const second = skins.fallbackStylist({}, 'без броня, дай му брадва и рижа брада', skin);
  assert.strictEqual(second.skin.armor, 'none');
  assert.strictEqual(second.skin.prop, 'greataxe');
  assert.strictEqual(second.skin.hair, '#a8502a');
  assert.strictEqual(second.skin.beard, 'yes');
  assert.strictEqual(second.skin.coat, '#6a1420', 'earlier choices are kept');
});

test('words that merely contain a keyword do not trigger it', () => {
  // "тъмноЧЕРВено" contains "оч" (eyes); "брадва" contains "брад" (beard)
  const { skin } = skins.fallbackStylist({}, 'тъмночервено наметало и брадва', {});
  assert.strictEqual(skin.eyes, 'auto');
  assert.strictEqual(skin.beard, 'auto');
  assert.strictEqual(skin.coat, '#6a1420');
});

test('sanitizeSkin rejects junk values', () => {
  const s = skins.sanitizeSkin({ coat: 'javascript:alert(1)', headwear: 'tophat', prop: 'bazooka', beard: true, eyes: '#ABCDEF' });
  assert.strictEqual(s.coat, 'auto');
  assert.strictEqual(s.headwear, 'auto');
  assert.strictEqual(s.prop, 'auto');
  assert.strictEqual(s.beard, 'auto');
  assert.strictEqual(s.eyes, '#abcdef');
});

test('style() falls back to the sheet when no AI model is configured', async () => {
  const c = { name: 'Морана', race: 'Тифлинг', cls: 'Вещер', level: 1, color: '#e74c3c', notes: 'Носи тъмносиньо наметало и сребърна корона.' };
  const r = await skins.style(c, '', { fromSheetOnly: true });
  assert.strictEqual(r.ai, false);
  assert.strictEqual(r.skin.coat, '#1c2a5a');
  assert.strictEqual(r.skin.headwear, 'crown');
});
