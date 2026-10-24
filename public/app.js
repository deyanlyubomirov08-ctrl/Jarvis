'use strict';

(() => {
  // ---------- Helpers ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Tiny DOM builder. All text goes through textContent, never innerHTML.
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ABILITIES = [
    ['str', 'Сила'], ['dex', 'Ловкост'], ['con', 'Издръжл.'],
    ['int', 'Интелект'], ['wis', 'Мъдрост'], ['cha', 'Харизма'],
  ];
  const THEME_BG = { dungeon: 'Подземие', crypt: 'Крипта', cave: 'Пещера', forest: 'Гора', swamp: 'Блато' };
  const STATUS_BG = { ready: 'готово за начало', combat: 'битка', cleared: 'срещата е преодоляна', victory: 'завършено с победа', defeat: 'героите са повалени' };
  const abilityMod = (score) => Math.floor((score - 10) / 2);
  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const iconUrl = (icon) => `icons/${icon || 'monstrosity'}.svg`;

  // <img> showing an online picture, falling back to a bundled icon.
  function picture(image, icon, alt = '') {
    const img = h('img', { alt, loading: 'lazy', decoding: 'async' });
    const useIcon = () => {
      img.onerror = null;
      img.src = iconUrl(icon);
      img.classList.add('icon');
    };
    if (image) {
      img.src = image;
      img.onerror = useIcon;
    } else {
      useIcon();
    }
    return img;
  }

  let toastTimer = null;
  function toast(text, isError = false) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.toggle('err', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ---------- Sessions (localStorage) ----------

  const SESSIONS_KEY = 'dnd.sessions';
  function readSessions() {
    try { return JSON.parse(localStorage.getItem(SESSIONS_KEY)) || {}; } catch { return {}; }
  }
  function saveSession(code, data) {
    const all = readSessions();
    all[code] = { ...(all[code] || {}), ...data, ts: Date.now() };
    try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
  }
  function forgetSession(code) {
    const all = readSessions();
    delete all[code];
    try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
  }

  // ---------- App state ----------

  const app = {
    view: null,      // last state from server
    log: [],
    code: null,
    selectedChar: null,
    selectedToken: null,
    actingChar: null, // hero used in the battle panel outside of turn order
    targeting: null,  // { type: 'attack' | 'feature', characterId, index }
    zoom: 1,
    sheetFor: null,
    rollMode: 'normal',
    catalog: null,
    adventures: [],
    libKind: 'monsters',
    mapKey: null,
    lastCurrent: null,
  };

  const socket = io({ transports: ['websocket', 'polling'] });

  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(event, payload, (err, res) => {
        if (err) {
          toast('Няма връзка със сървъра', true);
          return resolve({ ok: false });
        }
        if (!res.ok && res.error) toast(res.error, true);
        resolve(res);
      });
    });
  }

  fetch('api/catalog').then((r) => r.json()).then((c) => {
    app.catalog = c;
    fillWizard();
    renderLibrary();
  }).catch(() => toast('Библиотеката не се зареди', true));
  fetch('api/adventures').then((r) => r.json()).then((a) => {
    app.adventures = a;
    if (app.view) renderSession();
  }).catch(() => {});

  // ---------- Lobby ----------

  function showLobby() {
    app.code = null;
    app.view = null;
    $('#game').classList.add('hidden');
    $('#lobby').classList.remove('hidden');
    history.replaceState(null, '', location.pathname);
    renderRecent();
  }

  function showGame() {
    $('#lobby').classList.add('hidden');
    $('#game').classList.remove('hidden');
  }

  function renderRecent() {
    const sessions = Object.entries(readSessions()).sort((a, b) => b[1].ts - a[1].ts).slice(0, 8);
    $('#recent-list').replaceChildren(...sessions.map(([code, s]) => h('li', {},
      h('button', { onclick: () => joinRoom(code) },
        h('strong', {}, s.roomName || code), ` — ${s.name || ''} (${code})`))));
    $('#recent').classList.toggle('hidden', sessions.length === 0);
  }

  async function enterResult(res, extra = {}) {
    if (!res.ok) {
      if (!$('#game').classList.contains('hidden')) showLobby();
      $('#lobby-error').textContent = res.error || '';
      return false;
    }
    $('#lobby-error').textContent = '';
    app.code = res.code;
    saveSession(res.code, { playerId: res.playerId, secret: res.secret, ...extra });
    history.replaceState(null, '', `#${res.code}`);
    showGame();
    return true;
  }

  async function joinRoom(code, name) {
    code = code.toUpperCase().trim();
    const s = readSessions()[code] || {};
    const res = await emit('room:join', { code, name: name || s.name, playerId: s.playerId, secret: s.secret });
    if (!res.ok && s.playerId) forgetSession(code);
    return enterResult(res, { name: name || s.name });
  }

  $$('#create-form [name=mode]').forEach((r) => r.addEventListener('change', () => {
    const ai = $('#create-form').mode.value === 'ai';
    $('#create-name-label').textContent = ai ? 'Твоето име (домакин на играта)' : 'Твоето име (водещ / DM)';
  }));

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const res = await emit('room:create', { roomName: f.get('roomName'), name: f.get('name'), mode: f.get('mode') });
    enterResult(res, { name: f.get('name'), roomName: f.get('roomName') });
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    joinRoom(String(f.get('code')), String(f.get('name')));
  });

  $('#leave').addEventListener('click', async () => {
    await emit('room:leave');
    showLobby();
  });

  $('#copy-code').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}#${app.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Линкът за покана е копиран');
    } catch {
      toast(link);
    }
  });

  // ---------- Socket events ----------

  socket.on('connect', () => {
    $('#conn-status').textContent = '';
    $('#conn-status').classList.remove('off');
    if (app.code) joinRoom(app.code); // reattach after a reconnect
  });

  socket.on('disconnect', () => {
    $('#conn-status').textContent = '● няма връзка';
    $('#conn-status').classList.add('off');
  });

  socket.on('state', (view) => {
    app.view = view;
    const s = readSessions()[view.code];
    if (s && s.roomName !== view.name) saveSession(view.code, { roomName: view.name });
    render();
  });

  socket.on('history', (msgs) => {
    app.log = msgs;
    renderLog();
  });

  socket.on('message', (msg) => {
    app.log.push(msg);
    if (app.log.length > 300) app.log.shift();
    appendMessage(msg);
  });

  // ---------- Rendering ----------

  const isAI = () => app.view && app.view.mode === 'ai';

  function myCharacters() {
    const v = app.view;
    return v.characters.filter((c) => v.isDM || c.ownerId === v.me);
  }

  function canEditChar(c) {
    return app.view.isDM || c.ownerId === app.view.me;
  }

  function currentEntry() {
    const v = app.view;
    return v.initiative.entries.find((e) => e.id === v.initiative.currentId) || null;
  }

  function render() {
    const v = app.view;
    if (!v) return;
    document.body.classList.toggle('is-dm', v.isDM);
    document.body.classList.toggle('is-controller', v.isController);
    $('#room-name').textContent = v.name;
    $('#room-code').textContent = v.code;
    $('#mode-badge').textContent = isAI() ? '🤖 Водещ: компютър' : '👑 Водещ: човек';
    $('#chat-hint').textContent = isAI() ? '@DM въпрос към водещия · /r 1d20+3' : '/r 2d6+3 · /gr 1d20 · 4d6dl1';
    $('#chat-input').placeholder = isAI() ? 'Съобщение, @DM какво виждам? или /r 1d20' : 'Съобщение или /r 1d20+5';
    document.title = `${v.name} — Таверната`;
    if (!v.isDM && $('.tabs button.active')?.dataset.tab === 'dm') selectTab('chat');
    if (app.selectedToken && !v.tokens.some((t) => t.id === app.selectedToken)) app.selectedToken = null;
    if (app.selectedChar && !v.characters.some((c) => c.id === app.selectedChar)) app.selectedChar = null;
    const host = v.players.find((p) => p.id === v.hostId);
    $('#controller-name').textContent = isAI() ? `домакина (${host ? host.name : '—'})` : 'водещия';

    renderPlayers();
    renderMap();
    renderChars();
    renderInit();
    renderSession();
    renderDM();
    renderTokenPanel();
  }

  function renderPlayers() {
    const v = app.view;
    const people = [...v.players].sort((a, b) => Number(b.isDM) - Number(a.isDM));
    const chips = people.map((p) => h('span', {
      class: `player${p.online ? '' : ' offline'}${p.isDM ? ' dm' : ''}`,
      title: p.online ? 'На линия' : 'Извън линия',
    }, `${p.isDM ? '👑 ' : p.id === v.hostId && isAI() ? '🏠 ' : ''}${p.name}${p.id === v.me ? ' (ти)' : ''}`));
    if (isAI()) chips.unshift(h('span', { class: 'player dm' }, '🤖 Водещ'));
    $('#player-list').replaceChildren(...chips);
  }

  // ----- Map -----

  const PALETTES = {
    dungeon: { '#': '#2b2620', '.': '#6b5d4a', '+': '#7a4e25', ',': '#6b5d4a' },
    crypt: { '#': '#1c1c24', '.': '#4a4a58', '+': '#5a3b22', ',': '#4a4a58' },
    cave: { '#': '#241c14', '.': '#5c4b38', '~': '#1f4d6b', ',': '#5c4b38' },
    forest: { ',': '#3f6b2f', '.': '#7a6a45', T: '#1f3d17', '~': '#2c6a8f', '=': '#8b6b3d' },
    swamp: { ',': '#4a5a2f', '.': '#6b6040', T: '#25351a', '~': '#2f4a3a', '=': '#7a5f38' },
  };

  // Paints procedural tiles into an image used as the board background.
  function tileBackground(map) {
    const cell = map.gridSize;
    const canvas = document.createElement('canvas');
    canvas.width = map.cols * cell;
    canvas.height = map.rows * cell;
    const ctx = canvas.getContext('2d');
    const pal = PALETTES[map.theme] || PALETTES.dungeon;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let y = 0; y < map.rows; y += 1) {
      for (let x = 0; x < map.cols; x += 1) {
        const ch = map.tiles[y][x];
        const px = x * cell;
        const py = y * cell;
        const base = ch === 'T' ? (pal[','] || '#3f6b2f') : ch === '+' ? pal['.'] : (pal[ch] || pal['.'] || '#555');
        ctx.fillStyle = base;
        ctx.fillRect(px, py, cell, cell);
        ctx.fillStyle = 'rgba(0,0,0,0.12)';
        for (let i = 0; i < 4; i += 1) ctx.fillRect(px + rnd() * cell, py + rnd() * cell, 3, 3);
        if (ch === '#') {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(px + 2, py + 2, cell - 4, cell / 3);
        } else if (ch === 'T') {
          ctx.fillStyle = pal.T;
          ctx.beginPath();
          ctx.arc(px + cell / 2, py + cell / 2, cell * 0.48, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.08)';
          ctx.beginPath();
          ctx.arc(px + cell * 0.4, py + cell * 0.4, cell * 0.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (ch === '~') {
          ctx.strokeStyle = 'rgba(255,255,255,0.18)';
          ctx.beginPath();
          ctx.moveTo(px + cell * 0.15, py + cell * 0.5);
          ctx.quadraticCurveTo(px + cell * 0.5, py + cell * 0.3, px + cell * 0.85, py + cell * 0.5);
          ctx.stroke();
        } else if (ch === '+') {
          ctx.fillStyle = pal['+'];
          ctx.fillRect(px + cell * 0.15, py + cell * 0.15, cell * 0.7, cell * 0.7);
          ctx.fillStyle = '#d4a24c';
          ctx.fillRect(px + cell * 0.62, py + cell * 0.45, 4, 4);
        } else if (ch === '=') {
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          for (let i = 1; i < 4; i += 1) ctx.fillRect(px, py + (cell / 4) * i, cell, 2);
        }
      }
    }
    return canvas.toDataURL('image/png');
  }

  function currentTokenId() {
    const v = app.view;
    const e = currentEntry();
    if (!e) return null;
    if (e.tokenId) return e.tokenId;
    const t = e.characterId && v.tokens.find((x) => x.characterId === e.characterId);
    return t ? t.id : null;
  }

  function renderMap() {
    const v = app.view;
    const { gridSize: cell, cols, rows, background } = v.map;
    const board = $('#map-board');
    board.style.width = `${cols * cell}px`;
    board.style.height = `${rows * cell}px`;
    board.style.setProperty('--cell', `${cell}px`);
    if (v.map.tiles) {
      const key = `${v.map.theme}|${cell}|${v.map.tiles.join('')}`;
      if (key !== app.mapKey) {
        app.mapKey = key;
        board.style.backgroundImage = `url(${tileBackground(v.map)})`;
      }
    } else {
      app.mapKey = null;
      board.style.backgroundImage = background ? `url(${JSON.stringify(background)})` : '';
    }
    board.style.transform = `scale(${app.zoom})`;
    board.style.marginRight = `${cols * cell * (app.zoom - 1) + 20}px`;
    board.style.marginBottom = `${rows * cell * (app.zoom - 1) + 20}px`;
    board.classList.toggle('targeting', Boolean(app.targeting));
    $('#zoom-label').textContent = `${Math.round(app.zoom * 100)}%`;

    const e = currentEntry();
    $('#turn-banner').textContent = e ? `Рунд ${v.initiative.round} · на ход: ${e.name}` : '';

    const current = currentTokenId();
    const existing = new Map($$('.token', board).map((el) => [el.dataset.id, el]));
    for (const t of v.tokens) {
      let el = existing.get(t.id);
      existing.delete(t.id);
      if (el && el.classList.contains('dragging')) continue;
      if (!el) {
        el = h('div', { class: 'token', dataset: { id: t.id } });
        attachDrag(el);
        board.append(el);
      }
      const char = t.characterId && v.characters.find((c) => c.id === t.characterId);
      const size = t.size * cell;
      Object.assign(el.style, {
        left: `${t.x * cell}px`, top: `${t.y * cell}px`,
        width: `${size}px`, height: `${size}px`,
        background: char ? char.color : t.color, fontSize: `${Math.max(10, size / 3.2)}px`,
      });
      el.classList.toggle('movable', canMoveToken(t) && !t.dead);
      el.classList.toggle('selected', app.selectedToken === t.id);
      el.classList.toggle('hidden-token', Boolean(t.hidden));
      el.classList.toggle('current', current === t.id);
      el.classList.toggle('pc', Boolean(char));
      el.classList.toggle('dead', Boolean(t.dead));
      el.classList.toggle('down', Boolean(char && char.hp <= 0));
      el.title = t.label;

      let pct = null;
      if (char) pct = (char.hp / char.maxHp) * 100;
      else if (t.maxHp) pct = (t.hp / t.maxHp) * 100;
      else if (t.hpPct !== null && t.hpPct !== undefined) pct = t.hpPct;

      const icon = t.icon || (char && char.icon);
      const visualKey = `${t.image}|${icon}|${t.label}`;
      if (el.dataset.visual !== visualKey) {
        el.dataset.visual = visualKey;
        const face = t.image || icon ? picture(t.image, icon, t.label) : h('span', { class: 'initials' }, initials(t.label));
        el.replaceChildren(face, h('span', { class: 'tname' }, t.label), h('span', { class: 'hpbar' }, h('i')));
      }
      const bar = el.querySelector('.hpbar');
      bar.style.display = pct === null || t.dead ? 'none' : '';
      if (pct !== null) {
        const p = Math.max(0, Math.min(100, pct));
        Object.assign(bar.firstChild.style, { width: `${p}%`, background: p > 50 ? '#27ae60' : p > 20 ? '#f39c12' : '#c0392b' });
      }
    }
    for (const el of existing.values()) el.remove();
    // Bring whoever acts now into view when the turn changes.
    if (current && current !== app.lastCurrent) {
      const el = board.querySelector(`.token[data-id="${current}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    app.lastCurrent = current;
  }

  function canMoveToken(t) {
    const v = app.view;
    return v.isDM || (t.ownerId && t.ownerId === v.me);
  }

  function attachDrag(el) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = app.view.tokens.find((x) => x.id === el.dataset.id);
      if (!t) return;
      e.preventDefault();
      const movable = canMoveToken(t) && !t.dead && !app.targeting;
      start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, moved: false, movable };
      if (movable) el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!start || !start.movable) return;
      const dx = (e.clientX - start.x) / app.zoom;
      const dy = (e.clientY - start.y) / app.zoom;
      if (!start.moved && Math.hypot(dx, dy) < 4) return;
      start.moved = true;
      el.classList.add('dragging');
      el.style.left = `${start.left + dx}px`;
      el.style.top = `${start.top + dy}px`;
    });
    const end = async () => {
      if (!start) return;
      const s = start;
      start = null;
      const id = el.dataset.id;
      if (!s.moved) {
        if (app.targeting) return useTarget(id);
        app.selectedToken = app.selectedToken === id ? null : id;
        render();
        return;
      }
      const cell = app.view.map.gridSize;
      const x = Math.round(el.offsetLeft / cell);
      const y = Math.round(el.offsetTop / cell);
      el.classList.remove('dragging');
      const res = await emit('token:move', { id, x, y });
      if (!res.ok) render();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  $$('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
    const steps = [0.4, 0.5, 0.66, 0.8, 1, 1.25, 1.5, 2];
    const idx = steps.findIndex((z) => z >= app.zoom - 0.001);
    const next = Math.max(0, Math.min(steps.length - 1, idx + Number(b.dataset.zoom)));
    app.zoom = steps[next];
    renderMap();
  }));

  // Finds free, walkable cells close to the visible top-left corner of the map.
  function freeCells(count, size = 1) {
    const v = app.view;
    const vp = $('#map-viewport');
    const cell = v.map.gridSize * app.zoom;
    const startX = Math.max(0, Math.floor((vp.scrollLeft - 20) / cell) + 1);
    const startY = Math.max(0, Math.floor((vp.scrollTop - 20) / cell) + 1);
    const taken = new Set();
    for (const t of v.tokens) {
      for (let i = 0; i < t.size; i += 1) for (let j = 0; j < t.size; j += 1) taken.add(`${t.x + i},${t.y + j}`);
    }
    const blocked = (x, y) => v.map.tiles && '#T~'.includes(v.map.tiles[y][x]);
    const out = [];
    for (let y = startY; y <= v.map.rows - size && out.length < count; y += 1) {
      for (let x = startX; x <= v.map.cols - size && out.length < count; x += 1) {
        let free = true;
        for (let i = 0; i < size && free; i += 1) {
          for (let j = 0; j < size && free; j += 1) if (taken.has(`${x + i},${y + j}`) || blocked(x + i, y + j)) free = false;
        }
        if (free) {
          out.push({ x, y });
          for (let i = 0; i < size; i += 1) for (let j = 0; j < size; j += 1) taken.add(`${x + i},${y + j}`);
        }
      }
    }
    while (out.length < count) out.push({ x: startX, y: startY });
    return out;
  }

  // ----- Targeting (attacks and healing) -----

  function armTarget(t) {
    app.targeting = t;
    const hint = $('#target-hint');
    hint.textContent = t.type === 'attack' ? '🎯 Кликни върху враг на картата (Esc — отказ)' : '✨ Кликни върху съюзник на картата (Esc — отказ)';
    hint.classList.remove('hidden');
    renderMap();
    renderInit();
  }

  function disarm() {
    app.targeting = null;
    $('#target-hint').classList.add('hidden');
    if (app.view) {
      renderMap();
      renderInit();
    }
  }

  async function useTarget(tokenId) {
    const t = app.targeting;
    disarm();
    if (t.type === 'attack') {
      await emit('combat:attack', { characterId: t.characterId, weaponIndex: t.index, targetId: tokenId });
    } else {
      await emit('combat:feature', { characterId: t.characterId, featureIndex: t.index, targetId: tokenId });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.targeting) disarm();
  });

  // ----- Chat log -----

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
  }

  function rollNode(msg) {
    const r = msg.result;
    const crit = r.crit ? ` crit-${r.crit}` : '';
    const breakdown = [];
    r.parts.forEach((p, idx) => {
      const sign = p.sign < 0 ? ' − ' : idx === 0 ? '' : ' + ';
      if (p.type === 'const') {
        breakdown.push(`${sign}${p.value}`);
        return;
      }
      const dice = [];
      p.rolls.forEach((d, i) => {
        if (i) dice.push(', ');
        const cls = !d.kept ? 'drop' : d.value === p.sides ? 'max' : d.value === 1 ? 'min' : '';
        dice.push(h('span', { class: cls }, d.value));
      });
      const mod = p.mod ? `${p.mod.kind}${p.mod.n}` : '';
      breakdown.push(`${sign}${p.count}d${p.sides}${mod} [`, ...dice, ']');
    });
    return h('div', { class: `msg roll${crit}${msg.private ? ' private' : ''}` },
      h('span', { class: 'time' }, fmtTime(msg.ts)),
      h('span', { class: 'who' }, msg.author),
      msg.private ? h('span', { class: 'badge' }, '🔒 таен') : null,
      msg.label ? h('div', { class: 'label' }, msg.label) : null,
      h('div', { class: 'total' }, r.total,
        r.crit === 'success' ? h('span', { class: 'badge' }, 'КРИТИЧНО! 20') : null,
        r.crit === 'fail' ? h('span', { class: 'badge' }, 'Провал: 1') : null),
      h('div', { class: 'breakdown' }, ...breakdown));
  }

  function messageNode(msg) {
    if (msg.type === 'system') return h('div', { class: 'msg system' }, msg.text);
    if (msg.type === 'roll') return rollNode(msg);
    if (msg.type === 'narration') {
      return h('div', { class: 'msg narration' },
        h('span', { class: 'time' }, fmtTime(msg.ts)),
        h('span', { class: 'who' }, msg.author || 'Водещ'), msg.text);
    }
    return h('div', { class: 'msg' },
      h('span', { class: 'time' }, fmtTime(msg.ts)),
      h('span', { class: 'who' }, `${msg.author}:`), msg.text);
  }

  function appendMessage(msg) {
    const log = $('#log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    log.append(messageNode(msg));
    while (log.childElementCount > 300) log.firstElementChild.remove();
    if (nearBottom) log.scrollTop = log.scrollHeight;
  }

  function renderLog() {
    const log = $('#log');
    log.replaceChildren(...app.log.map(messageNode));
    log.scrollTop = log.scrollHeight;
  }

  const DICE = [4, 6, 8, 10, 12, 20, 100];
  $('#dice-buttons').replaceChildren(
    ...DICE.map((d) => h('button', {
      title: `Хвърли d${d}`,
      onclick: () => emit('dice:roll', { expr: `1d${d}`, private: $('#roll-private').checked }),
    }, `d${d}`)),
    h('button', { title: 'd20 с предимство', onclick: () => emit('dice:roll', { expr: '2d20kh1', label: 'С предимство', private: $('#roll-private').checked }) }, 'Пр.'),
    h('button', { title: 'd20 с неудобство', onclick: () => emit('dice:roll', { expr: '2d20kl1', label: 'С неудобство', private: $('#roll-private').checked }) }, 'Неуд.'),
  );

  $('#chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    let res;
    if ($('#roll-private').checked && /^\/(r|roll)\s/i.test(text)) {
      res = await emit('dice:roll', { expr: text.replace(/^\/\w+\s+/, ''), private: true });
    } else {
      res = await emit('chat:send', { text });
    }
    if (res.ok) input.value = '';
  });

  // ----- Characters -----

  $('#random-hero').addEventListener('click', async () => {
    const res = await emit('char:random', { count: 1 });
    if (res.ok) { app.selectedChar = res.id; render(); }
  });
  $('#random-party').addEventListener('click', async () => {
    const res = await emit('char:random', { count: 4 });
    if (res.ok) toast('Отрядът е готов!');
  });

  function portraitNode(c, cls = 'portrait') {
    return h('span', { class: cls, style: { background: c.color } },
      c.icon ? picture(null, c.icon, c.name) : h('span', {}, initials(c.name)));
  }

  function renderChars() {
    const v = app.view;
    const list = $('#char-list');
    const chars = [...v.characters].sort((a, b) => Number(canEditChar(b)) - Number(canEditChar(a)));
    list.replaceChildren(...chars.map((c) => {
      const owner = v.players.find((p) => p.id === c.ownerId);
      return h('button', {
        class: `char-card${app.selectedChar === c.id ? ' active' : ''}`,
        onclick: () => {
          app.selectedChar = app.selectedChar === c.id ? null : c.id;
          renderChars();
        },
      },
      portraitNode(c, 'mini'),
      h('span', {},
        h('div', {}, h('strong', {}, c.name)),
        h('div', { class: 'meta' }, [c.race, c.cls && `${c.cls} ${c.level}`, owner && `играч: ${owner.name}`].filter(Boolean).join(' · '))),
      h('span', { class: 'hp' }, `${c.hp <= 0 ? '💀' : '❤'} ${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp})` : ''} · 🛡 ${c.ac}`));
    }));
    if (chars.length === 0) list.append(h('p', { class: 'hint' }, 'Още няма герои. Създай герой или натисни „Случаен герой“.'));
    renderSheet();
  }

  const sendCharPatch = (() => {
    const pending = new Map();
    const flush = debounce(() => {
      for (const [id, patch] of pending) emit('char:update', { id, patch });
      pending.clear();
    }, 500);
    return (id, patch) => {
      const cur = pending.get(id) || {};
      for (const [k, val] of Object.entries(patch)) {
        cur[k] = typeof val === 'object' ? { ...(cur[k] || {}), ...val } : val;
      }
      pending.set(id, cur);
      flush();
    };
  })();

  function field(label, path, attrs = {}) {
    return h('label', {}, label, h('input', { dataset: { field: path }, ...attrs }));
  }

  function buildSheet(c) {
    const sheet = $('#char-sheet');
    const editable = canEditChar(c);
    const abilityBox = ([key, name]) => h('div', { class: 'ability' },
      h('div', { class: 'name' }, name),
      h('input', { type: 'number', min: 1, max: 30, dataset: { field: `abilities.${key}` } }),
      h('div', { class: 'mod', dataset: { mod: key } }),
      h('label', { class: 'save-toggle' }, h('input', { type: 'checkbox', dataset: { field: `saves.${key}` } }), 'спас. хв.'),
      editable ? h('div', { class: 'acts' },
        h('button', { title: 'Проверка', onclick: () => emit('char:check', { characterId: c.id, ability: key, mode: app.rollMode, private: $('#roll-private').checked }) }, 'Пров.'),
        h('button', { title: 'Спасителен хвърлей', onclick: () => emit('char:check', { characterId: c.id, ability: key, save: true, mode: app.rollMode, private: $('#roll-private').checked }) }, 'Спас.')) : null);

    const hpInput = h('input', { type: 'number', min: 0, placeholder: 'кол.' });
    const applyHp = (sign) => {
      const amount = Math.abs(parseInt(hpInput.value, 10));
      if (!amount) return;
      const cur = app.view.characters.find((x) => x.id === c.id);
      let { hp, tempHp } = cur;
      if (sign < 0) {
        const fromTemp = Math.min(tempHp, amount);
        tempHp -= fromTemp;
        hp = Math.max(0, hp - (amount - fromTemp));
      } else {
        hp = Math.min(cur.maxHp, hp + amount);
      }
      emit('char:update', { id: c.id, patch: { hp, tempHp } });
      hpInput.value = '';
    };

    const modeSelect = h('select', { onchange: (e) => { app.rollMode = e.target.value; } },
      h('option', { value: 'normal' }, 'Нормално'),
      h('option', { value: 'adv' }, 'С предимство'),
      h('option', { value: 'dis' }, 'С неудобство'));
    modeSelect.value = app.rollMode;

    sheet.replaceChildren(
      h('div', { class: 'row', style: { alignItems: 'center' } },
        portraitNode(c),
        h('label', { style: { flex: 1 } }, 'Име', h('input', { dataset: { field: 'name' }, maxlength: 60 })),
        h('label', {}, 'Цвят', h('input', { type: 'color', dataset: { field: 'color' } }))),
      h('div', { class: 'xp-bar', dataset: { xp: '1' } }),
      h('div', { class: 'sheet-grid' },
        field('Раса', 'race', { maxlength: 60 }),
        field('Клас', 'cls', { maxlength: 60 }),
        field('Ниво', 'level', { type: 'number', min: 1, max: 20 }),
        field('Броня (AC)', 'ac', { type: 'number', min: 0, max: 50 }),
        field('Скорост', 'speed', { type: 'number', min: 0 }),
        field('Бонус умение', 'proficiency', { type: 'number', min: 0, max: 10 }),
        field('HP', 'hp', { type: 'number' }),
        field('Макс. HP', 'maxHp', { type: 'number', min: 1 }),
        field('Врем. HP', 'tempHp', { type: 'number', min: 0 })),
      editable ? h('div', { class: 'hp-controls' },
        hpInput,
        h('button', { class: 'danger', onclick: () => applyHp(-1) }, '− Щета'),
        h('button', { onclick: () => applyHp(1) }, '+ Лечение'),
        h('span', { class: 'hint' }, 'Хвърляне:'),
        modeSelect) : null,
      h('div', { class: 'abilities' }, ...ABILITIES.map(abilityBox)),
      h('div', { class: 'weapon-list', dataset: { weapons: '1' } }),
      h('div', { class: 'item-list', dataset: { items: '1' } }),
      h('label', {}, 'Атаки и заклинания (бележки)', h('textarea', { dataset: { field: 'attacks' }, maxlength: 4000, placeholder: 'Дълъг меч: +5, 1d8+3 режещи' })),
      h('label', {}, 'Инвентар (бележки)', h('textarea', { dataset: { field: 'inventory' }, maxlength: 4000 })),
      h('label', {}, 'Бележки', h('textarea', { dataset: { field: 'notes' }, maxlength: 8000 })),
      editable ? h('div', { class: 'sheet-actions' },
        isAI() ? null : h('button', { onclick: () => emit('init:roll', { characterId: c.id }) }, '⚔ Инициатива'),
        h('button', { onclick: () => placeCharacter(c.id) }, '📍 На картата'),
        h('button', { onclick: () => { app.actingChar = c.id; selectTab('init'); renderInit(); } }, '🗡 Действия в битка'),
        h('button', {
          class: 'danger',
          onclick: () => { if (confirm(`Да изтрия ли ${c.name}?`)) emit('char:delete', { id: c.id }); },
        }, 'Изтрий')) : h('p', { class: 'hint' }, 'Само за преглед — този герой е на друг играч.'),
    );
    sheet.classList.toggle('readonly', !editable);

    for (const el of $$('[data-field]', sheet)) {
      el.disabled = !editable;
      el.addEventListener(el.type === 'checkbox' || el.type === 'color' ? 'change' : 'input', () => {
        const path = el.dataset.field;
        const value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'number' && value === '') return;
        const [k, sub] = path.split('.');
        sendCharPatch(c.id, sub ? { [k]: { [sub]: value } } : { [k]: value });
        if (k === 'abilities') updateMods();
      });
    }
  }

  function updateMods() {
    for (const [key] of ABILITIES) {
      const input = $(`#char-sheet [data-field="abilities.${key}"]`);
      const out = $(`#char-sheet [data-mod="${key}"]`);
      if (input && out) out.textContent = signed(abilityMod(parseInt(input.value, 10) || 10));
    }
  }

  function renderSheetLists(c) {
    const sheet = $('#char-sheet');
    const editable = canEditChar(c);
    $('[data-xp]', sheet).textContent = `⭐ ${c.xp || 0} XP · 💰 ${c.gold || 0} жълтици`;
    const weapons = c.weapons || [];
    const features = c.features || [];
    $('[data-weapons]', sheet).replaceChildren(
      weapons.length || features.length ? h('strong', {}, 'Атаки и умения') : null,
      ...weapons.map((w) => h('div', {}, `🗡 ${w.name}: ${w.save ? `спас. ${w.save.toUpperCase()} DC ${w.dc}` : `${signed(w.attackBonus)} за удар`}, ${w.damage} ${w.damageType || ''}${w.ranged ? ` (${w.range} фута)` : ''}`)),
      ...features.map((f) => h('div', {}, `✨ ${f.name}: ${f.dice} HP · ${f.uses}/${f.maxUses} използвания`)),
    );
    const items = c.items || [];
    $('[data-items]', sheet).replaceChildren(
      items.length ? h('strong', {}, 'Предмети') : null,
      ...items.map((it, i) => h('div', { class: 'item-row' },
        h('span', { class: 'thumb' }, picture(it.image, it.icon, it.name)),
        h('span', {}, it.name),
        h('button', { title: 'Описание', onclick: () => openLibrary('items', it.id) }, 'ℹ'),
        editable ? h('button', { onclick: () => emit('char:useItem', { characterId: c.id, index: i }) }, 'Използвай') : null,
        editable ? h('button', { class: 'danger', title: 'Изхвърли', onclick: () => emit('char:removeItem', { characterId: c.id, index: i }) }, '✕') : null)),
    );
  }

  function renderSheet() {
    const sheet = $('#char-sheet');
    const c = app.view.characters.find((x) => x.id === app.selectedChar);
    if (!c) {
      sheet.classList.add('hidden');
      app.sheetFor = null;
      return;
    }
    sheet.classList.remove('hidden');
    if (app.sheetFor !== c.id) {
      buildSheet(c);
      app.sheetFor = c.id;
    }
    for (const el of $$('[data-field]', sheet)) {
      if (el === document.activeElement) continue;
      const [k, sub] = el.dataset.field.split('.');
      const value = sub ? c[k][sub] : c[k];
      if (el.type === 'checkbox') el.checked = Boolean(value);
      else if (String(el.value) !== String(value ?? '')) el.value = value ?? '';
    }
    updateMods();
    renderSheetLists(c);
  }

  async function placeCharacter(characterId) {
    const v = app.view;
    const existing = v.tokens.find((t) => t.characterId === characterId);
    if (existing) {
      app.selectedToken = existing.id;
      render();
      toast('Героят вече е на картата');
      return;
    }
    const [pos] = freeCells(1);
    const res = await emit('token:add', { characterId, ...pos });
    if (res.ok) toast('Героят е поставен на картата');
  }

  // ----- Character wizard -----

  function fillWizard() {
    const c = app.catalog;
    $('#wiz-race').replaceChildren(...c.races.map((r) => h('option', { value: r.id }, r.nameBg)));
    $('#wiz-cls').replaceChildren(...c.classes.map((k) => h('option', { value: k.id }, k.nameBg)));
    $('#wiz-manual').replaceChildren(...ABILITIES.map(([k, n]) => h('label', {}, n, h('input', { type: 'number', name: `ab-${k}`, min: 3, max: 20, value: 10 }))));
    updateWizardInfo();
  }

  function updateWizardInfo() {
    const c = app.catalog;
    if (!c) return;
    const race = c.races.find((r) => r.id === $('#wiz-race').value);
    const cls = c.classes.find((k) => k.id === $('#wiz-cls').value);
    const bonuses = Object.entries(race.bonuses || {}).map(([a, b]) => `${a.toUpperCase()} +${b}`).join(', ');
    $('#wiz-info').textContent = `${race.nameBg}: ${bonuses || '—'}, скорост ${race.speed} фута. ${race.traits.length ? `Черти: ${race.traits.join(', ')}.` : ''} `
      + `${cls.nameBg}: зар за живот d${cls.hitDie}, спасителни хвърлеи ${cls.saves.map((s) => s.toUpperCase()).join(' и ')}.`;
  }

  $('#wiz-race').addEventListener('change', updateWizardInfo);
  $('#wiz-cls').addEventListener('change', updateWizardInfo);
  $$('#wizard-form [name=method]').forEach((r) => r.addEventListener('change', () => {
    $('#wiz-manual').classList.toggle('hidden', $('#wizard-form').method.value !== 'manual');
  }));
  $('#open-wizard').addEventListener('click', () => {
    if (!app.catalog) return toast('Библиотеката още се зарежда…');
    $('#wizard').showModal();
  });
  $('#wizard-submit').addEventListener('click', async () => {
    const f = $('#wizard-form');
    const build = { race: f.race.value, cls: f.cls.value, level: f.level.value, method: f.method.value };
    if (f.method.value === 'manual') {
      build.abilities = Object.fromEntries(ABILITIES.map(([k]) => [k, f[`ab-${k}`].value]));
    }
    const res = await emit('char:create', { name: f.name.value, build });
    if (res.ok) {
      $('#wizard').close();
      f.name.value = '';
      app.selectedChar = res.id;
      selectTab('chars');
      render();
    }
  });
  $('#wizard-blank').addEventListener('click', async () => {
    const f = $('#wizard-form');
    const res = await emit('char:create', { name: f.name.value || 'Нов герой' });
    if (res.ok) {
      $('#wizard').close();
      app.selectedChar = res.id;
      render();
    }
  });

  // ----- Battle tab -----

  const turnBased = () => app.view.initiative.entries.length > 0 && (isAI() || app.view.autoMonsters);

  function actingCharacter() {
    const v = app.view;
    const e = currentEntry();
    if (e && e.characterId) {
      const c = v.characters.find((x) => x.id === e.characterId);
      if (c && canEditChar(c)) return { c, myTurn: true };
    }
    if (turnBased() && !v.isDM) return null;
    const mine = myCharacters();
    const c = mine.find((x) => x.id === app.actingChar) || mine[0];
    return c ? { c, myTurn: false } : null;
  }

  function renderActions() {
    const v = app.view;
    const box = $('#action-panel');
    const acting = actingCharacter();
    const e = currentEntry();
    if (!acting) {
      box.replaceChildren(e ? h('p', { class: 'hint' }, `Изчакай своя ход. Сега е ред на ${e.name}.`) : '');
      return;
    }
    const { c, myTurn } = acting;
    const actionUsed = turnBased() && v.initiative.acted;
    const bonusUsed = turnBased() && v.initiative.bonusActed;
    const armed = (type, i) => app.targeting && app.targeting.type === type && app.targeting.index === i && app.targeting.characterId === c.id;
    const mine = myCharacters();

    box.replaceChildren(h('div', { class: 'action-box' },
      h('h4', {}, myTurn ? `Твой ход: ${c.name}` : `Действия: ${c.name}`),
      !myTurn && mine.length > 1 ? h('select', {
        onchange: (ev) => { app.actingChar = ev.target.value; renderInit(); },
      }, ...mine.map((x) => h('option', { value: x.id, selected: x.id === c.id }, x.name))) : null,
      c.hp <= 0 ? h('p', { class: 'hint' }, `${c.name} е в безсъзнание. Нужен е лечител!`) : null,
      h('div', { class: 'action-row' }, ...(c.weapons || []).map((w, i) => h('button', {
        class: armed('attack', i) ? 'armed' : '',
        disabled: actionUsed || c.hp <= 0,
        title: `${w.save ? `спасителен ${w.save.toUpperCase()} DC ${w.dc}` : `${signed(w.attackBonus)} за удар`}, ${w.damage} ${w.damageType || ''}, обхват ${w.range || 5} фута`,
        onclick: () => (armed('attack', i) ? disarm() : armTarget({ type: 'attack', characterId: c.id, index: i })),
      }, `🗡 ${w.name}`))),
      (c.features || []).length ? h('div', { class: 'action-row' }, ...(c.features || []).map((f, i) => h('button', {
        class: armed('feature', i) ? 'armed' : '',
        disabled: f.uses <= 0 || c.hp <= 0 || (f.bonus ? bonusUsed : actionUsed),
        title: `${f.dice} HP${f.bonus ? ' · бонус действие' : ''}`,
        onclick: () => {
          if (f.self) emit('combat:feature', { characterId: c.id, featureIndex: i });
          else if (armed('feature', i)) disarm();
          else armTarget({ type: 'feature', characterId: c.id, index: i });
        },
      }, `✨ ${f.name} (${f.uses}/${f.maxUses})`))) : null,
      !(c.weapons || []).length ? h('p', { class: 'hint' }, 'Този герой няма оръжия. Създай го чрез „Създай герой“ или дай оръжие от Библиотеката.') : null,
      turnBased() ? h('div', { class: 'action-status' }, `Действие: ${actionUsed ? 'използвано' : 'свободно'} · Бонус: ${bonusUsed ? 'използван' : 'свободен'} · Движение: влачи токена си`) : null,
      myTurn && turnBased() ? h('button', { class: 'primary', onclick: () => { disarm(); emit('init:end'); } }, 'Край на хода ⏭') : null,
    ));
  }

  function renderInit() {
    const v = app.view;
    $('#init-round').textContent = v.initiative.round;
    renderActions();
    $('#init-list').replaceChildren(...v.initiative.entries.map((e) => {
      const token = e.tokenId && v.tokens.find((t) => t.id === e.tokenId);
      const char = e.characterId && v.characters.find((c) => c.id === e.characterId);
      const out = (token && token.dead) || (char && char.hp <= 0);
      return h('li', {
        class: `${e.id === v.initiative.currentId ? 'current' : ''}${e.hidden ? ' hidden-entry' : ''}`,
        style: out ? { opacity: 0.45 } : null,
      },
      h('span', { class: 'val' }, e.value),
      h('span', { class: 'name' }, e.name, e.hidden ? ' (скрит)' : '', out ? ' ✖' : ''),
      v.isDM ? h('button', { title: 'Премахни', onclick: () => emit('init:remove', { id: e.id }) }, '✕') : null);
    }));
    if (v.initiative.entries.length === 0) {
      $('#init-list').append(h('li', { class: 'hint' }, isAI() ? 'Няма битка. Започнете среща от раздел „Сесия“.' : 'Няма битка. Хвърлете инициатива, за да започнете.'));
    }
    $('#init-my-chars').replaceChildren(...(isAI() ? [] : myCharacters().map((c) => h('button', {
      onclick: () => emit('init:roll', { characterId: c.id }),
    }, `⚔ Инициатива: ${c.name}`))));
  }

  $('#init-next').addEventListener('click', () => emit('init:next'));
  $('#init-prev').addEventListener('click', () => emit('init:prev'));
  $('#init-clear').addEventListener('click', () => {
    if (confirm('Да изчистя ли инициативата?')) emit('init:clear');
  });
  $('#init-add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const res = await emit('init:add', { name: f.name.value, value: f.value.value });
    if (res.ok) f.reset();
  });

  // ----- Session tab -----

  function renderSession() {
    const v = app.view;
    const adv = v.adventure;
    const status = $('#adventure-status');
    if (adv) {
      status.replaceChildren(h('div', { class: 'adv-status' },
        h('h3', {}, `📜 ${adv.title}`),
        h('div', { class: 'hint' }, `Ниво ${adv.level} · ${THEME_BG[adv.theme] || adv.theme} · ${STATUS_BG[adv.status] || adv.status}`),
        h('p', {}, adv.summary),
        h('ol', {}, ...adv.encounters.map((e, i) => h('li', {
          class: i < adv.index || (i === adv.index && adv.status !== 'combat') ? 'done' : i === adv.index ? 'now' : '',
        }, e.title, v.isDM && e.monsters ? h('span', { class: 'hint' }, ` — ${e.monsters.map(([m, n]) => `${n}× ${m}`).join(', ')}`) : null))),
        adv.twist ? h('p', { class: 'hint' }, `🔮 Обрат: ${adv.twist}`) : null,
      ));
    } else {
      status.replaceChildren(h('p', { class: 'hint' }, isAI()
        ? 'Още няма приключение. Домакинът избира готово приключение или създава случайно.'
        : 'Избери готово приключение или създай напълно случайно. Можеш и да водиш свободно без приключение.'));
    }

    const controls = $('#session-controls');
    const buttons = [];
    if (adv) {
      const next = adv.index + 1 < adv.encounters.length;
      if ((adv.status === 'ready' || adv.status === 'cleared') && next) {
        buttons.push(h('button', { class: 'primary', onclick: () => emit('adventure:next') }, adv.status === 'ready' ? '⚔️ Започни първата среща' : '⚔️ Продължи към следващата среща'));
      }
      if (adv.status === 'cleared' || adv.status === 'ready' || adv.status === 'victory') {
        buttons.push(h('button', { onclick: () => emit('adventure:rest') }, '🔥 Почивка (пълно възстановяване)'));
      }
      if (adv.status === 'defeat') buttons.push(h('button', { class: 'primary', onclick: () => emit('adventure:retry') }, '⏳ Опитай срещата отново'));
      buttons.push(h('button', { class: 'danger', onclick: () => { if (confirm('Да прекратя ли приключението?')) emit('adventure:clear'); } }, 'Прекрати приключението'));
    }
    if (!isAI()) {
      buttons.push(h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: v.autoMonsters, onchange: (e) => emit('settings:update', { autoMonsters: e.target.checked }) }),
        '🤖 Компютърът играе чудовищата'));
    }
    controls.replaceChildren(...buttons);

    $('#adventure-list').replaceChildren(...app.adventures.map((a) => h('div', { class: 'adv-card' },
      h('strong', {}, a.title),
      h('span', { class: 'meta' }, `Ниво ${a.level} · ${THEME_BG[a.theme]} · ${a.encounters} срещи`),
      h('p', {}, a.summary),
      h('button', {
        onclick: () => {
          if (adv && !confirm('Текущото приключение ще бъде заменено. Продължаваме?')) return;
          emit('adventure:load', { id: a.id });
        },
      }, 'Зареди приключението'))));
  }

  $('#random-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    if (app.view.adventure && !confirm('Текущото приключение ще бъде заменено. Продължаваме?')) return;
    emit('adventure:load', { random: { level: f.level.value || undefined, encounters: f.encounters.value, theme: f.theme.value || undefined } });
  });
  $('#gen-map').addEventListener('click', () => emit('map:generate', { theme: $('#map-theme').value }));

  // ----- Library -----

  $$('#lib-kinds button').forEach((b) => b.addEventListener('click', () => {
    app.libKind = b.dataset.kind;
    $$('#lib-kinds button').forEach((x) => x.classList.toggle('active', x === b));
    $('#lib-detail').classList.add('hidden');
    renderLibrary();
  }));
  $('#lib-search').addEventListener('input', debounce(renderLibrary, 150));

  function crText(cr) {
    return cr === 0.125 ? '1/8' : cr === 0.25 ? '1/4' : cr === 0.5 ? '1/2' : String(cr);
  }

  function libRow(image, icon, title, meta, onclick) {
    return h(onclick ? 'button' : 'div', { class: 'lib-row', onclick },
      h('span', { class: 'thumb' }, picture(image, icon, title)),
      h('span', {}, h('div', {}, h('strong', {}, title)), h('div', { class: 'meta' }, meta)));
  }

  function renderLibrary() {
    const c = app.catalog;
    const out = $('#lib-results');
    if (!c) return;
    const q = $('#lib-search').value.trim().toLowerCase();
    const match = (s) => !q || String(s).toLowerCase().includes(q);
    let rows = [];
    if (app.libKind === 'monsters') {
      rows = c.monsters.filter((m) => match(m.name) || match(m.type)).sort((a, b) => a.cr - b.cr || a.name.localeCompare(b.name))
        .map((m) => libRow(m.image, m.icon, m.name, `CR ${crText(m.cr)} · ${c.typeNames[m.type.split(' ')[0]] || m.type} · ${m.hp} HP · AC ${m.ac}`, () => openLibrary('monsters', m.id)));
    } else if (app.libKind === 'items') {
      rows = c.items.filter((i) => match(i.name) || match(i.kind) || match(i.rarity))
        .map((i) => libRow(i.image, i.icon, i.name, [i.kind, i.rarity !== 'Common' ? i.rarity : null, i.damage, i.armorClass ? `AC ${i.armorClass}` : null, i.cost].filter(Boolean).join(' · '), () => openLibrary('items', i.id)));
    } else if (app.libKind === 'spells') {
      rows = c.spells.filter((s) => match(s.name) || match(s.school)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
        .map((s) => libRow(null, 'scroll', s.name, `${s.level ? `Ниво ${s.level}` : 'Заговор'} · ${s.school} · ${s.classes.join(', ')}`, () => openLibrary('spells', s.id)));
    } else {
      rows = [
        h('strong', {}, 'Раси'),
        ...c.races.filter((r) => match(r.name) || match(r.nameBg)).map((r) => libRow(null, 'humanoid', `${r.nameBg} (${r.name})`,
          `${Object.entries(r.bonuses).map(([a, b]) => `${a.toUpperCase()} +${b}`).join(', ')} · ${r.speed} фута · ${r.traits.join(', ')}`, null)),
        h('strong', {}, 'Класове'),
        ...c.classes.filter((k) => match(k.name) || match(k.nameBg)).map((k) => libRow(null, k.icon, `${k.nameBg} (${k.name})`,
          `d${k.hitDie} живот · спас. хвърлеи ${k.saves.map((s) => s.toUpperCase()).join(', ')}`, null)),
      ];
    }
    const total = rows.length;
    out.replaceChildren(...rows.slice(0, 80), total > 80 ? h('p', { class: 'hint' }, `…и още ${total - 80}. Уточни търсенето.`) : null);
  }

  async function openLibrary(kind, id) {
    selectTab('library');
    if (app.libKind !== kind) {
      app.libKind = kind;
      $$('#lib-kinds button').forEach((x) => x.classList.toggle('active', x.dataset.kind === kind));
      renderLibrary();
    }
    const box = $('#lib-detail');
    box.classList.remove('hidden');
    box.replaceChildren(h('p', { class: 'hint' }, 'Зареждане…'));
    let data;
    try {
      const res = await fetch(`api/${kind}/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
    } catch {
      box.replaceChildren(h('p', { class: 'error' }, 'Не успях да заредя данните.'));
      return;
    }
    const close = h('button', { class: 'ghost', onclick: () => box.classList.add('hidden') }, '✕ Затвори');
    if (kind === 'monsters') box.replaceChildren(...monsterDetail(data), close);
    else if (kind === 'items') box.replaceChildren(...itemDetail(data), close);
    else box.replaceChildren(...spellDetail(data), close);
    box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function heroImage(image, icon, alt) {
    const img = picture(image, icon, alt);
    img.classList.add('hero-img');
    return img;
  }

  function monsterDetail(m) {
    const v = app.view;
    const parts = [
      heroImage(m.image, m.icon, m.name),
      h('h3', {}, m.name),
      h('div', { class: 'hint' }, `${m.size} ${m.type}, ${m.alignment} · CR ${crText(m.cr)} (${m.xp} XP)`),
      h('dl', {},
        h('dt', {}, 'Броня'), h('dd', {}, m.ac),
        h('dt', {}, 'Живот'), h('dd', {}, `${m.hp} (${m.hitDice})`),
        h('dt', {}, 'Скорост'), h('dd', {}, m.speedText),
        m.senses ? [h('dt', {}, 'Сетива'), h('dd', {}, m.senses)] : null,
        m.languages ? [h('dt', {}, 'Езици'), h('dd', {}, m.languages)] : null),
      h('div', { class: 'stat-row' }, ...ABILITIES.map(([k, n]) => h('div', {}, n, h('b', {}, `${m.abilities[k]} (${signed(abilityMod(m.abilities[k]))})`)))),
      ...m.special.map((s) => h('p', { class: 'act' }, h('strong', {}, `${s.name}. `), s.desc)),
      m.actions.length ? h('strong', {}, 'Действия') : null,
      ...m.actions.map((a) => h('p', { class: 'act' }, h('strong', {}, `${a.name}. `), a.desc)),
      ...(m.legendary.length ? [h('strong', {}, 'Легендарни действия'), ...m.legendary.map((a) => h('p', { class: 'act' }, h('strong', {}, `${a.name}. `), a.desc))] : []),
    ];
    if (v && v.isDM) {
      const count = h('input', { type: 'number', min: 1, max: 12, value: 1, class: 'num' });
      const hidden = h('input', { type: 'checkbox' });
      parts.push(h('div', { class: 'row' },
        h('label', {}, 'Брой', count),
        h('label', {}, hidden, 'Скрит'),
        h('button', {
          class: 'primary',
          onclick: async () => {
            const n = Math.max(1, Math.min(12, parseInt(count.value, 10) || 1));
            const size = { Large: 2, Huge: 3, Gargantuan: 4 }[m.size] || 1;
            const cells = freeCells(n, size);
            for (let i = 0; i < n; i += 1) {
              // eslint-disable-next-line no-await-in-loop
              await emit('token:add', { monsterId: m.id, label: n > 1 ? `${m.name} ${i + 1}` : m.name, hidden: hidden.checked, ...cells[i] });
            }
            toast(`${m.name} е на картата`);
          },
        }, '📍 Постави на картата')));
    }
    return parts;
  }

  function itemDetail(it) {
    const v = app.view;
    const parts = [
      heroImage(it.image, it.icon, it.name),
      h('h3', {}, it.name),
      h('div', { class: 'hint' }, [it.kind, it.rarity, it.cost, it.weight ? `${it.weight} lb` : null].filter(Boolean).join(' · ')),
      it.damage ? h('div', {}, `Щета: ${it.damage} ${it.damageType || ''}${it.ranged ? ` · обхват ${it.range} фута` : ''}`) : null,
      it.armorClass ? h('div', {}, `Броня: AC ${it.armorClass}${it.dexBonus ? ' + Ловкост' : ''}${it.maxDex ? ` (макс. ${it.maxDex})` : ''}`) : null,
      it.desc ? h('p', { class: 'act' }, it.desc) : null,
    ];
    if (v && v.isController && v.characters.length) {
      const sel = h('select', {}, ...v.characters.map((c) => h('option', { value: c.id }, c.name)));
      parts.push(h('div', { class: 'row' }, sel,
        h('button', { class: 'primary', onclick: () => emit('char:giveItem', { characterId: sel.value, itemId: it.id }) }, '🎁 Дай на героя')));
    }
    return parts;
  }

  function spellDetail(s) {
    return [
      h('h3', {}, s.name),
      h('div', { class: 'hint' }, `${s.level ? `Ниво ${s.level}` : 'Заговор'} · ${s.school} · ${s.classes.join(', ')}`),
      h('dl', {},
        h('dt', {}, 'Време'), h('dd', {}, s.castingTime),
        h('dt', {}, 'Обхват'), h('dd', {}, s.range),
        h('dt', {}, 'Трае'), h('dd', {}, `${s.duration}${s.concentration ? ' (концентрация)' : ''}`)),
      h('p', { class: 'act' }, s.desc),
    ];
  }

  // ----- DM tools -----

  function renderDM() {
    const v = app.view;
    if (!v.isDM) return;
    $('#auto-monsters').checked = v.autoMonsters;
    const f = $('#map-form');
    for (const k of ['background', 'cols', 'rows', 'gridSize']) {
      if (f[k] !== document.activeElement) f[k].value = v.map[k];
    }
  }

  $('#auto-monsters').addEventListener('change', (e) => emit('settings:update', { autoMonsters: e.target.checked }));

  $('#map-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const res = await emit('map:update', {
      background: f.background.value, cols: f.cols.value, rows: f.rows.value, gridSize: f.gridSize.value,
    });
    if (res.ok) toast('Картата е обновена');
  });

  $('#monster-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const count = Math.max(1, Math.min(20, parseInt(f.count.value, 10) || 1));
    const size = parseInt(f.size.value, 10) || 1;
    const cells = freeCells(count, size);
    // Snapshot the form: the DM may already be typing the next monster.
    const base = { hp: f.hp.value, color: f.color.value, size, hidden: f.hidden.checked };
    const name = f.label.value;
    for (let i = 0; i < count; i += 1) {
      const label = count > 1 ? `${name} ${i + 1}` : name;
      // eslint-disable-next-line no-await-in-loop
      await emit('token:add', { ...base, label, ...cells[i] });
    }
    toast(count > 1 ? `Добавени ${count} токена` : 'Токенът е добавен');
  });

  // ----- Selected token panel -----

  function renderTokenPanel() {
    const v = app.view;
    const panel = $('#token-panel');
    const t = v.tokens.find((x) => x.id === app.selectedToken);
    if (!t) {
      panel.classList.add('hidden');
      panel.dataset.for = '';
      return;
    }
    panel.classList.remove('hidden');
    if (panel.dataset.for === t.id && panel.contains(document.activeElement)) return;
    panel.dataset.for = t.id;

    const char = t.characterId && v.characters.find((c) => c.id === t.characterId);
    const close = h('button', { class: 'ghost', onclick: () => { app.selectedToken = null; render(); } }, '✕');
    const header = h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
      h('strong', {}, t.label, t.hidden ? ' (скрит)' : '', t.dead ? ' — повален' : ''), close);
    const parts = [header];

    if (char) {
      parts.push(h('div', {}, `❤ ${char.hp}/${char.maxHp} · 🛡 ${char.ac} · скорост ${char.speed}`));
      parts.push(h('button', { onclick: () => { selectTab('chars'); app.selectedChar = char.id; renderChars(); } }, 'Отвори листа на героя'));
    } else if (!v.isDM && t.hpPct !== null && t.hpPct !== undefined) {
      const state = t.dead ? 'повален' : t.hpPct >= 100 ? 'невредим' : t.hpPct > 50 ? 'леко ранен' : t.hpPct > 25 ? 'кърви' : 'едва се държи';
      parts.push(h('div', {}, `Състояние: ${state}`));
    }
    if (t.monsterId) parts.push(h('button', { onclick: () => openLibrary('monsters', t.monsterId) }, '📖 Виж в библиотеката'));

    if (v.isDM) {
      const update = (patch) => emit('token:update', { id: t.id, patch });
      if (!char) {
        const hpIn = h('input', { type: 'number', class: 'num', value: t.hp ?? '', onchange: (e) => update({ hp: e.target.value }) });
        const maxIn = h('input', { type: 'number', class: 'num', value: t.maxHp ?? '', onchange: (e) => update({ maxHp: e.target.value }) });
        const delta = h('input', { type: 'number', class: 'num', placeholder: '±' });
        parts.push(h('div', { class: 'row' },
          h('label', {}, 'Име', h('input', { value: t.label, maxlength: 40, onchange: (e) => update({ label: e.target.value }) })),
          h('label', {}, 'AC', h('input', { type: 'number', class: 'num', value: t.ac ?? '', onchange: (e) => update({ ac: e.target.value }) }))));
        parts.push(h('div', { class: 'row' },
          h('label', {}, 'HP', hpIn), h('label', {}, 'Макс.', maxIn),
          delta,
          h('button', { class: 'danger', onclick: () => { const d = parseInt(delta.value, 10); if (d) update({ hp: (t.hp || 0) - Math.abs(d) }); } }, 'Щета'),
          h('button', { onclick: () => { const d = parseInt(delta.value, 10); if (d) update({ hp: Math.min(t.maxHp || Infinity, (t.hp || 0) + Math.abs(d)) }); } }, 'Лек')));
      }
      const sizeSel = h('select', { onchange: (e) => update({ size: e.target.value }) },
        ...[1, 2, 3, 4].map((n) => h('option', { value: n }, `${n}×${n}`)));
      sizeSel.value = String(t.size);
      parts.push(h('div', { class: 'row' },
        h('label', {}, 'Размер', sizeSel),
        h('label', {}, h('input', { type: 'checkbox', checked: Boolean(t.hidden), onchange: (e) => update({ hidden: e.target.checked }) }), 'Скрит от играчите')));
      if (!char) {
        parts.push(h('div', { class: 'row' },
          h('button', { onclick: () => emit('init:add', { name: t.label, tokenId: t.id, roll: true, hidden: t.hidden }) }, '⚔ Таен d20 за инициатива'),
          t.monsterId ? h('button', { onclick: () => emit('token:auto', { id: t.id }) }, '🤖 Изиграй хода му') : null));
      }
    }
    if (canMoveToken(t)) {
      parts.push(h('button', { class: 'danger', onclick: () => emit('token:remove', { id: t.id }) }, 'Махни от картата'));
    }
    panel.replaceChildren(...parts);
  }

  // ----- Tabs -----

  function selectTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    if (name === 'chat') $('#log').scrollTop = $('#log').scrollHeight;
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  // ---------- Boot ----------

  const hashCode = location.hash.replace('#', '').toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(hashCode)) {
    $('#join-form').code.value = hashCode;
    const s = readSessions()[hashCode];
    if (s && s.playerId) {
      app.code = hashCode; // the connect handler will rejoin
      showGame();
    } else {
      $('#join-form').name.focus();
    }
  }
  renderRecent();
})();
