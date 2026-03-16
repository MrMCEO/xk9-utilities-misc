'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { DB_PATH } = require('../config');

// Резолвим путь относительно директории server/
const dbPath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.join(__dirname, '../../..', 'bot', DB_PATH);

let _db = null;

/**
 * Получить singleton-соединение с БД (WAL mode для лучшей производительности).
 * better-sqlite3 синхронный — идеально для Node.js без race conditions.
 */
function getDb() {
  if (!_db) {
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('cache_size = -8000');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

module.exports = { getDb };
