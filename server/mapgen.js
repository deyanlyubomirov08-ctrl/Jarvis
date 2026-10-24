'use strict';

// Procedural battle maps. A map is an array of strings, one char per cell:
//   '#' wall/rock   '.' floor   ',' grass   'T' tree   '~' water
//   '=' bridge      '+' door
// Plus `areas` (rectangles where encounters are placed) and `start`.

const BLOCKING = new Set(['#', 'T', '~']);
const THEMES = ['dungeon', 'crypt', 'cave', 'forest', 'swamp'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

function grid(cols, rows, ch) {
  return Array.from({ length: rows }, () => Array(cols).fill(ch));
}

function toStrings(g) {
  return g.map((r) => r.join(''));
}

function isPassable(tiles, x, y) {
  if (!tiles || !tiles.length) return true;
  if (y < 0 || y >= tiles.length || x < 0 || x >= tiles[0].length) return false;
  return !BLOCKING.has(tiles[y][x]);
}

function carveCorridor(g, a, b, rng, ch = '.') {
  let { x, y } = a;
  const horizontalFirst = rng() < 0.5;
  const stepX = () => { while (x !== b.x) { g[y][x] = ch; x += Math.sign(b.x - x); } };
  const stepY = () => { while (y !== b.y) { g[y][x] = ch; y += Math.sign(b.y - y); } };
  if (horizontalFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
  g[y][x] = ch;
}

const center = (r) => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });

function dungeon(cols, rows, rng) {
  const g = grid(cols, rows, '#');
  const rooms = [];
  for (let tries = 0; tries < 200 && rooms.length < 8; tries += 1) {
    const w = randInt(rng, 4, 8);
    const h = randInt(rng, 4, 6);
    const r = { x: randInt(rng, 1, cols - w - 2), y: randInt(rng, 1, rows - h - 2), w, h };
    const overlaps = rooms.some((o) => r.x <= o.x + o.w + 1 && o.x <= r.x + r.w + 1 && r.y <= o.y + o.h + 1 && o.y <= r.y + r.h + 1);
    if (overlaps) continue;
    rooms.push(r);
  }
  rooms.sort((a, b) => a.x - b.x);
  for (const r of rooms) for (let y = r.y; y < r.y + r.h; y += 1) for (let x = r.x; x < r.x + r.w; x += 1) g[y][x] = '.';
  for (let i = 1; i < rooms.length; i += 1) carveCorridor(g, center(rooms[i - 1]), center(rooms[i]), rng);
  // Doors where corridors enter rooms.
  for (const r of rooms) {
    for (let x = r.x; x < r.x + r.w; x += 1) {
      for (const y of [r.y - 1, r.y + r.h]) if (g[y] && g[y][x] === '.' && rng() < 0.6) g[y][x] = '+';
    }
    for (let y = r.y; y < r.y + r.h; y += 1) {
      for (const x of [r.x - 1, r.x + r.w]) if (g[y][x] === '.' && rng() < 0.6) g[y][x] = '+';
    }
  }
  return { tiles: toStrings(g), areas: rooms, start: center(rooms[0]) };
}

function floodLargest(g, passable) {
  const rows = g.length;
  const cols = g[0].length;
  const seen = grid(cols, rows, false);
  let best = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (seen[y][x] || !passable(g[y][x])) continue;
      const region = [];
      const stack = [[x, y]];
      seen[y][x] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[ny][nx] || !passable(g[ny][nx])) continue;
          seen[ny][nx] = true;
          stack.push([nx, ny]);
        }
      }
      if (region.length > best.length) best = region;
    }
  }
  return best;
}

// Chooses encounter areas spread out across a set of floor cells.
function spreadAreas(cells, count, rng, size = 5) {
  const areas = [];
  const start = cells.reduce((a, b) => (a[0] + a[1] <= b[0] + b[1] ? a : b));
  const points = [start];
  for (let i = 0; i < count; i += 1) {
    let best = null;
    let bestD = -1;
    for (let k = 0; k < 40; k += 1) {
      const c = cells[Math.floor(rng() * cells.length)];
      const d = Math.min(...points.map((p) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1])));
      if (d > bestD) { bestD = d; best = c; }
    }
    points.push(best);
  }
  for (const [x, y] of points) {
    areas.push({ x: Math.max(0, x - Math.floor(size / 2)), y: Math.max(0, y - Math.floor(size / 2)), w: size, h: size });
  }
  return { areas, start: { x: start[0], y: start[1] } };
}

function keepOnly(g, region, fill) {
  const keep = new Set(region.map(([x, y]) => `${x},${y}`));
  for (let y = 0; y < g.length; y += 1) {
    for (let x = 0; x < g[0].length; x += 1) if (!BLOCKING.has(g[y][x]) && !keep.has(`${x},${y}`)) g[y][x] = fill;
  }
}

function cave(cols, rows, rng) {
  let g = grid(cols, rows, '#').map((r, y) => r.map((_, x) => (x === 0 || y === 0 || x === cols - 1 || y === rows - 1 || rng() < 0.44 ? '#' : '.')));
  for (let iter = 0; iter < 5; iter += 1) {
    g = g.map((r, y) => r.map((_, x) => {
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) return '#';
      let walls = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if (g[y + dy][x + dx] === '#') walls += 1;
      return walls >= 5 ? '#' : '.';
    }));
  }
  // A few underground pools.
  for (let i = 0; i < 2; i += 1) {
    const cx = randInt(rng, 4, cols - 5);
    const cy = randInt(rng, 3, rows - 4);
    for (let y = cy - 1; y <= cy + 1; y += 1) for (let x = cx - 2; x <= cx + 2; x += 1) if (g[y][x] === '.' && rng() < 0.8) g[y][x] = '~';
  }
  const region = floodLargest(g, (c) => !BLOCKING.has(c));
  keepOnly(g, region, '#');
  return { tiles: toStrings(g), ...spreadAreas(region, 6, rng) };
}

function outdoors(cols, rows, rng, swamp) {
  const g = grid(cols, rows, ',');
  const treeChance = swamp ? 0.1 : 0.16;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const edge = x === 0 || y === 0 || x === cols - 1 || y === rows - 1;
      if (edge || rng() < treeChance) g[y][x] = 'T';
    }
  }
  if (swamp) {
    for (let i = 0; i < 9; i += 1) {
      const cx = randInt(rng, 3, cols - 4);
      const cy = randInt(rng, 2, rows - 3);
      const rx = randInt(rng, 1, 3);
      for (let y = cy - 1; y <= cy + 1; y += 1) for (let x = cx - rx; x <= cx + rx; x += 1) g[y][x] = '~';
    }
  } else {
    // A river with a bridge.
    let x = randInt(rng, Math.floor(cols / 3), Math.floor((2 * cols) / 3));
    const bridgeY = randInt(rng, 3, rows - 4);
    for (let y = 1; y < rows - 1; y += 1) {
      g[y][x] = y === bridgeY ? '=' : '~';
      g[y][x + 1] = y === bridgeY ? '=' : '~';
      if (rng() < 0.3) x = Math.min(cols - 3, Math.max(2, x + (rng() < 0.5 ? -1 : 1)));
      g[y][x] = y === bridgeY ? '=' : g[y][x];
    }
  }
  // A winding trail keeps both sides connected.
  let y = randInt(rng, 2, rows - 3);
  for (let x2 = 1; x2 < cols - 1; x2 += 1) {
    if (g[y][x2] === 'T') g[y][x2] = '.';
    else if (g[y][x2] === '~') g[y][x2] = '=';
    else if (g[y][x2] === ',') g[y][x2] = '.';
    if (rng() < 0.25) y = Math.min(rows - 2, Math.max(1, y + (rng() < 0.5 ? -1 : 1)));
    if (g[y][x2] === 'T') g[y][x2] = '.';
    else if (g[y][x2] === '~') g[y][x2] = '=';
  }
  const region = floodLargest(g, (c) => !BLOCKING.has(c));
  keepOnly(g, region, 'T');
  return { tiles: toStrings(g), ...spreadAreas(region, 6, rng) };
}

function generate(theme = 'dungeon', cols = 30, rows = 20, seed = Date.now()) {
  const rng = mulberry32(seed);
  const t = THEMES.includes(theme) ? theme : 'dungeon';
  let out;
  if (t === 'cave') out = cave(cols, rows, rng);
  else if (t === 'forest') out = outdoors(cols, rows, rng, false);
  else if (t === 'swamp') out = outdoors(cols, rows, rng, true);
  else out = dungeon(cols, rows, rng);
  return { theme: t, cols, rows, seed, ...out };
}

// Finds `count` free passable cells for tokens of `size` inside an area,
// spiralling outwards if the area is full.
function placeIn(tiles, cols, rows, area, count, occupied, size = 1) {
  const out = [];
  const cx = area.x + Math.floor(area.w / 2);
  const cy = area.y + Math.floor(area.h / 2);
  const fits = (x, y) => {
    if (x < 0 || y < 0 || x + size > cols || y + size > rows) return false;
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        if (!isPassable(tiles, x + i, y + j) || occupied.has(`${x + i},${y + j}`)) return false;
      }
    }
    return true;
  };
  for (let r = 0; r < Math.max(cols, rows) && out.length < count; r += 1) {
    for (let dy = -r; dy <= r && out.length < count; dy += 1) {
      for (let dx = -r; dx <= r && out.length < count; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!fits(x, y)) continue;
        out.push({ x, y });
        for (let i = 0; i < size; i += 1) for (let j = 0; j < size; j += 1) occupied.add(`${x + i},${y + j}`);
      }
    }
  }
  return out;
}

module.exports = { generate, isPassable, placeIn, mulberry32, THEMES, BLOCKING };
