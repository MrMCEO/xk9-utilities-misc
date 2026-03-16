'use strict';

/**
 * Обработчик legacy-формата результатов игр из app/v2/index.html.
 * Совместим с Python-ботом: клиент отправляет { type: 'game_result', game, stake, multiplier, won, wallet }.
 */

const { isUserBanned } = require('../db/users');
const { getMaintenance } = require('../db/settings');
const { updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance } = require('../db/users');
const { addGame } = require('../db/games');
const { ADMIN_IDS } = require('../config');

const MAX_MULTIPLIER = 1000.0;
const MAX_STAKE = 10_000_000;
const VALID_GAME_TYPES = new Set(['rocket', 'minesweeper', 'ladder', 'casino']);

async function processGameResult(telegramId, data) {
  if (isUserBanned(telegramId)) return { ok: false, error: 'banned' };
  if (getMaintenance() && !ADMIN_IDS.includes(telegramId)) return { ok: false, error: 'maintenance' };

  let gameType = data.game || 'rocket';
  if (!VALID_GAME_TYPES.has(gameType)) gameType = 'rocket';

  let stake, multiplier;
  try {
    stake = parseFloat(data.stake);
    multiplier = parseFloat(data.multiplier !== undefined ? data.multiplier : 1.0);
  } catch {
    return { ok: false, error: 'invalid_params' };
  }

  if (!isFinite(stake) || stake <= 0 || stake > MAX_STAKE) return { ok: false, error: 'invalid_stake' };
  if (!isFinite(multiplier) || multiplier <= 0 || multiplier > MAX_MULTIPLIER) return { ok: false, error: 'invalid_multiplier' };

  const won = Boolean(data.won);
  const wallet = data.wallet || 'main';
  const useDonate = wallet === 'donate';

  let result;
  if (useDonate) {
    result = updateDonateBalanceChecked(telegramId, Math.round(stake));
  } else {
    result = updateBalanceChecked(telegramId, -stake);
  }

  if (!result.success) {
    return { ok: false, error: 'insufficient_funds', balance: result.balance };
  }

  const winnings = won ? Math.round(stake * multiplier * 100) / 100 : 0;
  let balanceAfter = result.balance;

  if (winnings > 0) {
    if (useDonate) {
      balanceAfter = updateDonateBalance(telegramId, Math.round(winnings));
    } else {
      balanceAfter = updateBalance(telegramId, winnings);
    }
    balanceAfter = Math.round(balanceAfter);
  }

  addGame(telegramId, gameType, stake, won ? 'win' : 'lose', winnings, multiplier);

  return { ok: true, balance: Math.round(balanceAfter) };
}

module.exports = { processGameResult };
