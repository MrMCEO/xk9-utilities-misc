'use strict';

const { isUserBanned, updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance, setBalance } = require('../db/users');
const { getMaintenance, setMaintenance } = require('../db/settings');
const { addGame } = require('../db/games');
const { ADMIN_IDS } = require('../config');

const MAX_MULTIPLIER = 1000.0;
const MAX_STAKE = 10_000_000;
const VALID_GAME_TYPES = new Set(['rocket', 'minesweeper', 'ladder', 'casino']);

/**
 * Обработчик web_app_data от Telegram Web App.
 * Клиент отправляет JSON результат игры или admin-действие.
 */
async function handleWebAppData(ctx) {
  const telegramId = ctx.from.id;

  // Проверка бана
  if (isUserBanned(telegramId)) {
    await ctx.reply('🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.');
    return;
  }

  // Проверка режима обслуживания
  if (getMaintenance() && !ADMIN_IDS.includes(telegramId)) {
    await ctx.reply('🔧 Казино на техническом обслуживании. Попробуйте позже.');
    return;
  }

  let data;
  try {
    data = JSON.parse(ctx.message.web_app_data.data);
  } catch {
    console.error(`Ошибка парсинга web_app_data: user=${telegramId}`);
    return;
  }

  const action = data.action || '';

  // === Обработка admin-действий (только для ADMIN_IDS) ===
  if (action.startsWith('admin_')) {
    if (!ADMIN_IDS.includes(telegramId)) {
      console.warn(`Попытка admin-действия от не-админа: user=${telegramId}, action=${action}`);
      return;
    }

    if (action === 'admin_maintenance_toggle') {
      const current = getMaintenance();
      setMaintenance(!current);
      const state = !current ? 'включён' : 'выключен';
      await ctx.reply(`🔧 Режим обслуживания ${state}.`);
      return;
    }

    if (action === 'admin_balance') {
      const targetId = data.user_id;
      const amount = data.amount;
      if (targetId != null && amount != null) {
        try {
          const uid = parseInt(targetId, 10);
          const amt = parseFloat(amount);
          if (amt < 0) { await ctx.reply('❌ Баланс не может быть отрицательным.'); return; }
          const newBal = setBalance(uid, amt);
          await ctx.reply(`✅ Баланс пользователя ${uid} установлен: $${newBal.toLocaleString('ru', { minimumFractionDigits: 2 })}`);
        } catch {
          await ctx.reply('❌ Некорректные данные.');
        }
      }
      return;
    }

    if (action === 'admin_refresh') {
      await ctx.reply('🔄 Данные обновлены. Перезайдите в приложение для актуальной статистики.');
      return;
    }

    return;
  }

  // === Обработка результата игры ===
  if (data.type !== 'game_result') return;

  let gameType = data.game || 'rocket';
  if (!VALID_GAME_TYPES.has(gameType)) gameType = 'rocket';

  let stake, multiplier;
  try {
    stake = parseFloat(data.stake);
    multiplier = parseFloat(data.multiplier !== undefined ? data.multiplier : 1.0);
  } catch {
    console.warn(`Некорректные числовые данные от Web App: user=${telegramId}`);
    return;
  }

  if (!isFinite(stake) || stake <= 0 || stake > MAX_STAKE) {
    console.warn(`Недопустимая ставка: user=${telegramId}, stake=${stake}`);
    return;
  }
  if (!isFinite(multiplier) || multiplier <= 0 || multiplier > MAX_MULTIPLIER) {
    console.warn(`Подозрительный множитель: user=${telegramId}, multiplier=${multiplier}`);
    return;
  }

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
    console.warn(`Недостаточно средств: user=${telegramId}, wallet=${wallet}, stake=${stake}, balance=${result.balance}`);
    return;
  }

  const winnings = won ? Math.round(stake * multiplier * 100) / 100 : 0;

  if (winnings > 0) {
    if (useDonate) {
      updateDonateBalance(telegramId, Math.round(winnings));
    } else {
      updateBalance(telegramId, winnings);
    }
  }

  addGame(telegramId, gameType, stake, won ? 'win' : 'lose', winnings, multiplier);

  console.info(`Игра: ${gameType}, user=${telegramId}, wallet=${wallet}, stake=${stake}, mult=${multiplier}, won=${won}`);
}

module.exports = { handleWebAppData };
