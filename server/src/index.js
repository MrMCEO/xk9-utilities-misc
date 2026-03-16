'use strict';

require('dotenv').config();

const http = require('http');
const { PORT, WEB_APP_URL, BOT_API_URL } = require('./config');
const { initDb } = require('./db/migrations');
const { handleRequest } = require('./api/router');
const { initWsServer } = require('./ws/manager');
const { createBot } = require('./bot/index');

// Инициализация базы данных
initDb();
console.info('✅ База данных инициализирована');

// Создание HTTP сервера (для REST API и WebSocket upgrade)
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error('HTTP error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal' }));
    }
  }
});

// WebSocket сервер на /ws/crash
initWsServer(server);
console.info('✅ WebSocket сервер инициализирован (путь: /ws/crash)');

// Запуск HTTP сервера
server.listen(PORT, '0.0.0.0', () => {
  console.info(`✅ HTTP сервер запущен на порту ${PORT}`);
  console.info(`   GET  /health`);
  console.info(`   POST /api/game (legacy)`);
  console.info(`   POST /api/rocket/start | /api/rocket/cashout`);
  console.info(`   POST /api/minesweeper/start | /tap | /cashout`);
  console.info(`   POST /api/ladder/start | /step | /cashout`);
  console.info(`   WS   /ws/crash`);
});

// Telegram бот (grammy polling)
const bot = createBot();

// Устанавливаем глобальную кнопку меню при старте
bot.api.setChatMenuButton({
  menu_button: {
    type: 'web_app',
    text: '🎮 Играть',
    web_app: { url: WEB_APP_URL },
  },
}).catch(() => {});

bot.start({
  onStart: (info) => {
    console.info(`✅ Бот запущен: @${info.username}`);
    console.info(`   Admin IDs: ${require('./config').ADMIN_IDS.join(', ')}`);
    if (BOT_API_URL) console.info(`   API URL: ${BOT_API_URL}`);
  },
}).catch((err) => {
  console.error('Ошибка запуска бота:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.info('\n👋 Остановка сервера...');
  bot.stop();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  bot.stop();
  server.close(() => process.exit(0));
});
