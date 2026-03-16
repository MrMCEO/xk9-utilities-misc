'use strict';

const { getDb } = require('./connection');

/**
 * Инициализация всех таблиц базы данных (идемпотентно — CREATE TABLE IF NOT EXISTS).
 * Совместима с существующей Python БД (те же таблицы).
 */
function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      balance REAL DEFAULT 1000000,
      donate_balance INTEGER DEFAULT 0,
      is_banned INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      game_type TEXT NOT NULL,
      stake REAL NOT NULL,
      result TEXT NOT NULL,
      winnings REAL DEFAULT 0,
      multiplier REAL DEFAULT 1.0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_games_telegram_id ON games(telegram_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_games_type ON games(game_type);

    CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER NOT NULL,
      telegram_payment_charge_id TEXT NOT NULL UNIQUE,
      provider_payment_charge_id TEXT,
      amount_rub INTEGER NOT NULL,
      coins_credited INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_donations_telegram_id ON donations(telegram_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY,
      bonus INTEGER NOT NULL,
      max_uses INTEGER NOT NULL,
      used_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS promo_uses (
      promo_code TEXT NOT NULL,
      telegram_id INTEGER NOT NULL,
      used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (promo_code, telegram_id),
      FOREIGN KEY (promo_code) REFERENCES promo_codes (code) ON DELETE CASCADE,
      FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS crash_rounds (
      round_id INTEGER PRIMARY KEY AUTOINCREMENT,
      crash_point REAL NOT NULL,
      round_hash TEXT,
      server_seed TEXT,
      players_count INTEGER DEFAULT 0,
      total_bets REAL DEFAULT 0,
      total_won REAL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Идемпотентное добавление колонок для существующих БД (перенесённых с Python)
  const alterColumns = [
    "ALTER TABLE users ADD COLUMN donate_balance INTEGER DEFAULT 0",
    "ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0",
  ];
  for (const sql of alterColumns) {
    try { db.exec(sql); } catch (_) { /* уже есть */ }
  }
}

module.exports = { initDb };
