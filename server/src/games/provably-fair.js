'use strict';

const crypto = require('crypto');

/**
 * Генератор точки краша (provably fair).
 * 4% шанс мгновенного краша (1.0), иначе 0.99 / (1 - random), ограничение 100x.
 */
function generateCrashPoint(serverSeed) {
  // Если seed не передан — генерируем случайный
  if (!serverSeed) serverSeed = crypto.randomBytes(32).toString('hex');

  // Используем HMAC-SHA256 для детерминированного результата
  const hash = crypto.createHmac('sha256', serverSeed).update('crash').digest('hex');
  const h = parseInt(hash.slice(0, 8), 16);
  const e = Math.pow(2, 32);

  // 4% instant crash
  if (h % 25 === 0) return { crashPoint: 1.0, serverSeed, hash };

  const crashPoint = Math.min(100, (0.99 * e) / (e - h));
  return {
    crashPoint: Math.max(1.0, Math.round(crashPoint * 100) / 100),
    serverSeed,
    hash,
  };
}

/** Генерировать случайный серверный seed */
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/** Хэш для публикации seed до раунда */
function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

module.exports = { generateCrashPoint, generateServerSeed, hashServerSeed };
