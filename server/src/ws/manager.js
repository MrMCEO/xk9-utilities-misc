'use strict';

const { WebSocketServer } = require('ws');
const { CrashGame } = require('../games/crash-game');
const { verifyInitData } = require('../api/auth');
const { getUser } = require('../db/users');

// Map<ws, { telegramId: number, msgCount: number, lastReset: number }>
const clients = new Map();

let crashGame = null;

/** Инициализировать WebSocket сервер на /ws/crash */
function initWsServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws/crash' });

  // Запустить краш-игру
  crashGame = new CrashGame((data) => broadcast(JSON.stringify(data)));
  crashGame.start();

  wss.on('connection', (ws, req) => {
    clients.set(ws, { telegramId: null, msgCount: 0, lastReset: Date.now() });

    // Отправить текущее состояние новому клиенту
    ws.send(JSON.stringify({ type: 'state', ...crashGame.getState() }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handleMessage(ws, msg);
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  return wss;
}

/** Безопасная отправка сообщения клиенту */
function send(ws, data) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(data));
  }
}

/** Обработка входящих сообщений от клиента */
function handleMessage(ws, msg) {
  const info = clients.get(ws);
  if (!info) return;

  // Rate limiting: максимум 20 сообщений в секунду
  const now = Date.now();
  if (now - info.lastReset > 1000) { info.msgCount = 0; info.lastReset = now; }
  info.msgCount++;
  if (info.msgCount > 20) {
    send(ws, { type: 'error', error: 'rate_limited' });
    return;
  }

  const { type } = msg;

  if (type === 'auth') {
    // Аутентификация через Telegram initData
    const user = verifyInitData(msg.initData || '');
    if (!user) {
      send(ws, { type: 'error', error: 'unauthorized' });
      return;
    }
    info.telegramId = user.id;
    clients.set(ws, info);
    send(ws, { type: 'auth_ok', userId: user.id });
    return;
  }

  if (!info.telegramId) {
    send(ws, { type: 'error', error: 'not_authenticated' });
    return;
  }

  if (type === 'bet') {
    const stake = parseFloat(msg.stake);
    if (!Number.isFinite(stake) || stake <= 0) {
      send(ws, { type: 'error', error: 'invalid_stake' });
      return;
    }

    // Проверка бана
    const user = getUser(info.telegramId);
    if (user && user.is_banned) {
      send(ws, { type: 'error', error: 'banned' });
      return;
    }

    const result = crashGame.placeBet(info.telegramId, stake, msg.wallet || 'main');
    send(ws, { type: 'bet_result', ...result });
    return;
  }

  if (type === 'cashout') {
    const result = crashGame.cashout(info.telegramId);
    send(ws, { type: 'cashout_result', ...result });
    return;
  }
}

/** Рассылка всем подключённым клиентам */
function broadcast(data) {
  for (const [ws] of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(data);
    }
  }
}

module.exports = { initWsServer };
