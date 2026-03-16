'use strict';

const { generateCrashPoint, generateServerSeed } = require('./provably-fair');
const { createSession, getSession, deleteSession } = require('./session-store');
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

  return { ok: true, sessionId, balance: result.balance };
}

/**
 * Забрать выигрыш.
 * @param {string} sessionId
 * @returns {{ ok: bool, multiplier?, winnings?, balance?, error? }}
 */
function cashout(sessionId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  const elapsed = (Date.now() - session.startTime) / 1000;
  const multiplier = Math.min(MAX_MULTIPLIER, calcMultiplier(elapsed));

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

module.exports = { start, cashout, forceEnd, calcMultiplier };
