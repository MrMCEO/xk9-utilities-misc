'use strict';

const crypto = require('crypto');
const { createSession, getSession, deleteSession, updateSession, getUserSession } = require('./session-store');
const { updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance } = require('../db/users');
const { addGame } = require('../db/games');

const GRID_SIZE = 36; // 6x6

/**
 * Расставить мины (Fisher-Yates shuffle с crypto.randomInt).
 * @param {number} mineCount
 * @returns {Set<number>} — множество индексов мин
 */
function placeMines(mineCount) {
  const cells = Array.from({ length: GRID_SIZE }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return new Set(cells.slice(0, mineCount));
}

/**
 * Множитель по количеству открытых клеток.
 * Формула: (1 / prob) * 0.97, где prob = P(открыть opened безопасных клеток подряд).
 * @param {number} totalCells — всего клеток (36)
 * @param {number} mineCount — количество мин
 * @param {number} openedCount — открыто безопасных клеток
 */
function calcMultiplier(totalCells, mineCount, openedCount) {
  if (openedCount === 0) return 1.0;
  let prob = 1.0;
  for (let i = 0; i < openedCount; i++) {
    prob *= (totalCells - mineCount - i) / (totalCells - i);
  }
  return parseFloat(((1 / prob) * 0.97).toFixed(4));
}

/**
 * Начать игру в Сапёра.
 */
function start(userId, stake, wallet = 'main', mineCount = 5) {
  // Валидация ставки
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, error: 'invalid_stake' };
  }

  // Запрещаем начать новую игру если уже есть активная сессия (защита от потери ставки)
  if (getUserSession(userId, 'minesweeper')) {
    return { ok: false, error: 'session_already_active' };
  }

  mineCount = Math.max(1, Math.min(30, mineCount));

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

  const mines = placeMines(mineCount);
  const sessionId = createSession(userId, 'minesweeper', {
    stake,
    wallet,
    mines: [...mines],
    mineCount,
    opened: [],
    revealed: false,
  });

  return { ok: true, sessionId, balance: result.balance };
}

/**
 * Нажать на клетку.
 * @param {string} sessionId
 * @param {number} cellIndex
 * @param {number} userId - для проверки владельца сессии
 * @returns {{ ok: bool, hit?: bool, multiplier?, opened?, error? }}
 */
function tap(sessionId, cellIndex, userId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  // Проверка владельца сессии
  if (session.userId !== userId) return { ok: false, error: 'forbidden' };

  if (cellIndex < 0 || cellIndex >= GRID_SIZE) return { ok: false, error: 'invalid_cell' };
  if (session.opened.includes(cellIndex)) return { ok: false, error: 'already_opened' };

  const mineSet = new Set(session.mines);

  if (mineSet.has(cellIndex)) {
    // Попали на мину
    addGame(session.userId, 'minesweeper', session.stake, 'lose', 0, 1.0);
    deleteSession(sessionId);
    return { ok: true, hit: true, mines: [...mineSet] };
  }

  // Безопасная клетка
  const newOpened = [...session.opened, cellIndex];
  updateSession(sessionId, { opened: newOpened });

  const multiplier = calcMultiplier(GRID_SIZE, session.mineCount, newOpened.length);
  const nextMultiplier = calcMultiplier(GRID_SIZE, session.mineCount, newOpened.length + 1);
  return { ok: true, hit: false, multiplier, nextMultiplier, opened: newOpened };
}

/**
 * Забрать выигрыш.
 * @param {string} sessionId
 * @param {number} userId - для проверки владельца сессии
 */
function cashout(sessionId, userId) {
  const session = getSession(sessionId);
  if (!session) return { ok: false, error: 'session_not_found' };

  // Проверка владельца сессии
  if (session.userId !== userId) return { ok: false, error: 'forbidden' };

  if (session.opened.length === 0) {
    // Ничего не открыто — возвращаем ставку
    const useDonate = session.wallet === 'donate';
    let newBalance;
    if (useDonate) {
      newBalance = updateDonateBalance(session.userId, Math.round(session.stake));
    } else {
      newBalance = updateBalance(session.userId, session.stake);
    }
    addGame(session.userId, 'minesweeper', session.stake, 'draw', session.stake, 1.0);
    deleteSession(sessionId);
    return { ok: true, multiplier: 1.0, winnings: session.stake, balance: newBalance };
  }

  const multiplier = calcMultiplier(GRID_SIZE, session.mineCount, session.opened.length);
  const winnings = Math.round(session.stake * multiplier * 100) / 100;
  const useDonate = session.wallet === 'donate';

  let newBalance;
  if (useDonate) {
    newBalance = updateDonateBalance(session.userId, Math.round(winnings));
  } else {
    newBalance = updateBalance(session.userId, winnings);
  }

  addGame(session.userId, 'minesweeper', session.stake, 'win', winnings, multiplier);
  deleteSession(sessionId);

  return { ok: true, multiplier, winnings, balance: newBalance };
}

module.exports = { start, tap, cashout, calcMultiplier };
