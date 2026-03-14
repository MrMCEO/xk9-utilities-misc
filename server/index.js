/**
 * BFG Casino мультиплеерный краш-сервер
 * Управляет игровыми раундами, WebSocket-соединениями и сохраняет результаты в БД
 */

require('dotenv').config();

const http = require('http');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const WsManager = require('./ws-manager');
const CrashGame = require('./crash-game');
const db = require('./db');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter(Boolean);

if (!BOT_TOKEN) {
  console.error('[Server] BOT_TOKEN is required in .env');
  process.exit(1);
}

db.initDb();

// HTTP-сервер для healthcheck и CORS preflight
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', online: wsManager.onlineCount }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// WebSocket-сервер в режиме noServer для маршрутизации по пути
const wss = new WebSocketServer({ noServer: true });

const wsManager = new WsManager(BOT_TOKEN);
const crashGame = new CrashGame(wsManager, ADMIN_IDS);

// Обработка upgrade запросов — только /ws/crash разрешён
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/ws/crash') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wsManager.handleConnection(ws);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[Server] HTTP + WebSocket server on port ${PORT}`);
  console.log(`[Server] WebSocket endpoint: ws://localhost:${PORT}/ws/crash`);
  console.log(`[Server] Admin IDs: ${ADMIN_IDS.join(', ') || 'none'}`);
});

wsManager.startHeartbeat();
crashGame.start();

// Корректное завершение: остановить игру, закрыть БД и соединения
function shutdown() {
  console.log('[Server] Shutting down...');
  crashGame.stop();
  wsManager.stopHeartbeat();
  wss.close();
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
