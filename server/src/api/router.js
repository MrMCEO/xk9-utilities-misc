'use strict';

const { verifyInitData } = require('./auth');
const { isUserBanned } = require('../db/users');
const { getMaintenance } = require('../db/settings');
const { ADMIN_IDS } = require('../config');
const rocketEngine = require('../games/rocket-engine');
const mineEngine = require('../games/minesweeper-engine');
const ladderEngine = require('../games/ladder-engine');

const MAX_STAKE = 10_000_000;

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

  // Health check
  if (url === '/health' && method === 'GET') {
    json(res, { ok: true, ts: Date.now() });
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
