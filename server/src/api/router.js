'use strict';

const { verifyInitData } = require('./auth');
const { isUserBanned } = require('../db/users');
const { getMaintenance } = require('../db/settings');
const { ADMIN_IDS } = require('../config');
const rocketEngine = require('../games/rocket-engine');
const mineEngine = require('../games/minesweeper-engine');
const ladderEngine = require('../games/ladder-engine');
// Legacy game handler (для совместимости с app/v2)
const { processGameResult } = require('./game-legacy');

const MAX_STAKE = 10_000_000;
const MAX_MULTIPLIER = 1000.0;
const VALID_GAME_TYPES = new Set(['rocket', 'minesweeper', 'ladder', 'casino']);

/**
 * Парсить JSON из тела HTTP запроса (Node.js http без фреймворка)
 */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

/**
 * Вычислить CORS origin из WEB_APP_URL
 */
function getCorsOrigin() {
  const { WEB_APP_URL } = require('../config');
  if (WEB_APP_URL && !WEB_APP_URL.includes('your-domain.com')) {
    try {
      const u = new URL(WEB_APP_URL);
      return `${u.protocol}//${u.host}`;
    } catch {}
  }
  return '*';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': getCorsOrigin(),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  };
}

function json(res, data, status = 200) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders() };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
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

  // ===== Legacy API (совместимость с app/v2/index.html) =====
  if (url === '/api/game' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = await processGameResult(user.id, body);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // ===== Rocket API =====
  if (url === '/api/rocket/start' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    if (isUserBanned(user.id)) { json(res, { ok: false, error: 'banned' }, 403); return; }
    if (getMaintenance() && !ADMIN_IDS.includes(user.id)) { json(res, { ok: false, error: 'maintenance' }, 403); return; }

    const stake = parseFloat(body.stake);
    if (!stake || stake <= 0 || stake > MAX_STAKE) { json(res, { ok: false, error: 'invalid_stake' }, 400); return; }
    const result = rocketEngine.start(user.id, stake, body.wallet || 'main');
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/rocket/cashout' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = rocketEngine.cashout(body.sessionId || '');
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // ===== Minesweeper API =====
  if (url === '/api/minesweeper/start' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    if (isUserBanned(user.id)) { json(res, { ok: false, error: 'banned' }, 403); return; }
    if (getMaintenance() && !ADMIN_IDS.includes(user.id)) { json(res, { ok: false, error: 'maintenance' }, 403); return; }

    const stake = parseFloat(body.stake);
    const mines = parseInt(body.mines || '5', 10);
    if (!stake || stake <= 0 || stake > MAX_STAKE) { json(res, { ok: false, error: 'invalid_stake' }, 400); return; }
    const result = mineEngine.start(user.id, stake, body.wallet || 'main', mines);
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/minesweeper/tap' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = mineEngine.tap(body.sessionId || '', parseInt(body.cell, 10));
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/minesweeper/cashout' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = mineEngine.cashout(body.sessionId || '');
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // ===== Ladder API =====
  if (url === '/api/ladder/start' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    if (isUserBanned(user.id)) { json(res, { ok: false, error: 'banned' }, 403); return; }
    if (getMaintenance() && !ADMIN_IDS.includes(user.id)) { json(res, { ok: false, error: 'maintenance' }, 403); return; }

    const stake = parseFloat(body.stake);
    if (!stake || stake <= 0 || stake > MAX_STAKE) { json(res, { ok: false, error: 'invalid_stake' }, 400); return; }
    const result = ladderEngine.start(user.id, stake, body.wallet || 'main');
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/ladder/step' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = ladderEngine.step(body.sessionId || '', parseInt(body.platform, 10));
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  if (url === '/api/ladder/cashout' && method === 'POST') {
    const body = await parseBody(req);
    const user = verifyInitData(body.initData || '');
    if (!user) { json(res, { ok: false, error: 'unauthorized' }, 401); return; }
    const result = ladderEngine.cashout(body.sessionId || '');
    json(res, result, result.ok ? 200 : 400);
    return;
  }

  // 404
  json(res, { ok: false, error: 'not_found' }, 404);
}

module.exports = { handleRequest };
