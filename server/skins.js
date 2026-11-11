'use strict';

// "Ателие за облик": a stylist bot that turns a hero's sheet and the
// player's wishes into a skin for the 3D figure. Uses Claude (structured
// output) when configured and a keyword parser otherwise.

const narrator = require('./narrator');

const HEADWEAR = ['auto', 'hood', 'hat', 'wideHat', 'helm', 'crown', 'none'];
const CLOAK = ['long', 'short', 'none'];
const PROPS = ['auto', 'sword', 'greataxe', 'hammer', 'mace', 'staff', 'druidstaff', 'bow', 'daggers', 'lute', 'fiddle', 'orbs', 'tome', 'none'];
const COLOR_FIELDS = ['coat', 'trim', 'skin', 'hair', 'eyes', 'armor', 'horns', 'glow'];
const BOOL_FIELDS = ['ears', 'beard', 'tusks', 'shield'];

const HEX = { type: 'string', description: 'Colour as #rrggbb, "none" to remove, or "auto" for the default.' };
const TRI = { type: 'string', enum: ['auto', 'yes', 'no'] };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'skin'],
  properties: {
    reply: { type: 'string', description: 'Short answer to the player in Bulgarian (1-3 sentences).' },
    skin: {
      type: 'object',
      additionalProperties: false,
      required: [...COLOR_FIELDS, 'headwear', 'cloak', 'prop', ...BOOL_FIELDS],
      properties: {
        coat: { ...HEX, description: 'Long coat / cloak colour. #rrggbb or auto.' },
        trim: { ...HEX, description: 'Scarf, sash and hat band colour. #rrggbb or auto.' },
        skin: { ...HEX, description: 'Skin tone. #rrggbb or auto.' },
        hair: { ...HEX, description: 'Hair or beard colour. #rrggbb or auto.' },
        eyes: { ...HEX, description: 'Glowing eye colour #rrggbb, or "none" for ordinary eyes, or auto.' },
        armor: { ...HEX, description: 'Armour metal colour #rrggbb, "none" for no armour, or auto.' },
        horns: { ...HEX, description: 'Horn colour #rrggbb, "none" for no horns, or auto.' },
        glow: { ...HEX, description: 'Magic glow colour of staffs, orbs and runes. #rrggbb or auto.' },
        headwear: { type: 'string', enum: HEADWEAR },
        cloak: { type: 'string', enum: CLOAK },
        prop: { type: 'string', enum: PROPS, description: 'Weapon or item in hand.' },
        ears: { ...TRI, description: 'Pointed ears.' },
        beard: TRI,
        tusks: TRI,
        shield: TRI,
      },
    },
  },
};

const SYSTEM = `Ти си шивач и художник на облици в онлайн D&D играта „Таверната“.
Фигурите са в мрачен, рисуван фентъзи стил: изпити, издължени силуети, дълги парцаливи палта, шалове и широкополи шапки.
От листа на героя и желанията на играча избираш облика на 3D фигурката му: цветове (#rrggbb), шапка или шлем, наметало, броня, оръжие, рога, уши, брада, светещи очи.
Правила:
- Пиши отговора (reply) на български, кратко и приятелски: какво промени и защо.
- Запазвай досегашния облик и променяй само това, което играчът иска; за неупоменати полета върни текущата им стойност или "auto".
- Подбирай хармонични, наситени, но мрачни цветове; светенето (glow, eyes) е за магия и нежит.
- Ако играчът поиска облик на известен персонаж от филм, сериал, игра или книга, не го копирай: направи оригинален облик, вдъхновен само от общото настроение и цветовете, и го кажи накратко.
- Ако желанието не може да се покаже (например татуировки), предложи най-близкото възможно.`;

// ---------------------------------------------------------------------------

function normColor(v) {
  const s = String(v ?? 'auto').trim().toLowerCase();
  if (s === 'none' || s === 'auto') return s;
  return /^#[0-9a-f]{6}$/.test(s) ? s : 'auto';
}

function sanitizeSkin(skin, prev = {}) {
  const out = {};
  const src = skin && typeof skin === 'object' ? skin : {};
  for (const f of COLOR_FIELDS) out[f] = normColor(f in src ? src[f] : prev[f]);
  out.headwear = HEADWEAR.includes(src.headwear) ? src.headwear : (prev.headwear || 'auto');
  out.cloak = CLOAK.includes(src.cloak) ? src.cloak : (prev.cloak || 'long');
  out.prop = PROPS.includes(src.prop) ? src.prop : (prev.prop || 'auto');
  for (const f of BOOL_FIELDS) {
    const v = f in src ? src[f] : prev[f];
    out[f] = ['yes', 'no'].includes(v) ? v : 'auto';
  }
  return out;
}

function defaultSkin() {
  return sanitizeSkin({});
}

function sheetText(c) {
  return [
    `Име: ${c.name}`, `Раса: ${c.race || '—'}`, `Клас: ${c.cls || '—'} (ниво ${c.level})`,
    `Цвят на играча: ${c.color}`,
    c.notes ? `Описание/бележки: ${String(c.notes).slice(0, 1200)}` : null,
    c.inventory ? `Екипировка: ${String(c.inventory).slice(0, 500)}` : null,
    (c.weapons || []).length ? `Оръжия: ${c.weapons.map((w) => w.name).join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

// ---- keyword stylist (works without any AI model) ----

const COLORS = [
  [/тъмночерв|бордо|кървав|crimson|blood/, '#6a1420', 'тъмночервено'], [/черв|алено|red/, '#a82a2a', 'червено'],
  [/черн|black|мрак/, '#1c161c', 'черно'], [/бял|бяло|бели|white|снеж/, '#e8e2d6', 'бяло'],
  [/тъмносин|морск|navy/, '#1c2a5a', 'тъмносиньо'], [/син|сини|blue/, '#2a4a9a', 'синьо'], [/тюркоаз|аква|teal|cyan/, '#2fb8b0', 'тюркоазено'],
  [/тъмнозел|маслин|olive/, '#3a4a22', 'маслинено'], [/зел|green/, '#2f6a3a', 'зелено'], [/лилав|виолет|пурпур|purple/, '#5a2a7a', 'лилаво'],
  [/злат|gold/, '#d4a24c', 'златно'], [/сребр|сребър|silver/, '#b8c0cc', 'сребърно'], [/бронз|мед|bronze|copper/, '#a86a3a', 'бронзово'],
  [/кафяв|кафяво|brown/, '#5a3a22', 'кафяво'], [/сив|сиво|grey|gray|пепел/, '#6a6a70', 'сиво'], [/розов|pink/, '#d65a9a', 'розово'],
  [/оранж|orange/, '#d07a2a', 'оранжево'], [/риж|ginger/, '#a8502a', 'рижаво'], [/жълт|yellow/, '#d8c040', 'жълто'],
];
const TARGETS = [
  ['eyes', /(^|[^а-яё])оч[иа]|eye/], ['armor', /брон|доспех|armou?r|ризниц/], ['horns', /рог|horn/],
  ['hair', /кос[аи]|брад(?!в)|hair/], ['skin', /кож|лице|skin/], ['glow', /свет|магия|сия|glow|руни/],
  ['trim', /шал|кант|колан|акцент|лента|trim|scarf|sash/], ['coat', /палт|наметал|плащ|дрех|роб|мантия|coat|cloak|robe/],
];
const PROP_WORDS = [
  ['greataxe', /брадв|axe/], ['hammer', /чук|hammer/], ['mace', /боздуган|mace/], ['druidstaff', /клон|дървен жезъл/],
  ['staff', /жезъл|тояга|staff/], ['bow', /лък|bow/], ['daggers', /кинжал|нож|dagger/], ['fiddle', /цигулк|fiddle|violin/],
  ['lute', /лютн|китар|lute/], ['orbs', /кълб|orb/], ['tome', /книг|том|tome|book/], ['sword', /меч|sword|сабя/],
];

const PROP_BG = {
  greataxe: 'бойна брадва', hammer: 'боен чук', mace: 'боздуган', druidstaff: 'дървен жезъл', staff: 'магически жезъл',
  bow: 'лък', daggers: 'кинжали', fiddle: 'цигулка', lute: 'лютня', orbs: 'светещи кълба', tome: 'магическа книга', sword: 'меч',
};

function colorIn(text) {
  const hit = COLORS.find(([re]) => re.test(text));
  return hit ? { hex: hit[1], label: hit[2] } : null;
}

function fallbackStylist(c, text, prev) {
  const skin = sanitizeSkin({}, prev);
  const said = [];
  const lower = String(text || '').toLowerCase();
  const clauses = lower.split(/[,.;!?]|\sи\s|\sс\s|\sна\s/);
  for (const clause of clauses) {
    const color = colorIn(clause);
    const target = TARGETS.find(([, re]) => re.test(clause));
    const negative = /без|махни|не искам|no |remove/.test(clause);
    if (target) {
      const [field] = target;
      if (negative && ['armor', 'horns', 'eyes'].includes(field)) {
        skin[field] = 'none';
        said.push(`махнах ${field === 'armor' ? 'бронята' : field === 'horns' ? 'рогата' : 'светенето на очите'}`);
      } else if (color) {
        skin[field] = color.hex;
        said.push(`${({ coat: 'палто', trim: 'шал', skin: 'кожа', hair: 'коса', eyes: 'светещи очи', armor: 'броня', horns: 'рога', glow: 'магия' })[field]}: ${color.label}`);
      } else if (field === 'horns' && !negative) {
        skin.horns = '#2a1a22';
        said.push('добавих рога');
      } else if (field === 'eyes' && /свет/.test(clause)) {
        skin.eyes = '#7fe7ff';
        said.push('очите светят');
      }
    }
    if (/качулк|hood/.test(clause)) { skin.headwear = negative ? 'none' : 'hood'; said.push('качулка'); }
    else if (/широк|периферия|wide/.test(clause) && /шапк|hat/.test(clause)) { skin.headwear = 'wideHat'; said.push('широкопола шапка'); }
    else if (/магьосн|остра шапк|pointed/.test(clause) && /шапк|hat/.test(clause)) { skin.headwear = 'hat'; said.push('магьосническа шапка'); }
    else if (/шлем|helm/.test(clause)) { skin.headwear = negative ? 'none' : 'helm'; said.push('шлем'); }
    else if (/корон|crown/.test(clause)) { skin.headwear = negative ? 'none' : 'crown'; said.push('корона'); }
    else if (/шапк|hat/.test(clause) && negative) { skin.headwear = 'none'; said.push('без шапка'); }
    if (/(палт|наметал|плащ)/.test(clause) && /кратк|късо|short/.test(clause)) { skin.cloak = 'short'; said.push('късо наметало'); }
    if (/(палт|наметал|плащ)/.test(clause) && negative) { skin.cloak = 'none'; said.push('без наметало'); }
    if (/уш|ears/.test(clause)) skin.ears = negative ? 'no' : 'yes';
    if (/брад(?!в)|beard/.test(clause)) {
      skin.beard = negative ? 'no' : 'yes';
      if (!negative) said.push('брада');
    }
    if (/бивн|tusk/.test(clause)) skin.tusks = negative ? 'no' : 'yes';
    if (/щит|shield/.test(clause)) skin.shield = negative ? 'no' : 'yes';
    const prop = PROP_WORDS.find(([, re]) => re.test(clause));
    if (prop && !negative) { skin.prop = prop[0]; said.push(`в ръката: ${PROP_BG[prop[0]]}`); }
  }
  // a colour with no target: paint the coat
  if (!said.length) {
    const color = colorIn(lower);
    if (color) {
      skin.coat = color.hex;
      said.push(`палто: ${color.label}`);
    }
  }
  const reply = said.length
    ? `Готово: ${[...new Set(said)].join(', ')}. Кажи ми, ако искаш още промени.`
    : 'Опиши ми какво искаш — например „тъмночервено палто, сребърна броня, качулка и светещи сини очи“ или „дай му лък и широкопола шапка“.';
  return { reply, skin };
}

// Suggests a look from the sheet alone (keyword pass over the description).
function fromSheet(c, prev) {
  const desc = `${c.notes || ''} ${c.inventory || ''}`;
  const { skin } = fallbackStylist(c, desc, prev);
  return {
    reply: `Прочетох листа на ${c.name} и подбрах облик по описанието му. Кажи ми какво да променя.`,
    skin,
  };
}

async function style(c, text, { fromSheetOnly = false } = {}) {
  const prev = sanitizeSkin(c.skin || {});
  const history = (c.skinChat || []).slice(-8).map((m) => `${m.role === 'user' ? 'Играч' : 'Шивач'}: ${m.text}`).join('\n');
  const ask = fromSheetOnly
    ? 'Предложи облик, който отговаря на листа и описанието на героя.'
    : `Желание на играча: „${String(text).slice(0, 600)}“`;
  const content = `Лист на героя:\n${sheetText(c)}\n\nТекущ облик (JSON): ${JSON.stringify(prev)}\n${history ? `\nДосегашен разговор:\n${history}\n` : ''}\n${ask}`;
  const ai = await narrator.structured(SYSTEM, content, SCHEMA, 1500);
  if (ai && ai.skin) {
    return { reply: String(ai.reply || 'Готово.').slice(0, 600), skin: sanitizeSkin(ai.skin, prev), ai: true };
  }
  const out = fromSheetOnly ? fromSheet(c, prev) : fallbackStylist(c, text, prev);
  return { ...out, skin: sanitizeSkin(out.skin, prev), ai: false };
}

module.exports = { style, sanitizeSkin, defaultSkin, fallbackStylist, SCHEMA };
