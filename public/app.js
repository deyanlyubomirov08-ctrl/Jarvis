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
  const abilityMod = (score) => Math.floor((score - 10) / 2);
  const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

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
    zoom: 1,
    sheetFor: null,  // character id the sheet DOM was built for
    rollMode: 'normal',
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
    const list = $('#recent-list');
    list.replaceChildren(...sessions.map(([code, s]) => h('li', {},
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

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const res = await emit('room:create', { roomName: f.get('roomName'), name: f.get('name') });
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
    renderLog(true);
  });

  socket.on('message', (msg) => {
    app.log.push(msg);
    if (app.log.length > 300) app.log.shift();
    appendMessage(msg, true);
  });

  // ---------- Rendering ----------

  function myCharacters() {
    const v = app.view;
    return v.characters.filter((c) => v.isDM || c.ownerId === v.me);
  }

  function canEditChar(c) {
    return app.view.isDM || c.ownerId === app.view.me;
  }

  function render() {
    const v = app.view;
    if (!v) return;
    document.body.classList.toggle('is-dm', v.isDM);
    $('#room-name').textContent = v.name;
    $('#room-code').textContent = v.code;
    document.title = `${v.name} — Таверната`;
    if (!v.isDM && $('.tabs button.active')?.dataset.tab === 'dm') selectTab('chat');
    if (app.selectedToken && !v.tokens.some((t) => t.id === app.selectedToken)) app.selectedToken = null;
    if (app.selectedChar && !v.characters.some((c) => c.id === app.selectedChar)) app.selectedChar = null;

    renderPlayers();
    renderMap();
    renderChars();
    renderInit();
    renderDM();
    renderTokenPanel();
  }

  function renderPlayers() {
    const v = app.view;
    $('#player-list').replaceChildren(...v.players
      .sort((a, b) => Number(b.isDM) - Number(a.isDM))
      .map((p) => h('span', {
        class: `player${p.online ? '' : ' offline'}${p.isDM ? ' dm' : ''}`,
        title: p.online ? 'На линия' : 'Извън линия',
      }, `${p.isDM ? '👑 ' : ''}${p.name}${p.id === v.me ? ' (ти)' : ''}`)));
  }

  // ----- Map -----

  function currentTokenId() {
    const v = app.view;
    const e = v.initiative.entries.find((x) => x.id === v.initiative.currentId);
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
    board.style.backgroundImage = background ? `url(${JSON.stringify(background)})` : '';
    board.style.transform = `scale(${app.zoom})`;
    // Keep the scroll area matching the scaled board.
    board.style.marginRight = `${cols * cell * (app.zoom - 1) + 20}px`;
    board.style.marginBottom = `${rows * cell * (app.zoom - 1) + 20}px`;
    $('#zoom-label').textContent = `${Math.round(app.zoom * 100)}%`;

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
        background: t.color, fontSize: `${Math.max(10, size / 3.2)}px`,
      });
      el.classList.toggle('movable', canMoveToken(t));
      el.classList.toggle('selected', app.selectedToken === t.id);
      el.classList.toggle('hidden-token', Boolean(t.hidden));
      el.classList.toggle('current', current === t.id);
      el.title = t.label;

      let hp = null;
      let maxHp = null;
      if (char) { hp = char.hp; maxHp = char.maxHp; } else if (t.maxHp) { hp = t.hp; maxHp = t.maxHp; }
      const children = [h('span', { class: 'initials' }, initials(t.label)), h('span', { class: 'tname' }, t.label)];
      if (maxHp) {
        const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
        const color = pct > 50 ? '#27ae60' : pct > 20 ? '#f39c12' : '#c0392b';
        children.push(h('span', { class: 'hpbar' }, h('i', { style: { width: `${pct}%`, background: color } })));
      }
      el.replaceChildren(...children);
    }
    for (const el of existing.values()) el.remove();
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
      start = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop, moved: false, movable: canMoveToken(t) };
      if (start.movable) el.setPointerCapture(e.pointerId);
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

  // Finds free cells close to the visible top-left corner of the map.
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
    const out = [];
    for (let y = startY; y <= v.map.rows - size && out.length < count; y += size) {
      for (let x = startX; x <= v.map.cols - size && out.length < count; x += size) {
        let free = true;
        for (let i = 0; i < size && free; i += 1) for (let j = 0; j < size && free; j += 1) if (taken.has(`${x + i},${y + j}`)) free = false;
        if (free) {
          out.push({ x, y });
          for (let i = 0; i < size; i += 1) for (let j = 0; j < size; j += 1) taken.add(`${x + i},${y + j}`);
        }
      }
    }
    while (out.length < count) out.push({ x: startX, y: startY });
    return out;
  }

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
    return h('div', { class: 'msg' },
      h('span', { class: 'time' }, fmtTime(msg.ts)),
      h('span', { class: 'who' }, `${msg.author}:`), msg.text);
  }

  function appendMessage(msg, scroll) {
    const log = $('#log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.append(messageNode(msg));
    while (log.childElementCount > 300) log.firstElementChild.remove();
    if (scroll && nearBottom) log.scrollTop = log.scrollHeight;
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

  $('#new-char-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await emit('char:create', { name: e.target.name.value });
    if (res.ok) {
      e.target.reset();
      app.selectedChar = res.id;
      render();
    }
  });

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
      h('span', { class: 'dot', style: { background: c.color } }),
      h('span', {},
        h('div', {}, h('strong', {}, c.name)),
        h('div', { class: 'meta' }, [c.race, c.cls && `${c.cls} ${c.level}`, owner && `играч: ${owner.name}`].filter(Boolean).join(' · '))),
      h('span', { class: 'hp' }, `❤ ${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp})` : ''} · 🛡 ${c.ac}`));
    }));
    if (chars.length === 0) list.append(h('p', { class: 'hint' }, 'Още няма герои. Създай първия си герой отгоре.'));
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
      for (const [k, v] of Object.entries(patch)) {
        cur[k] = typeof v === 'object' ? { ...(cur[k] || {}), ...v } : v;
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
      h('div', { class: 'row' },
        h('label', { style: { flex: 1 } }, 'Име', h('input', { dataset: { field: 'name' }, maxlength: 60 })),
        h('label', {}, 'Цвят', h('input', { type: 'color', dataset: { field: 'color' } }))),
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
        h('span', { class: 'hint', style: { marginLeft: 'auto' } }, 'Хвърляне:'),
        modeSelect) : null,
      h('div', { class: 'abilities' }, ...ABILITIES.map(abilityBox)),
      h('label', {}, 'Атаки и заклинания', h('textarea', { dataset: { field: 'attacks' }, maxlength: 4000, placeholder: 'Дълъг меч: +5, 1d8+3 режещи' })),
      h('label', {}, 'Инвентар', h('textarea', { dataset: { field: 'inventory' }, maxlength: 4000 })),
      h('label', {}, 'Бележки', h('textarea', { dataset: { field: 'notes' }, maxlength: 8000 })),
      editable ? h('div', { class: 'sheet-actions' },
        h('button', { onclick: () => emit('init:roll', { characterId: c.id }) }, '⚔ Инициатива'),
        h('button', { onclick: () => placeCharacter(c.id) }, '📍 На картата'),
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
        if (k === 'abilities') updateMods(c.id);
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
    // Sync values without clobbering what the user is typing.
    for (const el of $$('[data-field]', sheet)) {
      if (el === document.activeElement) continue;
      const [k, sub] = el.dataset.field.split('.');
      const value = sub ? c[k][sub] : c[k];
      if (el.type === 'checkbox') el.checked = Boolean(value);
      else if (String(el.value) !== String(value)) el.value = value;
    }
    updateMods();
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

  // ----- Initiative -----

  function renderInit() {
    const v = app.view;
    $('#init-round').textContent = v.initiative.round;
    $('#init-list').replaceChildren(...v.initiative.entries.map((e) => h('li', {
      class: `${e.id === v.initiative.currentId ? 'current' : ''}${e.hidden ? ' hidden-entry' : ''}`,
    },
    h('span', { class: 'val' }, e.value),
    h('span', { class: 'name' }, e.name, e.hidden ? ' (скрит)' : ''),
    v.isDM ? h('button', { title: 'Премахни', onclick: () => emit('init:remove', { id: e.id }) }, '✕') : null)));
    if (v.initiative.entries.length === 0) {
      $('#init-list').append(h('li', { class: 'hint' }, 'Няма битка. Хвърлете инициатива, за да започнете.'));
    }
    $('#init-my-chars').replaceChildren(...myCharacters().map((c) => h('button', {
      onclick: () => emit('init:roll', { characterId: c.id }),
    }, `⚔ Инициатива: ${c.name}`)));
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

  // ----- DM tools -----

  function renderDM() {
    const v = app.view;
    if (!v.isDM) return;
    const f = $('#map-form');
    for (const k of ['background', 'cols', 'rows', 'gridSize']) {
      if (f[k] !== document.activeElement) f[k].value = v.map[k];
    }
  }

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
    // Don't rebuild while the DM is typing in the panel.
    if (panel.dataset.for === t.id && panel.contains(document.activeElement)) return;
    panel.dataset.for = t.id;

    const char = t.characterId && v.characters.find((c) => c.id === t.characterId);
    const close = h('button', { class: 'ghost', onclick: () => { app.selectedToken = null; render(); } }, '✕');
    const header = h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
      h('strong', {}, t.label, t.hidden ? ' (скрит)' : ''), close);
    const parts = [header];

    if (char) {
      parts.push(h('div', {}, `❤ ${char.hp}/${char.maxHp} · 🛡 ${char.ac} · скорост ${char.speed}`));
      parts.push(h('button', { onclick: () => { selectTab('chars'); app.selectedChar = char.id; renderChars(); } }, 'Отвори листа на героя'));
    }

    if (v.isDM) {
      const update = (patch) => emit('token:update', { id: t.id, patch });
      if (!char) {
        const hpIn = h('input', { type: 'number', class: 'num', value: t.hp ?? '', onchange: (e) => update({ hp: e.target.value }) });
        const maxIn = h('input', { type: 'number', class: 'num', value: t.maxHp ?? '', onchange: (e) => update({ maxHp: e.target.value }) });
        const delta = h('input', { type: 'number', class: 'num', placeholder: '±' });
        parts.push(h('div', { class: 'row' },
          h('label', {}, 'Име', h('input', { value: t.label, maxlength: 40, onchange: (e) => update({ label: e.target.value }) })),
          h('label', {}, 'Цвят', h('input', { type: 'color', value: t.color, onchange: (e) => update({ color: e.target.value }) }))));
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
        parts.push(h('button', {
          onclick: () => emit('init:add', { name: t.label, tokenId: t.id, roll: true, hidden: t.hidden }),
        }, '⚔ Хвърли инициатива (таен d20)'));
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
