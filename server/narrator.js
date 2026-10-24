'use strict';

// Optional Claude-powered narration for the computer DM. Enabled when
// Anthropic credentials are configured (ANTHROPIC_API_KEY or
// ANTHROPIC_AUTH_TOKEN); otherwise every call resolves to null and the
// game falls back to the written texts.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_DM_MODEL || 'claude-opus-5-5';

const SYSTEM = `Ти си Водещият (Dungeon Master) на игра по Dungeons & Dragons 5e, която се играе онлайн.
Пиши винаги на български език, във второ лице множествено число към героите, живо и атмосферно.
Бъди кратък: 2–5 изречения, без списъци и без заглавия.
Правилата и боят се изчисляват от играта — не измисляй резултати от зарове, щети или точки живот.
Когато играч опише действие с несигурен изход, опиши ситуацията и поискай конкретна проверка във формата
„Хвърли проверка на <характеристика> (DC <число>)“ — характеристиките са Сила, Ловкост, Издръжливост, Интелект, Мъдрост и Харизма.
Не разкривай тайната (обрата) на историята, докато приключението не завърши.`;

let client = null;
let disabled = !(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) || process.env.AI_DM === 'off';

function enabled() {
  return !disabled;
}

function getClient() {
  if (!client) client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
  return client;
}

function describeRoom(room) {
  const adv = room.adventure;
  const lines = [];
  if (adv) {
    lines.push(`Приключение: „${adv.title}“ (ниво ${adv.level}). ${adv.summary}`);
    if (adv.twist) lines.push(`Тайна (не я разкривай): ${adv.twist}`);
    const enc = adv.encounters[adv.index];
    if (enc) lines.push(`Текуща среща: ${enc.title} — ${enc.text} (състояние: ${adv.status})`);
  }
  const party = Object.values(room.characters)
    .map((c) => `${c.name} — ${c.race} ${c.cls} ниво ${c.level}, HP ${c.hp}/${c.maxHp}`);
  if (party.length) lines.push(`Отряд: ${party.join('; ')}`);
  const foes = Object.values(room.tokens).filter((t) => t.monsterId && !t.dead).map((t) => t.label);
  if (foes.length) lines.push(`Врагове на картата: ${foes.join(', ')}`);
  const recent = room.log.slice(-12)
    .filter((m) => m.type === 'chat' || m.type === 'narration')
    .map((m) => (m.type === 'chat' ? `${m.author}: ${m.text}` : `Водещ: ${m.text}`));
  if (recent.length) lines.push(`Последно в чата:\n${recent.join('\n')}`);
  return lines.join('\n');
}

async function ask(room, instruction) {
  if (disabled) return null;
  try {
    const response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{ role: 'user', content: `${describeRoom(room)}\n\n${instruction}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('AI водещ: невалидни данни за достъп — изключвам разказвача.');
      disabled = true;
    } else if (err instanceof Anthropic.APIError) {
      console.error(`AI водещ: грешка ${err.status}: ${err.message}`);
    } else {
      console.error('AI водещ:', err.message);
    }
    return null;
  }
}

const narrateScene = (room, sceneText) => ask(room, `Разкажи драматично тази сцена, като запазиш фактите: ${sceneText}`);

const reply = (room, playerName, text) => ask(room, `Играчът ${playerName} казва или прави: „${text}“. Отговори като Водещ.`);

// Rule-based answer used when no model is configured.
const CHECKS = [
  [/скач|бута|вдига|счупи|разбива|кат(е|я)р|плува/i, 'Сила', 12],
  [/промък|скри|краде|отключ|ключалк|балансира|избяга/i, 'Ловкост', 13],
  [/убед|говор|преговар|лъж|заплаш|молим|питам|пита/i, 'Харизма', 12],
  [/търс|огледа|слуша|наблюдава|следи|забележ/i, 'Мъдрост', 12],
  [/спомн|знам|разчет|руни|магия|история|изуча/i, 'Интелект', 13],
];

function fallbackReply(text) {
  for (const [re, ability, dc] of CHECKS) {
    if (re.test(text)) return `Водещият се замисля… Опитай! Хвърли проверка на ${ability} (DC ${dc}).`;
  }
  const generic = [
    'Сенките трептят около вас. Какво ще направите сега?',
    'Тишината е напрегната — сякаш някой ви наблюдава. Бъдете нащрек.',
    'Пътят продължава напред. Нещо ви казва, че най-трудното предстои.',
    'Чувате далечен шум — може би вятър, а може би нещо друго.',
  ];
  return generic[Math.floor(Math.random() * generic.length)];
}

module.exports = { enabled, narrateScene, reply, fallbackReply, describeRoom };
