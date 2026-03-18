'use strict';

const crypto = require('crypto');
const { createSession, getSession, deleteSession, updateSession, getUserSession } = require('./session-store');
const { updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance } = require('../db/users');
const { addGame } = require('../db/games');

// Количество платформ по рядам (всего 12 рядов): от нижнего к верхнему
const PLATFORMS_PER_ROW = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 10];
const TOTAL_ROWS = PLATFORMS_PER_ROW.length;

/**
 * Вычислить множитель по достигнутому ряду с учётом stonesPerRow.
 * Вероятность добраться = произведение ((platforms[r] - stones) / platforms[r]) по каждому ряду.
 * Множитель = (1/prob) * 0.97
 * @param {number} row - число пройденных рядов
 * @param {number} stonesPerRow - количество камней в ряду
 */
function calcMultiplier(row, stonesPerRow) {
  if (row <= 0) return 1.0;
  let prob = 1.0;
  for (let r = 0; r < row; r++) {
    prob *= (PLATFORMS_PER_ROW[r] - stonesPerRow) / PLATFORMS_PER_ROW[r];
  }
  if (prob <= 0) return 1.0;
  return Math.round((1 / prob) * 0.97 * 100) / 100;
}

/**
 * Начать игру в Лестницу.
 * @param {number} userId
 * @param {number} stake
 * @param {string} wallet
 * @param {number} stonesPerRow - количество камней в ряду (1–7, default 3)
 */
function start(userId, stake, wallet = 'main', stonesPerRow = 3) {
  // Валидация ставки
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, error: 'invalid_stake' };
  }

  // Запрещаем начать новую игру если уже есть активная сессия (защита от потери ставки)
  if (getUserSession(userId, 'ladder')) {
    return { ok: false, error: 'session_already_active' };
  }

  // Валидация stonesPerRow
  stonesPerRow = Math.max(1, Math.min(7, Math.floor(stonesPerRow) || 3));

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
    stonesPerRow,
    currentRow: 0,
  });

  return { ok: true, sessionId, balance: result.balance, totalRows: TOTAL_ROWS, platformsPerRow: PLATFORMS_PER_ROW };
}

/**
 * Сгенерировать позиции камней для ряда.
 * @param {number} row - номер ряда (0-based)
 * @param {number} platform - выбранная платформа
 * @param {number} stoneCount - количество камней
 * @param {boolean} isSafe - безопасен ли выбранный платформ
 * @returns {number[]} - массив индексов камней
 */
function generateStones(row, platform, stoneCount, isSafe) {
  const platforms = PLATFORMS_PER_ROW[row];
  const stonePositions = [];

  if (!isSafe) {
    // Камень НА выбранной платформе + остальные случайные
    stonePositions.push(platform);
    const others = Array.from({ length: platforms }, (_, i) => i).filter(i => i !== platform);
    for (let i = others.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [others[i], others[j]] = [others[j], others[i]];
    }
    stonePositions.push(...others.slice(0, stoneCount - 1));
  } else {
    // Камни НЕ на выбранной платформе
    const others = Array.from({ length: platforms }, (_, i) => i).filter(i => i !== platform);
    for (let i = others.length - 1; i > 0; i--) {
      const j = crypto.randomInt(0, i + 1);
      [others[i], others[j]] = [others[j], others[i]];
    }
    stonePositions.push(...others.slice(0, stoneCount));
  }

  return stonePositions;
}

/**
 * Сделать шаг на платформу.
 * @param {string} sessionId
 * @param {number} platform - индекс выбранной платформы
 * @param {number} userId - для проверки владельца сессии
 * @returns {{ ok: bool, safe?: bool, row?, stones?, multiplier?, nextMultiplier?, error? }}
 */
function step(sessionId, platform, userId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  // Проверка владельца сессии
  if (session.userId !== userId) return { ok: false, error: 'forbidden' };

  const row = session.currentRow;
  if (row >= TOTAL_ROWS) return { ok: false, error: 'game_finished' };

  const count = PLATFORMS_PER_ROW[row];
  if (platform < 0 || platform >= count) return { ok: false, error: 'invalid_platform' };

  const stonesPerRow = session.stonesPerRow || 3;

  // Определить — безопасна ли платформа (случайно для каждого шага)
  // Вероятность безопасного шага: (platforms - stones) / platforms
  const safeProbability = (count - stonesPerRow) / count;
  const rnd = crypto.randomInt(0, count);
  const isSafe = rnd >= stonesPerRow;

  // Генерируем позиции камней
  const stones = generateStones(row, platform, stonesPerRow, isSafe);

  if (!isSafe) {
    addGame(session.userId, 'ladder', session.stake, 'lose', 0, calcMultiplier(row, stonesPerRow));
    deleteSession(sessionId);
    return { ok: true, safe: false, row, stones, multiplier: calcMultiplier(row, stonesPerRow) };
  }

  const newRow = row + 1;
  updateSession(sessionId, { currentRow: newRow });
  const multiplier = calcMultiplier(newRow, stonesPerRow);
  const nextMultiplier = newRow < TOTAL_ROWS ? calcMultiplier(newRow + 1, stonesPerRow) : null;

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
    return { ok: true, safe: true, row: newRow, stones, multiplier, nextMultiplier: null, finished: true, winnings, balance: newBalance };
  }

  return { ok: true, safe: true, row: newRow, stones, multiplier, nextMultiplier };
}

/**
 * Забрать выигрыш в любой момент.
 * @param {string} sessionId
 * @param {number} userId - для проверки владельца сессии
 */
function cashout(sessionId, userId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  // Проверка владельца сессии
  if (session.userId !== userId) return { ok: false, error: 'forbidden' };

  const stonesPerRow = session.stonesPerRow || 3;
  const multiplier = calcMultiplier(session.currentRow, stonesPerRow);
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
