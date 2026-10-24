'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomStore, GameError, abilityMod } = require('./rooms');
const { roll, DiceError } = require('./dice');
const lib = require('./library');
const adventures = require('./adventures');
const generator = require('./generator');
const mapgen = require('./mapgen');
const aidm = require('./aidm');
const combat = require('./combat');
const narrator = require('./narrator');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days of inactivity
const AUTOMATION_DELAY_MS = Number(process.env.AUTOMATION_DELAY_MS) || 1100;

const ABILITY_NAMES = { str: 'Сила', dex: 'Ловкост', con: 'Издръжливост', int: 'Интелект', wis: 'Мъдрост', cha: 'Харизма' };

// ---- Persistence ----

const store = new RoomStore();

function loadRooms() {
  try {
    store.load(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    store.pruneOlderThan(ROOM_TTL_MS);
    console.log(`Заредени стаи: ${store.rooms.size}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Грешка при зареждане на стаите:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 2000);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store.toJSON()));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('Грешка при запис:', err.message);
  }
}

// ---- HTTP ----

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: store.rooms.size }));

const catalogJson = JSON.stringify(lib.catalog());
app.get('/api/catalog', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('json').send(catalogJson);
});
app.get('/api/monsters/:id', (req, res) => {
  const m = lib.monster(req.params.id);
  return m ? res.json(m) : res.status(404).json({ error: 'not found' });
});
app.get('/api/items/:id', (req, res) => {
  const i = lib.item(req.params.id);
  return i ? res.json(i) : res.status(404).json({ error: 'not found' });
});
app.get('/api/spells/:id', (req, res) => {
  const s = lib.spell(req.params.id);
  return s ? res.json(s) : res.status(404).json({ error: 'not found' });
});
app.get('/api/adventures', (_req, res) => res.json(adventures.list()));
app.get('/api/status', (_req, res) => res.json({ aiNarrator: narrator.enabled() }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

// ---- Broadcasting ----

async function onlineIds(code) {
  const sockets = await io.in(code).fetchSockets();
  return { sockets, ids: new Set(sockets.map((s) => s.data.playerId)) };
}

async function broadcastState(room) {
  const { sockets, ids } = await onlineIds(room.code);
  for (const s of sockets) s.emit('state', store.viewFor(room, s.data.playerId, ids));
  scheduleSave();
}

async function broadcastMessage(room, msg) {
  const sockets = await io.in(room.code).fetchSockets();
  for (const s of sockets) {
    if (store.canSeeMessage(room, s.data.playerId, msg)) s.emit('message', msg);
  }
  scheduleSave();
}

function dmName(room) {
  if (room.mode === 'ai') return '🤖 Водещ';
  const dm = room.players[room.dmId];
  return dm ? `👑 ${dm.name}` : 'Водещ';
}

function postRoll(room, player, expr, { label = '', isPrivate = false } = {}) {
  const result = roll(expr);
  const msg = store.addMessage(room, {
    type: 'roll',
    authorId: player.id,
    author: player.name,
    label: String(label).slice(0, 200),
    result,
    private: isPrivate,
    visibleTo: isPrivate ? [player.id, room.dmId] : null,
  });
  broadcastMessage(room, msg);
  return result;
}

// Posts entries produced by combat / aidm ({type: 'roll'|'narration'}).
function postEntries(room, entries, author = null) {
  for (const e of entries) {
    const msg = e.type === 'roll'
      ? store.addMessage(room, {
        type: 'roll',
        authorId: author ? author.id : room.dmId,
        author: author ? author.name : dmName(room),
        label: String(e.label || '').slice(0, 200),
        result: e.result,
        private: false,
        visibleTo: null,
      })
      : store.addMessage(room, { type: 'narration', author: dmName(room), text: e.text });
    broadcastMessage(room, msg);
  }
}

// In computer-DM games, scene texts are retold by the narrator model when
// one is configured; otherwise the written text is used as is.
function postScene(room, text) {
  if (room.mode !== 'ai' || !narrator.enabled()) {
    postEntries(room, [{ type: 'narration', text }]);
    return;
  }
  narrator.narrateScene(room, text).then((told) => {
    postEntries(room, [{ type: 'narration', text: told || text }]);
  });
}

// ---- Automated turns (monsters, downed heroes) ----

const automation = new Map(); // room code -> timer

function scheduleAutomation(room) {
  if (automation.has(room.code) || !aidm.pendingAutomation(room)) return;
  const timer = setTimeout(async () => {
    automation.delete(room.code);
    const live = store.rooms.get(room.code);
    if (!live) return;
    try {
      const { messages, more } = aidm.step(live, Math.random);
      postEntries(live, messages);
      await broadcastState(live);
      if (more) scheduleAutomation(live);
    } catch (err) {
      console.error('Грешка в автоматичния ход:', err);
    }
  }, AUTOMATION_DELAY_MS);
  automation.set(room.code, timer);
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

function wrapDMError(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof aidm.DMError) throw new GameError(err.message);
    throw err;
  }
}

// ---- Socket handlers ----

function rateLimiter(limit, perMs) {
  let tokens = limit;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(limit, tokens + ((now - last) / perMs) * limit);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

io.on('connection', (socket) => {
  const allow = rateLimiter(30, 1000);

  // Wraps a handler: rate-limits, resolves the socket's room and player,
  // reports errors through the ack callback, re-broadcasts state and lets
  // the computer take any turns that are now due.
  function on(event, handler, { needsRoom = true, broadcast = true } = {}) {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow()) return reply({ ok: false, error: 'Твърде много заявки, изчакай малко' });
      try {
        const data = payload && typeof payload === 'object' ? payload : {};
        let room = null;
        let player = null;
        if (needsRoom) {
          if (!socket.data.code) throw new GameError('Не си в стая');
          room = store.get(socket.data.code);
          player = store.requirePlayer(room, socket.data.playerId);
        }
        const result = await handler(data, room, player);
        if (needsRoom && broadcast) await broadcastState(room);
        if (room) scheduleAutomation(room);
        reply({ ok: true, ...(result || {}) });
      } catch (err) {
        if (err instanceof GameError || err instanceof DiceError) {
          reply({ ok: false, error: err.message });
        } else {
          console.error(`Грешка в ${event}:`, err);
          reply({ ok: false, error: 'Вътрешна грешка' });
        }
      }
    });
  }

  async function enter(room, player) {
    if (socket.data.code && socket.data.code !== room.code) socket.leave(socket.data.code);
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    socket.emit('history', store.logFor(room, player.id));
    await broadcastState(room);
    return { code: room.code, playerId: player.id, secret: player.secret };
  }

  on('room:create', async (data) => {
    const mode = data.mode === 'ai' ? 'ai' : 'human';
    const { room, player } = store.createRoom(data.roomName, data.name, mode);
    store.addMessage(room, { type: 'system', text: `${player.name} създаде кампанията „${room.name}“.` });
    if (mode === 'ai') {
      store.addMessage(room, {
        type: 'narration',
        author: dmName(room),
        text: 'Добре дошли, пътешественици! Аз ще бъда вашият Водещ. Създайте герои (раздел „Герои“), после изберете приключение от раздел „Сесия“ — готово или напълно случайно — и битката ще започне.',
      });
    }
    return enter(room, player);
  }, { needsRoom: false });

  on('room:join', async (data) => {
    const room = store.get(data.code);
    const isNew = !(data.playerId && room.players[data.playerId]);
    const { player } = store.joinRoom(room.code, data.name, data.playerId, data.secret);
    if (isNew) {
      const msg = store.addMessage(room, { type: 'system', text: `${player.name} се присъедини.` });
      broadcastMessage(room, msg);
    }
    return enter(room, player);
  }, { needsRoom: false });

  on('room:leave', async () => {
    const code = socket.data.code;
    if (!code) return;
    socket.leave(code);
    socket.data.code = null;
    socket.data.playerId = null;
    const room = store.rooms.get(code);
    if (room) await broadcastState(room);
  }, { needsRoom: false });

  // ---- Chat & dice ----

  on('chat:send', async (data, room, player) => {
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) return;
    const cmd = /^\/(r|roll|gr|gmroll)\s+(.+)$/i.exec(text);
    if (cmd) {
      const isPrivate = cmd[1].toLowerCase().startsWith('g');
      postRoll(room, player, cmd[2], { isPrivate });
      return;
    }
    const ask = /^(?:@dm|@дм|\/dm|\/дм)\s*(.*)$/is.exec(text);
    if (text.startsWith('/') && !ask) {
      throw new GameError('Непозната команда. Опитай /r 1d20+3, /gr 1d20 (таен хвърлей към DM) или @DM въпрос.');
    }
    const msg = store.addMessage(room, { type: 'chat', authorId: player.id, author: player.name, text });
    broadcastMessage(room, msg);
    if (ask && room.mode === 'ai') {
      const question = ask[1] || text;
      const answer = (await narrator.reply(room, player.name, question)) || narrator.fallbackReply(question);
      postEntries(room, [{ type: 'narration', text: answer }]);
    }
  }, { broadcast: false });

  on('dice:roll', (data, room, player) => {
    postRoll(room, player, data.expr, { label: data.label, isPrivate: Boolean(data.private) });
  }, { broadcast: false });

  on('char:check', (data, room, player) => {
    const c = room.characters[data.characterId];
    if (!c) throw new GameError('Няма такъв герой');
    if (!store.canEditCharacter(room, player.id, c)) throw new GameError('Нямаш права за този герой');
    const ability = data.ability;
    if (!(ability in ABILITY_NAMES)) throw new GameError('Невалидна характеристика');
    let mod = abilityMod(c.abilities[ability]);
    let label = `${c.name}: проверка на ${ABILITY_NAMES[ability]}`;
    if (data.save) {
      if (c.saves[ability]) mod += c.proficiency;
      label = `${c.name}: спасителен хвърлей (${ABILITY_NAMES[ability]})`;
    }
    const dice = data.mode === 'adv' ? '2d20kh1' : data.mode === 'dis' ? '2d20kl1' : '1d20';
    if (data.mode === 'adv') label += ' с предимство';
    if (data.mode === 'dis') label += ' с неудобство';
    postRoll(room, player, `${dice}${signed(mod)}`, { label, isPrivate: Boolean(data.private) });
  }, { broadcast: false });

  // ---- Characters ----

  on('char:create', (data, room, player) => {
    const c = store.createCharacter(room, player.id, data.name, data.build || null);
    if (room.adventure && room.adventure.status !== 'combat') aidm.placeParty(room);
    return { id: c.id };
  });

  on('char:random', (data, room, player) => {
    const count = Math.min(6, Math.max(1, Number.parseInt(data.count, 10) || 1));
    const ids = [];
    for (let i = 0; i < count; i += 1) ids.push(store.createCharacter(room, player.id, '', { random: true }).id);
    if (room.adventure && room.adventure.status !== 'combat') aidm.placeParty(room);
    postEntries(room, [{ type: 'narration', text: `${player.name} събира ${count === 1 ? 'нов герой' : `отряд от ${count} героя`}: ${ids.map((id) => room.characters[id].name).join(', ')}.` }]);
    return { id: ids[0] };
  });

  on('char:update', (data, room, player) => {
    store.updateCharacter(room, player.id, data.id, data.patch);
  });

  on('char:delete', (data, room, player) => {
    store.deleteCharacter(room, player.id, data.id);
  });

  on('char:giveItem', (data, room, player) => {
    const it = store.giveItem(room, player.id, data.characterId, data.itemId);
    postEntries(room, [{ type: 'narration', text: `🎁 ${room.characters[data.characterId].name} получава ${it.name}.` }]);
  });

  on('char:useItem', (data, room, player) => {
    const c = room.characters[data.characterId];
    if (!c) throw new GameError('Няма такъв герой');
    const item = c.items && c.items[Number(data.index)];
    if (!item) throw new GameError('Няма такъв предмет');
    if (!store.canEditCharacter(room, player.id, c)) throw new GameError('Нямаш права за този герой');
    if (item.id === 'magic-potion-of-healing') {
      store.removeItem(room, player.id, c.id, data.index);
      const r = roll('2d4+2');
      c.hp = Math.min(c.maxHp, c.hp + r.total);
      postEntries(room, [{ type: 'roll', label: `${c.name} изпива лечебна отвара`, result: r }], player);
    } else if (/potion|scroll/.test(item.id)) {
      store.removeItem(room, player.id, c.id, data.index);
      postEntries(room, [{ type: 'narration', text: `${c.name} използва ${item.name}.` }]);
    } else {
      postEntries(room, [{ type: 'narration', text: `${c.name} използва ${item.name}.` }]);
    }
  });

  on('char:removeItem', (data, room, player) => {
    store.removeItem(room, player.id, data.characterId, data.index);
  });

  // ---- Map & tokens ----

  on('map:update', (data, room, player) => {
    store.updateMap(room, player.id, data);
  });

  on('map:generate', (data, room, player) => {
    store.requireController(room, player.id);
    if (room.adventure && room.adventure.status === 'combat') throw new GameError('Не може по време на битка');
    const g = mapgen.generate(data.theme, 30, 20, Math.floor(Math.random() * 2 ** 31));
    room.map = { ...room.map, background: '', cols: g.cols, rows: g.rows, tiles: g.tiles, theme: g.theme, areas: g.areas };
    for (const [id, t] of Object.entries(room.tokens)) if (!t.characterId) delete room.tokens[id];
    aidm.placeParty(room);
    store.touch(room);
  });

  on('token:add', (data, room, player) => {
    const t = store.addToken(room, player.id, data);
    return { id: t.id };
  });

  on('token:move', (data, room, player) => {
    store.moveToken(room, player.id, data.id, data.x, data.y);
  });

  on('token:update', (data, room, player) => {
    store.updateToken(room, player.id, data.id, data.patch || {});
    postEntries(room, aidm.checkOutcome(room));
  });

  on('token:remove', (data, room, player) => {
    store.removeToken(room, player.id, data.id);
  });

  // Lets the computer play one monster for the human DM.
  on('token:auto', (data, room, player) => {
    store.requireController(room, player.id);
    const t = room.tokens[data.id];
    if (!t || !t.monsterId) throw new GameError('Изберете чудовище от библиотеката');
    if (t.dead) throw new GameError('Чудовището е повалено');
    postEntries(room, aidm.monsterTurn(room, t, Math.random));
    postEntries(room, aidm.checkOutcome(room));
  });

  on('settings:update', (data, room, player) => {
    store.requireController(room, player.id);
    if ('autoMonsters' in data) room.autoMonsters = room.mode === 'ai' ? true : Boolean(data.autoMonsters);
    store.touch(room);
  });

  // ---- Combat ----

  on('combat:attack', (data, room, player) => {
    const c = room.characters[data.characterId];
    if (!c) throw new GameError('Няма такъв герой');
    if (!store.canEditCharacter(room, player.id, c)) throw new GameError('Нямаш права за този герой');
    if (c.hp <= 0) throw new GameError(`${c.name} е в безсъзнание`);
    const attacker = Object.values(room.tokens).find((t) => t.characterId === c.id);
    if (!attacker) throw new GameError('Постави героя на картата');
    const target = room.tokens[data.targetId];
    if (!target || target.id === attacker.id) throw new GameError('Избери цел на картата');
    if (target.dead) throw new GameError('Целта вече е повалена');
    const weapon = (c.weapons || [])[Number(data.weaponIndex)];
    if (!weapon) throw new GameError('Избери оръжие или заклинание');

    const init = room.initiative;
    const inCombat = init.started && init.entries.length > 0;
    if (inCombat && (room.mode === 'ai' || room.autoMonsters)) {
      const current = aidm.currentEntry(room);
      if (!current || current.characterId !== c.id) throw new GameError('Не е твой ход');
      if (init.acted) throw new GameError('Вече атакува този ход — натисни „Край на хода“');
    }
    if (!combat.inRange(attacker, target, weapon)) throw new GameError('Целта е извън обхват — приближи се');
    const defender = combat.combatant(room, target);
    const { messages } = combat.resolveAttack(room, c.name, weapon, defender, Math.random);
    postEntries(room, messages, player);
    if (inCombat) init.acted = true;
    postEntries(room, aidm.checkOutcome(room));
    store.touch(room);
  });

  on('combat:feature', (data, room, player) => {
    const c = room.characters[data.characterId];
    if (!c) throw new GameError('Няма такъв герой');
    if (!store.canEditCharacter(room, player.id, c)) throw new GameError('Нямаш права за този герой');
    if (c.hp <= 0) throw new GameError(`${c.name} е в безсъзнание`);
    const feature = (c.features || [])[Number(data.featureIndex)];
    if (!feature) throw new GameError('Няма такова умение');
    if (feature.uses <= 0) throw new GameError(`${feature.name}: няма оставащи използвания — починете си`);
    const me = Object.values(room.tokens).find((t) => t.characterId === c.id);
    const targetToken = feature.self ? me : room.tokens[data.targetId];
    if (!targetToken || !targetToken.characterId) throw new GameError('Избери герой, когото да излекуваш');
    if (me && !feature.self && combat.distance(me, targetToken) * 5 > feature.range) {
      throw new GameError('Целта е твърде далеч — приближи се');
    }

    const init = room.initiative;
    const inCombat = init.started && init.entries.length > 0;
    const flag = feature.bonus ? 'bonusActed' : 'acted';
    if (inCombat && (room.mode === 'ai' || room.autoMonsters)) {
      const current = aidm.currentEntry(room);
      if (!current || current.characterId !== c.id) throw new GameError('Не е твой ход');
      if (init[flag]) throw new GameError(feature.bonus ? 'Вече използва бонус действие този ход' : 'Вече използва действието си този ход');
    }
    feature.uses -= 1;
    postEntries(room, combat.useHeal(feature, c.name, combat.combatant(room, targetToken), Math.random), player);
    if (inCombat) init[flag] = true;
    store.touch(room);
  });

  // ---- Initiative ----

  on('init:add', (data, room, player) => {
    const entry = { ...data };
    if (data.roll) {
      store.requireDM(room, player.id);
      const name = String(data.name || 'Противник').slice(0, 40);
      const result = postRoll(room, player, '1d20', { label: `${name}: инициатива`, isPrivate: true });
      entry.value = result.total;
    }
    store.addInitiative(room, player.id, entry);
  });

  on('init:roll', (data, room, player) => {
    const c = room.characters[data.characterId];
    if (!c) throw new GameError('Няма такъв герой');
    if (!store.canEditCharacter(room, player.id, c)) throw new GameError('Нямаш права за този герой');
    const result = postRoll(room, player, `1d20${signed(abilityMod(c.abilities.dex))}`, {
      label: `${c.name}: инициатива`,
    });
    const token = Object.values(room.tokens).find((t) => t.characterId === c.id);
    store.addInitiative(room, player.id, { characterId: c.id, value: result.total, tokenId: token && token.id });
  });

  on('init:remove', (data, room, player) => store.removeInitiative(room, player.id, data.id));
  on('init:next', (_data, room, player) => store.nextTurn(room, player.id));
  on('init:prev', (_data, room, player) => store.prevTurn(room, player.id));
  on('init:clear', (_data, room, player) => store.clearInitiative(room, player.id));

  // Ends the current turn when it belongs to one of the player's heroes.
  on('init:end', (_data, room, player) => {
    const current = aidm.currentEntry(room);
    if (!current) throw new GameError('Няма активна битка');
    const c = current.characterId && room.characters[current.characterId];
    const mine = c && c.ownerId === player.id;
    if (!mine && !store.isController(room, player.id)) throw new GameError('Не е твой ход');
    aidm.advanceTurn(room);
    const next = aidm.currentEntry(room);
    if (next && next.characterId && !aidm.pendingAutomation(room)) {
      postEntries(room, [{ type: 'narration', text: `➡️ На ход е ${next.name}.` }]);
    }
    store.touch(room);
  });

  // ---- Adventures (ready-made or random) ----

  on('adventure:load', (data, room, player) => {
    store.requireController(room, player.id);
    let adv;
    if (data.random) {
      const party = Object.keys(room.characters).length || 4;
      const avgLevel = Math.round(Object.values(room.characters).reduce((s, c) => s + c.level, 0) / (Object.keys(room.characters).length || 1)) || 1;
      adv = generator.generate({
        level: data.random.level || avgLevel,
        partySize: data.random.partySize || party,
        theme: data.random.theme,
        encounters: data.random.encounters,
      });
    } else {
      adv = adventures.get(String(data.id || ''));
      if (!adv) throw new GameError('Няма такова приключение');
    }
    const [title, intro] = wrapDMError(() => aidm.loadAdventure(room, adv));
    postEntries(room, [title]);
    postScene(room, intro.text);
    store.touch(room);
  });

  on('adventure:next', (_data, room, player) => {
    store.requireController(room, player.id);
    const [title, scene, order] = wrapDMError(() => aidm.startEncounter(room, Math.random));
    postEntries(room, [title]);
    postScene(room, scene.text);
    postEntries(room, [order]);
    const first = aidm.currentEntry(room);
    if (first && first.characterId) postEntries(room, [{ type: 'narration', text: `➡️ Пръв е ${first.name}.` }]);
    store.touch(room);
  });

  on('adventure:rest', (_data, room, player) => {
    store.requireController(room, player.id);
    postEntries(room, wrapDMError(() => aidm.rest(room)));
    store.touch(room);
  });

  on('adventure:retry', (_data, room, player) => {
    store.requireController(room, player.id);
    postEntries(room, wrapDMError(() => aidm.retry(room, Math.random)));
    store.touch(room);
  });

  on('adventure:clear', (_data, room, player) => {
    store.requireController(room, player.id);
    room.adventure = null;
    room.initiative = { entries: [], turn: 0, round: 1, started: false, acted: false };
    for (const [id, t] of Object.entries(room.tokens)) if (!t.characterId) delete room.tokens[id];
    store.touch(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.code;
    const room = code && store.rooms.get(code);
    if (room) broadcastState(room).catch(() => {});
  });
});

// ---- Startup / shutdown ----

loadRooms();
setInterval(() => store.pruneOlderThan(ROOM_TTL_MS), 6 * 60 * 60 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveNow();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`D&D платформата работи на http://localhost:${PORT}`);
  console.log(narrator.enabled() ? 'AI разказвач: включен (Claude)' : 'AI разказвач: изключен (няма ANTHROPIC_API_KEY) — ползват се готови текстове');
});
