'use strict';

const { WebSocketServer } = require('ws');
const { CrashGame } = require('../games/crash-game');
const { verifyInitData } = require('../api/auth');

// Map<ws, { telegramId: number }>
const clients = new Map();

let crashGame = null;

/** Инициализировать WebSocket сервер на /ws/crash */
function initWsServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws/crash' });

  // Запустить краш-игру
  crashGame = new CrashGame((data) => broadcast(JSON.stringify(data)));
  crashGame.start();

  wss.on('connection', (ws, req) => {
    clients.set(ws, { telegramId: null });

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

/** Обработка входящих сообщений от клиента */
function handleMessage(ws, msg) {
  const { type } = msg;

  if (type === 'auth') {
    // Аутентификация через Telegram initData
    const user = verifyInitData(msg.initData || '');
    if (!user) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      return;
    }
    const info = clients.get(ws) || {};
    info.telegramId = user.id;
    clients.set(ws, info);
    ws.send(JSON.stringify({ type: 'auth_ok', userId: user.id }));
    return;
  }

  const info = clients.get(ws);
  if (!info || !info.telegramId) {
    ws.send(JSON.stringify({ type: 'error', error: 'not_authenticated' }));
    return;
  }

  if (type === 'bet') {
    const result = crashGame.placeBet(info.telegramId, parseFloat(msg.stake), msg.wallet || 'main');
    ws.send(JSON.stringify({ type: 'bet_result', ...result }));
    return;
  }

  if (type === 'cashout') {
    const result = crashGame.cashout(info.telegramId);
    ws.send(JSON.stringify({ type: 'cashout_result', ...result }));
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
