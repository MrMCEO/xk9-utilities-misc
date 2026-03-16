'use strict';

const { createSession, getSession, deleteSession, updateSession } = require('./session-store');
const { updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance } = require('../db/users');
const { addGame } = require('../db/games');

// Количество платформ по рядам (всего 12 рядов): от нижнего к верхнему
const PLATFORMS_PER_ROW = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 10];
const TOTAL_ROWS = PLATFORMS_PER_ROW.length;

/**
 * Вычислить множитель по достигнутому ряду.
 * Вероятность добраться = произведение (1/platforms[r]) по каждому ряду.
 * Множитель = (1/prob) * 0.97
 */
function calcMultiplier(row) {
  if (row <= 0) return 1.0;
  let prob = 1.0;
  for (let r = 0; r < row; r++) {
    prob *= 1 / PLATFORMS_PER_ROW[r];
  }
  return Math.round((1 / prob) * 0.97 * 100) / 100;
}

/**
 * Генерировать безопасные платформы для ряда.
 * @param {number} row - номер ряда (0-based)
 * @param {number} safeSlot - индекс безопасной платформы
 * @returns {Array<{ index: number, safe: bool }>}
 */
function generateRow(row, safeSlot) {
  const count = PLATFORMS_PER_ROW[row];
  return Array.from({ length: count }, (_, i) => ({ index: i, safe: i === safeSlot }));
}

/**
 * Начать игру в Лестницу.
 */
function start(userId, stake, wallet = 'main') {
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

  const sessionId = createSession(userId, 'ladder', {
    stake,
    wallet,
    currentRow: 0,
    rowSeeds: Array.from({ length: TOTAL_ROWS }, () => Math.floor(Math.random() * 100)),
  });

  return { ok: true, sessionId, balance: result.balance, totalRows: TOTAL_ROWS, platformsPerRow: PLATFORMS_PER_ROW };
}

/**
 * Сделать шаг на платформу.
 * @param {string} sessionId
 * @param {number} platform - индекс выбранной платформы
 * @returns {{ ok: bool, safe?: bool, row?, multiplier?, error? }}
 */
function step(sessionId, platform) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  const row = session.currentRow;
  if (row >= TOTAL_ROWS) return { ok: false, error: 'game_finished' };

  const count = PLATFORMS_PER_ROW[row];
  if (platform < 0 || platform >= count) return { ok: false, error: 'invalid_platform' };

  // Детерминированная безопасная платформа для этого ряда
  const safeSlot = session.rowSeeds[row] % count;
  const isSafe = platform === safeSlot;

  if (!isSafe) {
    addGame(session.userId, 'ladder', session.stake, 'lose', 0, calcMultiplier(row));
    deleteSession(sessionId);
    return { ok: true, safe: false, row, safeSlot };
  }

  const newRow = row + 1;
  updateSession(sessionId, { currentRow: newRow });
  const multiplier = calcMultiplier(newRow);

  const finished = newRow >= TOTAL_ROWS;
  if (finished) {
    // Достигли вершины — автоматически выигрываем
    const winnings = Math.round(session.stake * multiplier * 100) / 100;
    const useDonate = session.wallet === 'donate';
    let newBalance;
    if (useDonate) {
      newBalance = updateDonateBalance(session.userId, Math.round(winnings));
    } else {
      newBalance = updateBalance(session.userId, winnings);
    }
    addGame(session.userId, 'ladder', session.stake, 'win', winnings, multiplier);
    deleteSession(sessionId);
    return { ok: true, safe: true, row: newRow, multiplier, finished: true, winnings, balance: newBalance };
  }

  return { ok: true, safe: true, row: newRow, multiplier };
}

/**
 * Забрать выигрыш в любой момент.
 */
function cashout(sessionId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  const multiplier = calcMultiplier(session.currentRow);
  const winnings = session.currentRow === 0
    ? session.stake
    : Math.round(session.stake * multiplier * 100) / 100;

  const useDonate = session.wallet === 'donate';
  let newBalance;
  if (useDonate) {
    newBalance = updateDonateBalance(session.userId, Math.round(winnings));
  } else {
    newBalance = updateBalance(session.userId, winnings);
  }

  if (session.currentRow > 0) {
    addGame(session.userId, 'ladder', session.stake, 'win', winnings, multiplier);
  }
  deleteSession(sessionId);

  return { ok: true, multiplier, winnings, balance: newBalance };
}

module.exports = { start, step, cashout, calcMultiplier, PLATFORMS_PER_ROW, TOTAL_ROWS };
