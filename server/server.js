'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const WLED_TIMEOUT_MS = 3000;

// Brilho máximo permitido (80% de 255). Aplicado dentro de sendToWLED,
// portanto vale para TODAS as rotas (inclusive /state bruto e playlists).
// Motivo: consumo, calor e glitch nos LEDs em brilho total.
const MAX_BRIGHTNESS = 204;

const DATA_DIR = path.join(__dirname, 'data');
const FLOORS_FILE = path.join(DATA_DIR, 'floors.json');
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Dados default
// ---------------------------------------------------------------------------

const DEFAULT_FLOORS = [
  { id: 1, name: '1º Andar', ip: '192.168.1.101' },
  { id: 2, name: '2º Andar', ip: '192.168.1.102' },
  { id: 3, name: '3º Andar', ip: '192.168.1.103' },
  { id: 4, name: '4º Andar', ip: '192.168.1.104' },
  { id: 5, name: '5º Andar', ip: '192.168.1.105' },
];

// pal 5 = "Colors Only": o efeito usa as 3 cores do segmento.
// Ids de efeito: 0 Solid, 13 Theater, 67 Colorwaves (conferir com o firmware real).
const DEFAULT_PLAYLISTS = [
  {
    id: 'outubro-rosa',
    name: 'Outubro Rosa',
    colors: ['#ff1493', '#ff69b4', '#ffb6c1'],
    fx: 67, sx: 96, ix: 128, pal: 5, bri: MAX_BRIGHTNESS,
  },
  {
    id: 'novembro-azul',
    name: 'Novembro Azul',
    colors: ['#0044ff', '#00aaff', '#66ccff'],
    fx: 67, sx: 96, ix: 128, pal: 5, bri: MAX_BRIGHTNESS,
  },
  {
    id: 'setembro-amarelo',
    name: 'Setembro Amarelo',
    colors: ['#ffd700', '#ffb300', '#fff176'],
    fx: 67, sx: 96, ix: 128, pal: 5, bri: MAX_BRIGHTNESS,
  },
  {
    id: 'natal',
    name: 'Natal',
    colors: ['#ff0000', '#00ff00', '#ffffff'],
    fx: 13, sx: 128, ix: 128, pal: 5, bri: MAX_BRIGHTNESS,
  },
  {
    id: 'branco',
    name: 'Branco',
    colors: ['#ffffff', '#ffffff', '#ffffff'],
    fx: 0, sx: 128, ix: 128, pal: 5, bri: MAX_BRIGHTNESS,
  },
];

// ---------------------------------------------------------------------------
// Persistência simples em JSON
// ---------------------------------------------------------------------------

function ensureDataFile(file, defaults) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
    return JSON.parse(JSON.stringify(defaults));
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Arquivo ${path.basename(file)} corrompido, restaurando padrão:`, err.message);
    fs.writeFileSync(file, JSON.stringify(defaults, null, 2));
    return JSON.parse(JSON.stringify(defaults));
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let floors = ensureDataFile(FLOORS_FILE, DEFAULT_FLOORS);
let playlists = ensureDataFile(PLAYLISTS_FILE, DEFAULT_PLAYLISTS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IP_REGEX = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEX_REGEX = /^#?([0-9a-f]{6})$/i;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function hexToRgb(hex) {
  const m = HEX_REGEX.exec(String(hex).trim());
  if (!m) return null;
  const int = parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function findFloorOr404(req, res) {
  const id = Number(req.params.id);
  const floor = floors.find((f) => f.id === id);
  if (!floor) {
    res.status(404).json({ error: `Andar ${req.params.id} não encontrado` });
    return null;
  }
  return floor;
}

/** Aplica o clamp de brilho recursivamente (raiz e segmentos). */
function clampBrightness(state) {
  if (!state || typeof state !== 'object') return state;
  const out = { ...state };
  if (out.bri !== undefined) out.bri = clampInt(out.bri, 0, MAX_BRIGHTNESS, MAX_BRIGHTNESS);
  if (Array.isArray(out.seg)) {
    out.seg = out.seg.map((seg) =>
      seg && seg.bri !== undefined
        ? { ...seg, bri: clampInt(seg.bri, 0, MAX_BRIGHTNESS, MAX_BRIGHTNESS) }
        : seg,
    );
  }
  return out;
}

async function wledFetch(ip, endpoint, options = {}) {
  const response = await fetch(`http://${ip}${endpoint}`, {
    ...options,
    signal: AbortSignal.timeout(WLED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`WLED ${ip} respondeu HTTP ${response.status}`);
  }
  return response.json();
}

/** Envia um objeto de estado ao WLED. Todo brilho passa pelo clamp aqui. */
function sendToWLED(ip, state) {
  const safe = clampBrightness(state);
  return wledFetch(ip, '/json/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(safe),
  });
}

function getWLEDState(ip) {
  return wledFetch(ip, '/json/state');
}

function getWLEDEffects(ip) {
  return wledFetch(ip, '/json/effects');
}

/** Aplica estado a um andar e responde ao cliente HTTP. */
async function applyState(req, res, state) {
  const floor = findFloorOr404(req, res);
  if (!floor) return;
  try {
    const result = await sendToWLED(floor.ip, state);
    res.json({ ok: true, floor: floor.id, result });
  } catch (err) {
    res.status(502).json({ ok: false, floor: floor.id, error: err.message });
  }
}

function errorMessage(err) {
  if (err && err.name === 'TimeoutError') return 'Tempo esgotado ao contatar o WLED';
  return err && err.message ? err.message : String(err);
}

/** Monta o estado WLED de uma playlist. */
function playlistToState(pl) {
  const cols = (pl.colors || []).map((c) => hexToRgb(c) || [0, 0, 0]);
  while (cols.length < 3) cols.push([0, 0, 0]);
  return {
    on: true,
    bri: clampInt(pl.bri, 0, MAX_BRIGHTNESS, MAX_BRIGHTNESS),
    seg: [
      {
        id: 0,
        col: cols.slice(0, 3),
        fx: clampInt(pl.fx, 0, 255, 0),
        sx: clampInt(pl.sx, 0, 255, 128),
        ix: clampInt(pl.ix, 0, 255, 128),
        pal: clampInt(pl.pal, 0, 255, 5),
      },
    ],
  };
}

function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'playlist';
}

function uniquePlaylistId(base) {
  let id = base;
  let i = 2;
  while (playlists.some((p) => p.id === id)) id = `${base}-${i++}`;
  return id;
}

/** Valida/normaliza o corpo de uma playlist. Retorna {value} ou {error}. */
function validatePlaylist(body, existing) {
  const name = body.name !== undefined ? String(body.name).trim() : existing?.name;
  if (!name) return { error: 'Nome da playlist é obrigatório' };

  let colors = existing ? existing.colors : ['#ffffff', '#ffffff', '#ffffff'];
  if (body.colors !== undefined) {
    if (!Array.isArray(body.colors) || body.colors.length !== 3) {
      return { error: 'colors deve ser um array com 3 cores hex' };
    }
    for (const c of body.colors) {
      if (!HEX_REGEX.test(String(c).trim())) return { error: `Cor inválida: ${c}` };
    }
    colors = body.colors.map((c) => {
      const t = String(c).trim().toLowerCase();
      return t.startsWith('#') ? t : `#${t}`;
    });
  }

  const pick = (key, min, max, def) =>
    body[key] !== undefined ? clampInt(body[key], min, max, def) : existing ? existing[key] : def;

  return {
    value: {
      id: existing ? existing.id : uniquePlaylistId(slugify(name)),
      name,
      colors,
      fx: pick('fx', 0, 255, 0),
      sx: pick('sx', 0, 255, 128),
      ix: pick('ix', 0, 255, 128),
      pal: pick('pal', 0, 255, 5),
      bri: pick('bri', 0, MAX_BRIGHTNESS, MAX_BRIGHTNESS),
    },
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/hello', (req, res) => {
  res.json({ message: 'WLED Building Controller online' });
});

app.get('/api/config', (req, res) => {
  res.json({ maxBrightness: MAX_BRIGHTNESS });
});

// ----- Andares --------------------------------------------------------------

app.get('/api/floors', (req, res) => {
  res.json(floors);
});

app.put('/api/floors/:id', (req, res) => {
  const floor = findFloorOr404(req, res);
  if (!floor) return;
  const { name, ip } = req.body || {};

  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) return res.status(400).json({ error: 'Nome não pode ser vazio' });
    floor.name = trimmed;
  }
  if (ip !== undefined) {
    const trimmed = String(ip).trim();
    if (!IP_REGEX.test(trimmed)) return res.status(400).json({ error: 'IP inválido' });
    floor.ip = trimmed;
  }

  saveJson(FLOORS_FILE, floors);
  res.json(floor);
});

app.get('/api/floors/:id/status', async (req, res) => {
  const floor = findFloorOr404(req, res);
  if (!floor) return;
  try {
    const state = await getWLEDState(floor.ip);
    res.json({ online: true, state });
  } catch (err) {
    res.json({ online: false, error: errorMessage(err) });
  }
});

app.get('/api/floors/:id/effects', async (req, res) => {
  const floor = findFloorOr404(req, res);
  if (!floor) return;
  try {
    const raw = await getWLEDEffects(floor.ip);
    const effects = [];
    raw.forEach((entry, id) => {
      if (typeof entry !== 'string') return;
      const name = entry.split('@')[0].trim(); // remove metadados "@..."
      if (!name || name === 'RSVD') return;
      effects.push({ id, name });
    });
    res.json(effects);
  } catch (err) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

app.post('/api/floors/:id/state', (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Corpo deve ser um objeto JSON de estado WLED' });
  }
  applyState(req, res, req.body);
});

app.post('/api/floors/:id/on', (req, res) => applyState(req, res, { on: true }));
app.post('/api/floors/:id/off', (req, res) => applyState(req, res, { on: false }));

app.post('/api/floors/:id/brightness', (req, res) => {
  const bri = Number(req.body?.brightness);
  if (!Number.isFinite(bri)) {
    return res.status(400).json({ error: 'brightness deve ser um número' });
  }
  applyState(req, res, { bri: clampInt(bri, 0, MAX_BRIGHTNESS, MAX_BRIGHTNESS) });
});

app.post('/api/floors/:id/color', (req, res) => {
  const { r, g, b } = req.body || {};
  const rgb = [r, g, b].map((v) => Number(v));
  if (rgb.some((v) => !Number.isFinite(v))) {
    return res.status(400).json({ error: 'r, g e b devem ser números 0–255' });
  }
  const col = rgb.map((v) => clampInt(v, 0, 255, 0));
  applyState(req, res, { seg: [{ id: 0, col: [col] }] });
});

app.post('/api/floors/:id/effect', (req, res) => {
  const { fx, sx, ix, pal } = req.body || {};
  if (fx === undefined || !Number.isFinite(Number(fx))) {
    return res.status(400).json({ error: 'fx (id do efeito) é obrigatório' });
  }
  const seg = { id: 0, fx: clampInt(fx, 0, 255, 0) };
  if (sx !== undefined) seg.sx = clampInt(sx, 0, 255, 128);
  if (ix !== undefined) seg.ix = clampInt(ix, 0, 255, 128);
  if (pal !== undefined) seg.pal = clampInt(pal, 0, 255, 0);
  applyState(req, res, { seg: [seg] });
});

// ----- Playlists ------------------------------------------------------------

app.get('/api/playlists', (req, res) => {
  res.json(playlists);
});

app.post('/api/playlists', (req, res) => {
  const { value, error } = validatePlaylist(req.body || {}, null);
  if (error) return res.status(400).json({ error });
  playlists.push(value);
  saveJson(PLAYLISTS_FILE, playlists);
  res.status(201).json(value);
});

app.put('/api/playlists/:id', (req, res) => {
  const idx = playlists.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist não encontrada' });
  const { value, error } = validatePlaylist(req.body || {}, playlists[idx]);
  if (error) return res.status(400).json({ error });
  playlists[idx] = value;
  saveJson(PLAYLISTS_FILE, playlists);
  res.json(value);
});

app.delete('/api/playlists/:id', (req, res) => {
  const idx = playlists.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Playlist não encontrada' });
  const [removed] = playlists.splice(idx, 1);
  saveJson(PLAYLISTS_FILE, playlists);
  res.json({ ok: true, removed });
});

app.post('/api/playlists/:id/apply', async (req, res) => {
  const pl = playlists.find((p) => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'Playlist não encontrada' });

  const state = playlistToState(pl);
  const results = await Promise.allSettled(floors.map((f) => sendToWLED(f.ip, state)));

  const report = results.map((r, i) => ({
    floor: floors[i].id,
    name: floors[i].name,
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? errorMessage(r.reason) : undefined,
  }));
  const applied = report.filter((r) => r.ok).length;

  res.json({ applied, total: floors.length, playlist: pl.id, report });
});

// ----- Frontend (build do Angular) -----------------------------------------

app.use(express.static(PUBLIC_DIR));

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Rota não encontrada' });
  }
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res
    .status(404)
    .send('Frontend não encontrado. Rode "npx ng build" no client e copie dist/<app>/browser/* para server/public/.');
});

app.listen(PORT, () => {
  console.log(`WLED Building Controller rodando em http://0.0.0.0:${PORT}`);
  console.log(`Brilho máximo: ${MAX_BRIGHTNESS}/255 · Andares: ${floors.length}`);
});
