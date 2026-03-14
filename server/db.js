/**
 * Слой доступа к БД: Telegram бот и краш-сервер
 * Используется better-sqlite3 для синхронных запросов (быстрый доступ)
 * WAL режим для конкурентности без блокировок
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bot', 'casino.db');

let db;

/**
 * Получить соединение с БД (singleton)
 */
function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    // WAL режим: лучше для конкурентности, чем обычный journal
    db.pragma('journal_mode = WAL');
    // NORMAL: баланс между скоростью и безопасностью
    db.pragma('synchronous = NORMAL');
    // Кэш на 8000 страниц (обычно ~32MB)
    db.pragma('cache_size = -8000');
    // Включить foreign keys для целостности данных
    db.pragma('foreign_keys = ON');
  }
  return db;
}

/**
 * Инициализировать БД: создать таблицу для раундов краш-игры
 */
function initDb() {
  const conn = getDb();
  conn.exec(`
    CREATE TABLE IF NOT EXISTS crash_rounds (
      round_id INTEGER PRIMARY KEY,
      crash_point REAL NOT NULL,
      round_hash TEXT NOT NULL,
      server_seed TEXT NOT NULL,
      players_count INTEGER DEFAULT 0,
      total_bets REAL DEFAULT 0,
      total_won REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_crash_rounds_created
    ON crash_rounds(created_at DESC)
  `);
}

/**
 * Получить пользователя по ID
 */
function getUser(telegramId) {
  return getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
}

/**
 * Обновить основной баланс с проверкой (не может быть отрицательным)
 * Атомарная операция: UPDATE с условием
 *
 * @param {number} telegramId
 * @param {number} amount - Сумма (может быть отрицательной для снятия)
 * @returns {{success: boolean, balance: number}}
 */
function updateBalanceChecked(telegramId, amount) {
  const conn = getDb();
  const row = conn
    .prepare(
      `UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND balance + ? >= 0
       RETURNING balance`
    )
    .get(amount, telegramId, amount);

  if (row) return { success: true, balance: row.balance };

  const cur = conn.prepare('SELECT balance FROM users WHERE telegram_id = ?').get(telegramId);
  return { success: false, balance: cur ? cur.balance : 0 };
}

/**
 * Обновить баланс "донатов" с проверкой (для ограниченных ставок)
 *
 * @param {number} telegramId
 * @param {number} amount - Сумма для снятия
 * @returns {{success: boolean, balance: number}}
 */
function updateDonateBalanceChecked(telegramId, amount) {
  const conn = getDb();
  const row = conn
    .prepare(
      `UPDATE users SET donate_balance = donate_balance - ?, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND donate_balance >= ?
       RETURNING donate_balance`
    )
    .get(amount, telegramId, amount);

  if (row) return { success: true, balance: row.donate_balance };

  const cur = conn.prepare('SELECT donate_balance FROM users WHERE telegram_id = ?').get(telegramId);
  return { success: false, balance: cur ? cur.donate_balance : 0 };
}

/**
 * Добавить средства к основному балансу (без проверки)
 * Используется для зачисления выигрышей
 */
function updateBalance(telegramId, amount) {
  return getDb()
    .prepare(
      `UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? RETURNING balance`
    )
    .get(amount, telegramId);
}

/**
 * Добавить средства к балансу "донатов" (без проверки)
 */
function updateDonateBalance(telegramId, delta) {
  return getDb()
    .prepare(
      `UPDATE users SET donate_balance = donate_balance + ?, updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? RETURNING donate_balance`
    )
    .get(delta, telegramId);
}

/**
 * Записать результат игры в таблицу games
 */
function addGame(telegramId, gameType, stake, result, winnings, multiplier) {
  return getDb()
    .prepare(
      `INSERT INTO games (telegram_id, game_type, stake, result, winnings, multiplier)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(telegramId, gameType, stake, result, winnings, multiplier);
}

/**
 * Проверить, заблокирован ли пользователь
 */
function isBanned(telegramId) {
  const row = getDb().prepare('SELECT is_banned FROM users WHERE telegram_id = ?').get(telegramId);
  return row ? Boolean(row.is_banned) : false;
}

/**
 * Проверить, включен ли режим обслуживания (казино закрыто)
 */
function getMaintenance() {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'maintenance'").get();
  return row ? row.value === '1' : false;
}

/**
 * Сохранить статистику раунда краш-игры
 */
function saveCrashRound(roundId, crashPoint, roundHash, serverSeed, playersCount, totalBets, totalWon) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO crash_rounds
       (round_id, crash_point, round_hash, server_seed, players_count, total_bets, total_won)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(roundId, crashPoint, roundHash, serverSeed, playersCount, totalBets, totalWon);
}

/**
 * Закрыть соединение с БД
 */
function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  initDb,
  getUser,
  updateBalanceChecked,
  updateDonateBalanceChecked,
  updateBalance,
  updateDonateBalance,
  addGame,
  isBanned,
  getMaintenance,
  saveCrashRound,
  close,
};
