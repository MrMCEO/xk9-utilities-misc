'use strict';

const { getDb } = require('./connection');
const { DEFAULT_BALANCE } = require('../config');

/** Получить или создать пользователя (INSERT OR IGNORE + UPDATE профиля) */
function getOrCreateUser(telegramId, username, firstName, lastName) {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name, balance)
     VALUES (?, ?, ?, ?, ?)`
  ).run(telegramId, username || null, firstName || null, lastName || null, DEFAULT_BALANCE);

  db.prepare(
    `UPDATE users SET username=?, first_name=?, last_name=?, updated_at=CURRENT_TIMESTAMP
     WHERE telegram_id=?`
  ).run(username || null, firstName || null, lastName || null, telegramId);

  return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId) || null;
}

/** Получить пользователя по telegram_id */
function getUser(telegramId) {
  return getDb().prepare('SELECT * FROM users WHERE telegram_id=?').get(telegramId) || null;
}

/** Получить пользователя по @username (без учёта регистра) */
function getUserByUsername(username) {
  const clean = username.replace(/^@/, '');
  return getDb().prepare('SELECT * FROM users WHERE LOWER(username)=LOWER(?)').get(clean) || null;
}

/** Получить основной баланс пользователя */
function getUserBalance(telegramId) {
  const row = getDb().prepare('SELECT balance FROM users WHERE telegram_id=?').get(telegramId);
  return row ? row.balance : 0;
}

/** Получить донатный баланс */
function getDonateBalance(telegramId) {
  const row = getDb().prepare('SELECT donate_balance FROM users WHERE telegram_id=?').get(telegramId);
  return row ? (row.donate_balance || 0) : 0;
}

/**
 * Изменить основной баланс (amount > 0 — пополнение, < 0 — списание).
 * Возвращает новый баланс.
 */
function updateBalance(telegramId, amount) {
  const row = getDb().prepare(
    `UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP
     WHERE telegram_id=? RETURNING balance`
  ).get(amount, telegramId);
  return row ? row.balance : 0;
}

/**
 * Атомарное изменение баланса с проверкой достаточности (amount < 0 — списание).
 * Возвращает { success: bool, balance: number }
 */
function updateBalanceChecked(telegramId, amount) {
  const db = getDb();
  const row = db.prepare(
    `UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP
     WHERE telegram_id=? AND balance+?>=0
     RETURNING balance`
  ).get(amount, telegramId, amount);

  if (row) return { success: true, balance: row.balance };

  const cur = db.prepare('SELECT balance FROM users WHERE telegram_id=?').get(telegramId);
  return { success: false, balance: cur ? cur.balance : 0 };
}

/**
 * Установить баланс пользователю напрямую (для админ-команды).
 * Возвращает новый баланс.
 */
function setBalance(telegramId, amount) {
  if (amount < 0) throw new Error('setBalance: отрицательный баланс недопустим');
  const row = getDb().prepare(
    `UPDATE users SET balance=?, updated_at=CURRENT_TIMESTAMP
     WHERE telegram_id=? RETURNING balance`
  ).get(amount, telegramId);
  return row ? row.balance : 0;
}

/**
 * Атомарное списание с донатного баланса (amount — положительное число).
 * Возвращает { success: bool, balance: number }
 */
function updateDonateBalanceChecked(telegramId, amount) {
  if (amount <= 0) return { success: false, balance: getDonateBalance(telegramId) };
  const db = getDb();
  const row = db.prepare(
    `UPDATE users SET donate_balance=donate_balance-?, updated_at=CURRENT_TIMESTAMP
     WHERE telegram_id=? AND donate_balance>=?
     RETURNING donate_balance`
  ).get(amount, telegramId, amount);

  if (row) return { success: true, balance: row.donate_balance };

  const cur = db.prepare('SELECT donate_balance FROM users WHERE telegram_id=?').get(telegramId);
  return { success: false, balance: cur ? (cur.donate_balance || 0) : 0 };
}

/**
 * Изменить донатный баланс (delta > 0 — пополнение).
 * Возвращает новый баланс.
 */
function updateDonateBalance(telegramId, delta) {
  const row = getDb().prepare(
    `UPDATE users SET donate_balance=donate_balance+?, updated_at=CURRENT_TIMESTAMP
     WHERE telegram_id=? RETURNING donate_balance`
  ).get(delta, telegramId);
  return row ? row.donate_balance : 0;
}

/** Список всех пользователей с пагинацией */
function getAllUsers(limit = 100, offset = 0) {
  return getDb().prepare(
    'SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
}

/** Забанить / разбанить пользователя */
function banUser(telegramId, isBanned) {
  const info = getDb().prepare(
    `UPDATE users SET is_banned=?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?`
  ).run(isBanned ? 1 : 0, telegramId);
  return info.changes > 0;
}

/** Проверить, забанен ли пользователь */
function isUserBanned(telegramId) {
  const row = getDb().prepare('SELECT is_banned FROM users WHERE telegram_id=?').get(telegramId);
  return row ? Boolean(row.is_banned) : false;
}

/**
 * Топ игроков по балансу (без заблокированных, без приватных данных).
 * Возвращает массив { id, name, balance }.
 */
function getLeaderboard(limit = 20) {
  return getDb().prepare(
    `SELECT telegram_id as id, first_name as name, balance
     FROM users WHERE is_banned=0
     ORDER BY balance DESC LIMIT ?`
  ).all(limit);
}

/**
 * Топ игроков по суммарному выигрышу за всё время.
 * Возвращает массив { user_id, name, total_won, games, wins }.
 */
function getTopWinners(limit = 20) {
  return getDb().prepare(
    `SELECT g.telegram_id as user_id,
            u.first_name as name,
            COALESCE(SUM(CASE WHEN g.result='win' THEN g.winnings ELSE 0 END), 0) as total_won,
            COUNT(*) as games,
            SUM(CASE WHEN g.result='win' THEN 1 ELSE 0 END) as wins
     FROM games g
     JOIN users u ON g.telegram_id = u.telegram_id
     WHERE u.is_banned = 0
     GROUP BY g.telegram_id
     ORDER BY total_won DESC LIMIT ?`
  ).all(limit);
}

module.exports = {
  getOrCreateUser,
  getUser,
  getUserByUsername,
  getUserBalance,
  getDonateBalance,
  updateBalance,
  updateBalanceChecked,
  setBalance,
  updateDonateBalance,
  updateDonateBalanceChecked,
  getAllUsers,
  banUser,
  isUserBanned,
  getLeaderboard,
  getTopWinners,
};
