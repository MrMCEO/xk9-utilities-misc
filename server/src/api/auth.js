'use strict';

const crypto = require('crypto');
const { BOT_TOKEN } = require('../config');

const INIT_DATA_MAX_AGE = 300; // секунд

/**
 * Верифицировать Telegram initData через HMAC-SHA256.
 * Возвращает объект user (parsed JSON) или null если проверка не пройдена.
 *
 * Алгоритм:
 * 1. Парсим параметры из query string
 * 2. Извлекаем hash, строим data_check_string из оставшихся параметров (sorted)
 * 3. secret_key = HMAC-SHA256(BOT_TOKEN, "WebAppData")
 * 4. expected = HMAC-SHA256(secret_key, data_check_string)
 * 5. Сравниваем expected с hash (constant-time)
 * 6. Проверяем auth_date (не старше 5 минут)
 */
function verifyInitData(initData) {
  try {
    if (!initData) return null;

    const params = {};
    for (const part of initData.split('&')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      params[part.slice(0, idx)] = part.slice(idx + 1);
    }

    const hashValue = params['hash'];
    if (!hashValue) return null;
    delete params['hash'];

    const dataCheckString = Object.keys(params)
      .sort()
      .map(k => `${k}=${params[k]}`)
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(hashValue, 'hex'), Buffer.from(expected, 'hex'))) {
      return null;
    }

    const authDate = parseInt(params['auth_date'] || '0', 10);
    if (Math.abs(Date.now() / 1000 - authDate) > INIT_DATA_MAX_AGE) {
      return null;
    }

    const userJson = decodeURIComponent(params['user'] || '{}');
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

/**
 * Express/HTTP middleware для проверки initData из тела запроса.
 */
function authMiddleware(req, res, next) {
  const initData = req.body && req.body.initData;
  const user = verifyInitData(initData || '');
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  req.telegramUser = user;
  next();
}

module.exports = { verifyInitData, authMiddleware };
