'use strict';

const { requireAdmin } = require('./index');
const { getUser, getUserByUsername, setBalance } = require('../../db/users');
const { getAdminKeyboard } = require('../keyboards');
const { ADMIN_IDS } = require('../../config');

// FSM хранилище: Map<userId, { step, targetUserId }>
const balanceFsm = new Map();

function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

/** Callback admin_balance — запросить ID/username */
async function cbAdminBalance(ctx) {
  if (!requireAdmin(ctx)) return;
  balanceFsm.set(ctx.from.id, { step: 'waiting_user_id' });
  await ctx.editMessageText(
    '💰 <b>Управление балансом</b>\n\nВведите Telegram ID или @username пользователя:',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCallbackQuery();
}

/** Команда /setbalance <user_id> <amount> (для обратной совместимости) */
async function setbalanceCommand(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply('❌ У вас нет прав администратора.');
    return;
  }
  const text = ctx.message && ctx.message.text ? ctx.message.text : '';
  const args = text.split(/\s+/);
  if (args.length !== 3) {
    await ctx.reply('❌ Использование: /setbalance <user_id> <amount>');
    return;
  }
  const userId = parseInt(args[1], 10);
  const amount = parseFloat(args[2]);
  if (isNaN(userId) || isNaN(amount) || amount < 0) {
    await ctx.reply('❌ Некорректные данные.');
    return;
  }
  const newBalance = setBalance(userId, amount);
  await ctx.reply(`✅ Баланс пользователя ${userId} установлен на $${newBalance.toLocaleString('ru', { minimumFractionDigits: 2 })}`);
}

/**
 * Обработчик текстовых сообщений для FSM управления балансом.
 * Возвращает true если сообщение обработано (находились в FSM).
 */
async function handleBalanceFsm(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) return false;
  const state = balanceFsm.get(ctx.from.id);
  if (!state) return false;

  const text = (ctx.message && ctx.message.text ? ctx.message.text.trim() : '');

  if (state.step === 'waiting_user_id') {
    let user = null;
    if (text.startsWith('@')) {
      user = getUserByUsername(text);
    } else if (/^\d+$/.test(text)) {
      user = getUser(parseInt(text, 10));
    }

    if (!user) {
      await ctx.reply('❌ Пользователь не найден. Попробуйте ещё раз:');
      return true;
    }

    balanceFsm.set(ctx.from.id, { step: 'waiting_amount', targetUserId: user.telegram_id });
    await ctx.reply(
      `Пользователь: <b>${escapeHtml(user.first_name || 'Unknown')}</b>\n` +
      `ID: <code>${user.telegram_id}</code>\n` +
      `Баланс: <b>${Math.round(user.balance).toLocaleString('ru')}</b>\n\nВведите новый баланс:`,
      { parse_mode: 'HTML' }
    );
    return true;
  }

  if (state.step === 'waiting_amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 0) {
      await ctx.reply('❌ Введите неотрицательное число:');
      return true;
    }
    const newBalance = setBalance(state.targetUserId, amount);
    balanceFsm.delete(ctx.from.id);
    await ctx.reply(
      `✅ Баланс пользователя <code>${state.targetUserId}</code> установлен на <b>${Math.round(newBalance).toLocaleString('ru')}</b>`,
      { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
    );
    return true;
  }

  return false;
}

function clearBalanceFsm(userId) {
  balanceFsm.delete(userId);
}

module.exports = { cbAdminBalance, setbalanceCommand, handleBalanceFsm, clearBalanceFsm };
