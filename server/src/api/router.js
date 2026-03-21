'use strict';

const path = require('path');
const fs = require('fs');
const { verifyInitData } = require('./auth');
const { isUserBanned } = require('../db/users');
const { getMaintenance } = require('../db/settings');
const { ADMIN_IDS } = require('../config');
const rocketEngine = require('../games/rocket-engine');
const mineEngine = require('../games/minesweeper-engine');
const ladderEngine = require('../games/ladder-engine');
const { getUserHistory } = require('../db/games');
const { getLeaderboard, getTopWinners } = require('../db/users');

// Корень проекта (server/../app)
const STATIC_ROOT = path.resolve(__dirname, '..', '..', '..', 'app');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
};

/**
 * Раздача статических файлов из app/.
 * Возвращает true если файл найден и отдан, false иначе.
 */
function serveStatic(req, res, urlPath) {
  // Только GET и HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Только пути начинающиеся с /app/
  if (!urlPath.startsWith('/app/')) return false;

  const relPath = urlPath.replace(/^\/app\//, '');
  const filePath = path.resolve(STATIC_ROOT, relPath);

  // Защита от path traversal
  if (!filePath.startsWith(STATIC_ROOT)) return false;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(),
    });
    // HEAD — только заголовки, тело не отправляем
    if (req.method === 'HEAD') {
      res.end();
    } else {
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  } catch {
    return false;
  }
}

const MAX_STAKE = 10_000_000;

/* ── Rate limiter: максимум 60 запросов в минуту на IP ── */
const _rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60 * 1000;

// Очистка устаревших записей каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateLimitMap) {
    if (now > entry.resetAt) _rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/**
 * Проверить rate limit для IP. Возвращает true если лимит не превышен, false — если превышен.
 */
function checkRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  const now = Date.now();
  const entry = _rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    _rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return false;
  return true;
}

/**
 * Парсить JSON из тела HTTP запроса (Node.js http без фреймворка).
 * Ограничение: максимум 64 КБ.
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) { req.destroy(); reject(new Error('too_large')); return; }
      data += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * Вычислить CORS origin из WEB_APP_URL.
 * Если WEB_APP_URL не настроен — в prod запрещаем CORS, в dev разрешаем всё.
 */
function getCorsOrigin() {
  const { WEB_APP_URL } = require('../config');
  if (WEB_APP_URL && !WEB_APP_URL.includes('your-domain.com')) {
    try {
      const u = new URL(WEB_APP_URL);
      return `${u.protocol}//${u.host}`;
    } catch {}
  }
  // В production без настроенного WEB_APP_URL запрещаем CORS
  return process.env.NODE_ENV === 'production' ? '' : '*';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(),
    'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:",
  };
}

function json(res, data, status = 200) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders() };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

/**
 * Получить initData — сначала из заголовка X-Init-Data, затем из тела.
 */
function getInitData(req, body) {
  return req.headers['x-init-data'] || body.initData || '';
}

/**
 * Основной HTTP роутер.
 * Вызывается из index.js при каждом HTTP запросе.
 */
async function handleRequest(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Статические файлы (app/v2/*)
  if (serveStatic(req, res, url)) return;

  // Health check (не считается в лимит)
  if (url === '/health' && method === 'GET') {
    json(res, { ok: true, ts: Date.now() });
    return;
  }

  // Rate limiting — только для API-запросов
  if (url.startsWith('/api/') && !checkRateLimit(req)) {
    json(res, { ok: false, error: 'rate_limited' }, 429);
    return;
  }

  // ===== History API =====
  if (url === '/api/history' && method === 'GET') {
    const initData = req.headers['x-init-data'] || '';
    const user = verifyInitData(initData);
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const qp = new URLSearchParams(req.url.split('?')[1] || '');
    const limit  = Math.min(Math.max(parseInt(qp.get('limit')  || '50', 10),  1), 100);
    const offset = Math.max(parseInt(qp.get('offset') || '0',  10), 0);
    const { games, total } = getUserHistory(user.id, limit, offset);
    // Нормализуем поля: result -> won (boolean), добавляем wallet=null для совместимости
    const normalized = games.map(g => ({
      id:         g.id,
      game_type:  g.game_type,
      stake:      g.stake,
      won:        g.result === 'win',
      multiplier: g.multiplier,
      winnings:   g.winnings,
      wallet:     null,
      created_at: g.created_at,
    }));
    json(res, { ok: true, games: normalized, total });
    return;
  }

  // ===== Leaderboard API =====
  if (url === '/api/leaderboard' && method === 'GET') {
    const initData = req.headers['x-init-data'] || '';
    const user = verifyInitData(initData);
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }

    const byBalanceRaw = getLeaderboard(20);
    const byWinningsRaw = getTopWinners(20);

    const byBalance = byBalanceRaw.map((row, i) => ({
      rank: i + 1,
      name: row.name || 'Игрок',
      balance: row.balance,
      isYou: row.id === user.id,
    }));

    const byWinnings = byWinningsRaw.map((row, i) => ({
      rank: i + 1,
      name: row.name || 'Игрок',
      totalWon: row.total_won,
      games: row.games,
      wins: row.wins,
      isYou: row.user_id === user.id,
    }));

    // Позиция текущего пользователя
    const balIdx = byBalanceRaw.findIndex(r => r.id === user.id);
    const winIdx = byWinningsRaw.findIndex(r => r.user_id === user.id);
    const yourRank = {
      byBalance: balIdx >= 0 ? balIdx + 1 : null,
      byWinnings: winIdx >= 0 ? winIdx + 1 : null,
    };

    json(res, { ok: true, byBalance, byWinnings, yourRank });
    return;
  }

  // ===== Rocket API =====
  if (url === '/api/rocket/start' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    if (isUserBanned(user.id)) { json(res, { ok: false, error: 'banned' }, 403); return; }
    if (getMaintenance() && !ADMIN_IDS.includes(user.id)) { json(res, { ok: false, error: 'maintenance' }, 403); return; }

    const stake = parseFloat(body.stake);
    if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE) { json(res, { ok: false, error: 'invalid_stake' }, 400); return; }
    const result = rocketEngine.start(user.id, stake, body.wallet || 'main');
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/rocket/cashout' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = rocketEngine.cashout(body.sessionId || '', user.id);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // POST /api/rocket/check — polling состояния (crashed: true/false, multiplier без crashAt до краша)
  if (url === '/api/rocket/check' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = rocketEngine.check(body.sessionId || '', user.id);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // ===== Minesweeper API =====
  if (url === '/api/minesweeper/start' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    if (isUserBanned(user.id)) { json(res, { ok: false, error: 'banned' }, 403); return; }
    if (getMaintenance() && !ADMIN_IDS.includes(user.id)) { json(res, { ok: false, error: 'maintenance' }, 403); return; }

    const stake = parseFloat(body.stake);
    const mines = parseInt(body.mines || '5', 10);
    if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE) { json(res, { ok: false, error: 'invalid_stake' }, 400); return; }
    const result = mineEngine.start(user.id, stake, body.wallet || 'main', mines);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/minesweeper/tap' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = mineEngine.tap(body.sessionId || '', parseInt(body.cell, 10), user.id);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/minesweeper/cashout' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = mineEngine.cashout(body.sessionId || '', user.id);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // ===== Ladder API =====
  if (url === '/api/ladder/start' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    if (isUserBanned(user.id)) { json(res, { ok: false, error: 'banned' }, 403); return; }
    if (getMaintenance() && !ADMIN_IDS.includes(user.id)) { json(res, { ok: false, error: 'maintenance' }, 403); return; }

    const stake = parseFloat(body.stake);
    if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE) { json(res, { ok: false, error: 'invalid_stake' }, 400); return; }
    const stonesPerRow = parseInt(body.stones) || 3;
    const result = ladderEngine.start(user.id, stake, body.wallet || 'main', stonesPerRow);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/ladder/step' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = ladderEngine.step(body.sessionId || '', parseInt(body.platform, 10), user.id);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/ladder/cashout' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(getInitData(req, body));
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = ladderEngine.cashout(body.sessionId || '', user.id);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // 404
  json(res, { ok: false, error: 'not_found' }, 404);
}

module.exports = { handleRequest };
