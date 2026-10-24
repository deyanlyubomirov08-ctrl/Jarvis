'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomStore, GameError, abilityMod } = require('./rooms');
const { roll, DiceError } = require('./dice');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days of inactivity

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

function postRoll(room, player, expr, { label = '', isPrivate = false } = {}) {
  const result = roll(expr);
  const msg = store.addMessage(room, {
    type: 'roll',
    authorId: player.id,
    author: player.name,
    label: String(label).slice(0, 80),
    result,
    private: isPrivate,
    visibleTo: isPrivate ? [player.id, room.dmId] : null,
  });
  broadcastMessage(room, msg);
  return result;
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
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
  // reports errors through the ack callback and re-broadcasts state.
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
    const { room, player } = store.createRoom(data.roomName, data.name);
    store.addMessage(room, { type: 'system', text: `${player.name} създаде кампанията „${room.name}“.` });
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

  on('chat:send', (data, room, player) => {
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) return;
    const cmd = /^\/(r|roll|gr|gmroll)\s+(.+)$/i.exec(text);
    if (cmd) {
      const isPrivate = cmd[1].toLowerCase().startsWith('g');
      postRoll(room, player, cmd[2], { isPrivate });
      return;
    }
    if (text.startsWith('/')) throw new GameError('Непозната команда. Опитай /r 1d20+3 или /gr 1d20 (таен хвърлей към DM).');
    const msg = store.addMessage(room, { type: 'chat', authorId: player.id, author: player.name, text });
    broadcastMessage(room, msg);
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
    const c = store.createCharacter(room, player.id, data.name);
    return { id: c.id };
  });

  on('char:update', (data, room, player) => {
    store.updateCharacter(room, player.id, data.id, data.patch);
  });

  on('char:delete', (data, room, player) => {
    store.deleteCharacter(room, player.id, data.id);
  });

  // ---- Map & tokens ----

  on('map:update', (data, room, player) => {
    store.updateMap(room, player.id, data);
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
  });

  on('token:remove', (data, room, player) => {
    store.removeToken(room, player.id, data.id);
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
});
