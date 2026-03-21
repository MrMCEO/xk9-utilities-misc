'use strict';

const { generateCrashPoint, generateServerSeed } = require('./provably-fair');
const { createSession, getSession, deleteSession, getUserSession } = require('./session-store');
const { updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance } = require('../db/users');
const { addGame } = require('../db/games');

const MAX_MULTIPLIER = 100;

/**
 * Формула роста множителя: 1 + t*0.1 + t²*0.012
 * t — секунды с начала игры
 */
function calcMultiplier(elapsedSec) {
  return 1 + elapsedSec * 0.1 + elapsedSec * elapsedSec * 0.012;
}

/**
 * Начать игру в Ракету.
 * @param {number} userId - Telegram ID
 * @param {number} stake - ставка
 * @param {string} wallet - 'main' | 'donate'
 * @returns {{ ok: bool, sessionId?, error?, balance? }}
 */
function start(userId, stake, wallet = 'main') {
  // Валидация ставки
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, error: 'invalid_stake' };
  }

  // Запрещаем начать новую игру если уже есть активная сессия (защита от потери ставки)
  if (getUserSession(userId, 'rocket')) {
    return { ok: false, error: 'session_already_active' };
  }

  // Атомарно списываем ставку
  const useDonate = wallet === 'donate';
  let result;
  if (useDonate) {
    result = updateDonateBalanceChecked(userId, Math.round(stake));
  } else {
    result = updateBalanceChecked(userId, -stake);
  }
  if (!result.success) {
    return { ok: false, error: 'insufficient_funds', balance: result.balance };
  }

  // Генерируем точку краша
  const seed = generateServerSeed();
  const { crashPoint } = generateCrashPoint(seed);

  const sessionId = createSession(userId, 'rocket', {
    stake,
    wallet,
    crashAt: crashPoint,
    serverSeed: seed,
    startTime: Date.now(),
  });

  // SECURITY: не возвращаем crashAt клиенту — иначе клиент знает точку краша
  // и может всегда забирать до неё. Краш определяется только по серверному cashout.
  return { ok: true, sessionId, balance: result.balance };
}

/**
 * Забрать выигрыш.
 * @param {string} sessionId
 * @param {number} userId - для проверки владельца сессии
 * @returns {{ ok: bool, multiplier?, winnings?, balance?, error? }}
 */
function cashout(sessionId, userId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  // Проверка владельца сессии
  if (session.userId !== userId) return { ok: false, error: 'forbidden' };

  let elapsed = (Date.now() - session.startTime) / 1000;
  // Защита от отрицательного elapsed (clock skew)
  if (elapsed < 0) elapsed = 0;
  const multiplier = Math.max(1.0, Math.min(MAX_MULTIPLIER, calcMultiplier(elapsed)));

  // Краш произошёл до кешаута
  if (multiplier >= session.crashAt) {
    deleteSession(sessionId);
    addGame(session.userId, 'rocket', session.stake, 'lose', 0, multiplier);
    return { ok: false, error: 'crashed', multiplier: session.crashAt };
  }

  const winnings = Math.round(session.stake * multiplier * 100) / 100;
  const useDonate = session.wallet === 'donate';

  let newBalance;
  if (useDonate) {
    newBalance = updateDonateBalance(session.userId, Math.round(winnings));
  } else {
    newBalance = updateBalance(session.userId, winnings);
  }

  addGame(session.userId, 'rocket', session.stake, 'win', winnings, multiplier);
  deleteSession(sessionId);

  return { ok: true, multiplier, winnings, balance: newBalance };
}

/**
 * Принудительно завершить сессию как проигрыш (для краш-сервера).
 */
function forceEnd(sessionId, crashAt) {
  const session = getSession(sessionId);
  if (!session) return;
  addGame(session.userId, 'rocket', session.stake, 'lose', 0, crashAt || 1.0);
  deleteSession(sessionId);
}

/**
 * Проверить состояние сессии ракеты (для polling с клиента).
 * Сервер знает crashAt и startTime, вычисляет текущий множитель по серверному времени.
 * Если множитель >= crashAt — возвращает crashed: true.
 * crashAt НЕ раскрывается клиенту до момента краша.
 */
function check(sessionId, userId) {
  const session = getSession(sessionId);
  if (!session || session.userId !== userId) {
    return { ok: false, error: 'session_not_found' };
  }
  if (session.cashedOut) {
    return { ok: true, crashed: false, cashedOut: true };
  }

  // Вычислить текущий множитель по серверному времени
  let elapsed = (Date.now() - session.startTime) / 1000;
  if (elapsed < 0) elapsed = 0;
  const currentMult = Math.min(MAX_MULTIPLIER, calcMultiplier(elapsed));

  if (currentMult >= session.crashAt) {
    // Краш произошёл — записать проигрыш и удалить сессию
    const crashedAt = parseFloat(session.crashAt.toFixed(2));
    addGame(session.userId, 'rocket', session.stake, 'lose', 0, crashedAt);
    deleteSession(sessionId);

    return {
      ok: true,
      crashed: true,
      crashedAt,
      multiplier: crashedAt,
    };
  }

  return {
    ok: true,
    crashed: false,
    multiplier: parseFloat(currentMult.toFixed(2)),
  };
}

module.exports = { start, cashout, forceEnd, calcMultiplier, check };
