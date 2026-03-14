/**
 * Модуль Provably Fair для краш-игры
 * Обеспечивает справедливость через детерминированные вычисления на основе HMAC
 */

const crypto = require('crypto');

/**
 * Генерировать новый случайный seed для раунда
 * @returns {string} 64-символьная hex-строка (256 бит)
 */
function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Вычислить краш-точку раунда
 * Использует HMAC-SHA256 для детерминированного, но непредсказуемого результата
 * Формула: (2^52 / (2^52 - X)) * 0.97, где X — первые 52 бита HMAC
 *
 * @param {string} serverSeed - Seed сервера (hex)
 * @param {number} roundId - Номер раунда
 * @returns {number} Краш-множитель (1.0 или >= 1.01)
 */
function computeCrashPoint(serverSeed, roundId) {
  // Создать HMAC-SHA256(serverSeed, roundId)
  const h = crypto
    .createHmac('sha256', serverSeed)
    .update(String(roundId))
    .digest('hex');

  // Использовать первые 13 hex-символов (52 бита)
  const val = parseInt(h.slice(0, 13), 16);
  const e = Math.pow(2, 52);

  // 4% шанс мгновенного краша (val % 25 === 0 покрывает ровно 4% значений 0..2^52)
  if (val % 25 === 0) return 1.0;

  // Формула с 3% house edge и лимитом 1000x
  // Math.max(1.01, ...) гарантирует, что не-мгновенный краш никогда не равен 1.00
  const result = (e / (e - val)) * 0.97;
  return Math.min(Math.max(1.01, Math.round(result * 100) / 100), 1000);
}

/**
 * Получить хэш раунда для доказательства справедливости
 * Клиент получает хэш в начале раунда, а полный seed — после краша
 * Позволяет клиенту верифицировать краш-точку
 *
 * @param {string} serverSeed - Seed сервера
 * @param {number} roundId - Номер раунда
 * @returns {string} SHA256 хэш от HMAC(serverSeed, roundId)
 */
function getRoundHash(serverSeed, roundId) {
  return crypto
    .createHmac('sha256', serverSeed)
    .update(String(roundId))
    .digest('hex');
}

/**
 * Верифицировать раунд: проверить, что открытый seed соответствует хэшу
 *
 * @param {string} serverSeed - Seed сервера
 * @param {number} roundId - Номер раунда
 * @param {string} shownHash - Хэш, который был показан в начале раунда
 * @returns {boolean} true, если seed и roundId порождают этот хэш
 */
function verifyRound(serverSeed, roundId, shownHash) {
  return getRoundHash(serverSeed, roundId) === shownHash;
}

module.exports = { generateSeed, computeCrashPoint, getRoundHash, verifyRound };
