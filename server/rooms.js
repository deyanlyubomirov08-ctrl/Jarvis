'use strict';

const crypto = require('crypto');

// Room (campaign) state and all game-rule mutations. Kept free of networking
// so it can be unit-tested and persisted as plain JSON.

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const TOKEN_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#ecf0f1'];
const MAX_LOG = 300;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class GameError extends Error {}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function str(value, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).slice(0, max);
}

function int(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function color(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value)) ? value : fallback;
}

function url(value) {
  const s = str(value, 2000).trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function newCharacter(ownerId, name, colorIdx) {
  return {
    id: id(),
    ownerId,
    name: str(name, 60, 'Нов герой') || 'Нов герой',
    race: '',
    cls: '',
    level: 1,
    hp: 10,
    maxHp: 10,
    tempHp: 0,
    ac: 10,
    speed: 30,
    proficiency: 2,
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saves: { str: false, dex: false, con: false, int: false, wis: false, cha: false },
    attacks: '',
    inventory: '',
    notes: '',
    color: TOKEN_COLORS[colorIdx % TOKEN_COLORS.length],
  };
}

function sanitizeCharacterPatch(patch, current) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if ('name' in patch) out.name = str(patch.name, 60) || current.name;
  if ('race' in patch) out.race = str(patch.race, 60);
  if ('cls' in patch) out.cls = str(patch.cls, 60);
  if ('level' in patch) out.level = int(patch.level, 1, 20, current.level);
  if ('maxHp' in patch) out.maxHp = int(patch.maxHp, 1, 9999, current.maxHp);
  if ('hp' in patch) out.hp = int(patch.hp, -9999, 9999, current.hp);
  if ('tempHp' in patch) out.tempHp = int(patch.tempHp, 0, 9999, current.tempHp);
  if ('ac' in patch) out.ac = int(patch.ac, 0, 50, current.ac);
  if ('speed' in patch) out.speed = int(patch.speed, 0, 500, current.speed);
  if ('proficiency' in patch) out.proficiency = int(patch.proficiency, 0, 10, current.proficiency);
  if ('attacks' in patch) out.attacks = str(patch.attacks, 4000);
  if ('inventory' in patch) out.inventory = str(patch.inventory, 4000);
  if ('notes' in patch) out.notes = str(patch.notes, 8000);
  if ('color' in patch) out.color = color(patch.color, current.color);
  if (patch.abilities && typeof patch.abilities === 'object') {
    out.abilities = { ...current.abilities };
    for (const a of ABILITIES) {
      if (a in patch.abilities) out.abilities[a] = int(patch.abilities[a], 1, 30, current.abilities[a]);
    }
  }
  if (patch.saves && typeof patch.saves === 'object') {
    out.saves = { ...current.saves };
    for (const a of ABILITIES) {
      if (a in patch.saves) out.saves[a] = Boolean(patch.saves[a]);
    }
  }
  return out;
}

class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  newCode() {
    for (;;) {
      let code = '';
      const bytes = crypto.randomBytes(6);
      for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (!this.rooms.has(code)) return code;
    }
  }

  get(code) {
    const room = this.rooms.get(String(code || '').toUpperCase());
    if (!room) throw new GameError('Няма стая с този код');
    return room;
  }

  createRoom(roomName, dmName) {
    const code = this.newCode();
    const dm = { id: id(), secret: id(), name: str(dmName, 40).trim() || 'Водещ', isDM: true };
    const room = {
      code,
      name: str(roomName, 80).trim() || 'Нова кампания',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dmId: dm.id,
      players: { [dm.id]: dm },
      characters: {},
      tokens: {},
      map: { background: '', gridSize: 50, cols: 24, rows: 16 },
      initiative: { entries: [], turn: 0, round: 1, started: false },
      log: [],
    };
    this.rooms.set(code, room);
    return { room, player: dm };
  }

  joinRoom(code, name, playerId, secret) {
    const room = this.get(code);
    if (playerId && room.players[playerId]) {
      const existing = room.players[playerId];
      if (existing.secret !== secret) throw new GameError('Невалидна сесия');
      return { room, player: existing };
    }
    const cleanName = str(name, 40).trim();
    if (!cleanName) throw new GameError('Въведи име');
    if (Object.keys(room.players).length >= 50) throw new GameError('Стаята е пълна');
    const player = { id: id(), secret: id(), name: cleanName, isDM: false };
    room.players[player.id] = player;
    this.touch(room);
    return { room, player };
  }

  touch(room) {
    room.updatedAt = Date.now();
  }

  requirePlayer(room, playerId) {
    const p = room.players[playerId];
    if (!p) throw new GameError('Не си в тази стая');
    return p;
  }

  requireDM(room, playerId) {
    if (room.dmId !== playerId) throw new GameError('Само водещият (DM) може да направи това');
  }

  canEditCharacter(room, playerId, character) {
    return room.dmId === playerId || character.ownerId === playerId;
  }

  // ---- Chat / log ----

  addMessage(room, msg) {
    const entry = { id: id(), ts: Date.now(), ...msg };
    room.log.push(entry);
    if (room.log.length > MAX_LOG) room.log.splice(0, room.log.length - MAX_LOG);
    this.touch(room);
    return entry;
  }

  // ---- Characters ----

  createCharacter(room, playerId, name) {
    this.requirePlayer(room, playerId);
    const owned = Object.values(room.characters).filter((c) => c.ownerId === playerId);
    if (owned.length >= 10) throw new GameError('Твърде много герои');
    const c = newCharacter(playerId, name, Object.keys(room.characters).length);
    room.characters[c.id] = c;
    this.touch(room);
    return c;
  }

  updateCharacter(room, playerId, charId, patch) {
    const c = room.characters[charId];
    if (!c) throw new GameError('Няма такъв герой');
    if (!this.canEditCharacter(room, playerId, c)) throw new GameError('Нямаш права за този герой');
    Object.assign(c, sanitizeCharacterPatch(patch, c));
    for (const t of Object.values(room.tokens)) {
      if (t.characterId === c.id) {
        t.label = c.name;
        t.color = c.color;
      }
    }
    this.touch(room);
    return c;
  }

  deleteCharacter(room, playerId, charId) {
    const c = room.characters[charId];
    if (!c) throw new GameError('Няма такъв герой');
    if (!this.canEditCharacter(room, playerId, c)) throw new GameError('Нямаш права за този герой');
    delete room.characters[charId];
    for (const [tid, t] of Object.entries(room.tokens)) {
      if (t.characterId === charId) delete room.tokens[tid];
    }
    this.touch(room);
  }

  // ---- Map / tokens ----

  updateMap(room, playerId, patch) {
    this.requireDM(room, playerId);
    const m = room.map;
    if ('background' in patch) m.background = url(patch.background);
    if ('gridSize' in patch) m.gridSize = int(patch.gridSize, 20, 200, m.gridSize);
    if ('cols' in patch) m.cols = int(patch.cols, 5, 100, m.cols);
    if ('rows' in patch) m.rows = int(patch.rows, 5, 100, m.rows);
    for (const t of Object.values(room.tokens)) {
      t.x = Math.min(t.x, m.cols - t.size);
      t.y = Math.min(t.y, m.rows - t.size);
    }
    this.touch(room);
    return m;
  }

  addToken(room, playerId, data = {}) {
    this.requirePlayer(room, playerId);
    const isDM = room.dmId === playerId;
    let characterId = null;
    let label = str(data.label, 40).trim();
    let tokenColor = color(data.color, '#c0392b');
    let ownerId = isDM ? null : playerId;

    if (data.characterId) {
      const c = room.characters[data.characterId];
      if (!c) throw new GameError('Няма такъв герой');
      if (!this.canEditCharacter(room, playerId, c)) throw new GameError('Нямаш права за този герой');
      if (Object.values(room.tokens).some((t) => t.characterId === c.id)) {
        throw new GameError('Този герой вече е на картата');
      }
      characterId = c.id;
      label = c.name;
      tokenColor = c.color;
      ownerId = c.ownerId;
    } else if (!isDM) {
      throw new GameError('Само водещият може да добавя чудовища');
    }
    if (Object.keys(room.tokens).length >= 200) throw new GameError('Твърде много токени');

    const size = int(data.size, 1, 4, 1);
    const token = {
      id: id(),
      label: label || 'Чудовище',
      x: int(data.x, 0, room.map.cols - size, 0),
      y: int(data.y, 0, room.map.rows - size, 0),
      size,
      color: tokenColor,
      characterId,
      ownerId,
      hidden: isDM && Boolean(data.hidden),
      hp: characterId ? null : int(data.hp, 0, 9999, null),
      maxHp: characterId ? null : int(data.maxHp ?? data.hp, 0, 9999, null),
    };
    room.tokens[token.id] = token;
    this.touch(room);
    return token;
  }

  canMoveToken(room, playerId, token) {
    return room.dmId === playerId || (token.ownerId && token.ownerId === playerId);
  }

  moveToken(room, playerId, tokenId, x, y) {
    const t = room.tokens[tokenId];
    if (!t) throw new GameError('Няма такъв токен');
    if (!this.canMoveToken(room, playerId, t)) throw new GameError('Не можеш да местиш този токен');
    t.x = int(x, 0, room.map.cols - t.size, t.x);
    t.y = int(y, 0, room.map.rows - t.size, t.y);
    this.touch(room);
    return t;
  }

  updateToken(room, playerId, tokenId, patch) {
    this.requireDM(room, playerId);
    const t = room.tokens[tokenId];
    if (!t) throw new GameError('Няма такъв токен');
    if (!t.characterId) {
      if ('label' in patch) t.label = str(patch.label, 40).trim() || t.label;
      if ('color' in patch) t.color = color(patch.color, t.color);
      if ('hp' in patch) t.hp = int(patch.hp, -9999, 9999, t.hp);
      if ('maxHp' in patch) t.maxHp = int(patch.maxHp, 0, 9999, t.maxHp);
    }
    if ('size' in patch) t.size = int(patch.size, 1, 4, t.size);
    if ('hidden' in patch) t.hidden = Boolean(patch.hidden);
    t.x = Math.min(t.x, room.map.cols - t.size);
    t.y = Math.min(t.y, room.map.rows - t.size);
    this.touch(room);
    return t;
  }

  removeToken(room, playerId, tokenId) {
    const t = room.tokens[tokenId];
    if (!t) throw new GameError('Няма такъв токен');
    if (!this.canMoveToken(room, playerId, t)) throw new GameError('Не можеш да махнеш този токен');
    delete room.tokens[tokenId];
    room.initiative.entries = room.initiative.entries.filter((e) => e.tokenId !== tokenId);
    this.clampTurn(room);
    this.touch(room);
  }

  // ---- Initiative ----

  addInitiative(room, playerId, data = {}) {
    this.requirePlayer(room, playerId);
    const isDM = room.dmId === playerId;
    let name = str(data.name, 40).trim();
    let tokenId = null;
    let characterId = null;
    if (data.characterId) {
      const c = room.characters[data.characterId];
      if (!c) throw new GameError('Няма такъв герой');
      if (!this.canEditCharacter(room, playerId, c)) throw new GameError('Нямаш права за този герой');
      characterId = c.id;
      name = c.name;
      const existing = room.initiative.entries.find((e) => e.characterId === c.id);
      if (existing) {
        existing.value = int(data.value, -20, 100, existing.value);
        this.sortInitiative(room);
        return existing;
      }
    } else if (!isDM) {
      throw new GameError('Само водещият може да добавя противници');
    }
    if (data.tokenId && room.tokens[data.tokenId]) tokenId = data.tokenId;
    if (room.initiative.entries.length >= 100) throw new GameError('Твърде много участници');
    const entry = {
      id: id(),
      name: name || 'Противник',
      value: int(data.value, -20, 100, 0),
      characterId,
      tokenId,
      hidden: isDM && Boolean(data.hidden),
    };
    room.initiative.entries.push(entry);
    this.sortInitiative(room);
    return entry;
  }

  // Before the first "next turn" the top of the order acts first; after
  // that, re-sorting keeps the turn on whoever is currently acting.
  sortInitiative(room) {
    const init = room.initiative;
    const current = init.entries[init.turn];
    init.entries.sort((a, b) => b.value - a.value);
    init.turn = init.started && current ? init.entries.indexOf(current) : 0;
    this.touch(room);
  }

  removeInitiative(room, playerId, entryId) {
    this.requireDM(room, playerId);
    const idx = room.initiative.entries.findIndex((e) => e.id === entryId);
    if (idx < 0) return;
    room.initiative.entries.splice(idx, 1);
    if (idx < room.initiative.turn) room.initiative.turn -= 1;
    this.clampTurn(room);
    this.touch(room);
  }

  clampTurn(room) {
    const n = room.initiative.entries.length;
    if (n === 0) room.initiative.turn = 0;
    else if (room.initiative.turn >= n) room.initiative.turn = 0;
  }

  nextTurn(room, playerId) {
    this.requireDM(room, playerId);
    const init = room.initiative;
    if (init.entries.length === 0) return init;
    init.started = true;
    init.turn += 1;
    if (init.turn >= init.entries.length) {
      init.turn = 0;
      init.round += 1;
    }
    this.touch(room);
    return init;
  }

  prevTurn(room, playerId) {
    this.requireDM(room, playerId);
    const init = room.initiative;
    if (init.entries.length === 0) return init;
    init.turn -= 1;
    if (init.turn < 0) {
      if (init.round > 1) {
        init.round -= 1;
        init.turn = init.entries.length - 1;
      } else {
        init.turn = 0;
      }
    }
    this.touch(room);
    return init;
  }

  clearInitiative(room, playerId) {
    this.requireDM(room, playerId);
    room.initiative = { entries: [], turn: 0, round: 1, started: false };
    this.touch(room);
  }

  // ---- Views ----

  // Returns the state a specific player may see: no secrets, no hidden
  // tokens or private messages for non-DMs.
  viewFor(room, playerId, onlineIds = new Set()) {
    const isDM = room.dmId === playerId;
    const players = Object.values(room.players).map((p) => ({
      id: p.id,
      name: p.name,
      isDM: p.isDM,
      online: onlineIds.has(p.id),
    }));
    // Monster HP is the DM's secret; players only see that a token exists.
    const tokens = Object.values(room.tokens)
      .filter((t) => isDM || !t.hidden)
      .map((t) => (isDM || t.characterId ? t : { ...t, hp: null, maxHp: null }));
    const entries = room.initiative.entries.filter((e) => isDM || !e.hidden);
    const currentEntry = room.initiative.entries[room.initiative.turn];
    return {
      code: room.code,
      name: room.name,
      dmId: room.dmId,
      me: playerId,
      isDM,
      players,
      characters: Object.values(room.characters),
      tokens,
      map: room.map,
      initiative: {
        entries,
        round: room.initiative.round,
        currentId: currentEntry && (isDM || !currentEntry.hidden) ? currentEntry.id : null,
      },
    };
  }

  canSeeMessage(room, playerId, msg) {
    return !msg.visibleTo || msg.visibleTo.includes(playerId) || room.dmId === playerId;
  }

  logFor(room, playerId) {
    return room.log.filter((m) => this.canSeeMessage(room, playerId, m));
  }

  // ---- Persistence ----

  toJSON() {
    return { version: 1, rooms: [...this.rooms.values()] };
  }

  load(data) {
    if (!data || !Array.isArray(data.rooms)) return;
    for (const room of data.rooms) {
      if (room && room.code) this.rooms.set(room.code, room);
    }
  }

  pruneOlderThan(ms) {
    const cutoff = Date.now() - ms;
    for (const [code, room] of this.rooms) {
      if (room.updatedAt < cutoff) this.rooms.delete(code);
    }
  }
}

module.exports = { RoomStore, GameError, abilityMod, ABILITIES };
