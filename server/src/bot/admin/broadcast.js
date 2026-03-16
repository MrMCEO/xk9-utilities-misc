'use strict';

const { requireAdmin } = require('./index');
const { getAllUsers } = require('../../db/users');
const { getAdminKeyboard } = require('../keyboards');
const { ADMIN_IDS } = require('../../config');

// FSM: Map<userId, { step }>
const broadcastFsm = new Map();

/** Callback admin_broadcast */
async function cbAdminBroadcast(ctx) {
  if (!requireAdmin(ctx)) return;
  broadcastFsm.set(ctx.from.id, { step: 'waiting_text' });
  await ctx.editMessageText(
    '📢 <b>Рассылка</b>\n\nВведите текст сообщения для всех пользователей (HTML-разметка поддерживается):',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCallbackQuery();
}

/**
 * Обработчик FSM рассылки.
 * Возвращает true если сообщение обработано.
 */
async function handleBroadcastFsm(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) return false;
  const state = broadcastFsm.get(ctx.from.id);
  if (!state || state.step !== 'waiting_text') return false;

  const text = (ctx.message && (ctx.message.text || ctx.message.caption) || '').trim();
  if (!text) {
    await ctx.reply('❌ Текст не может быть пустым:');
    return true;
  }

  broadcastFsm.delete(ctx.from.id);

  const users = getAllUsers(100000);
  let sent = 0, failed = 0;

  await ctx.reply(`📢 Начинаю рассылку для ${users.length} пользователей...`);

  for (const user of users) {
    if (user.is_banned) continue;
    try {
      await ctx.api.sendMessage(user.telegram_id, text, { parse_mode: 'HTML' });
      sent++;
    } catch {
      failed++;
    }
    // throttle: ~20 сообщений/сек
    await new Promise(r => setTimeout(r, 50));
  }

  await ctx.reply(
    `📢 <b>Рассылка завершена</b>\n\n✅ Отправлено: ${sent}\n❌ Не доставлено: ${failed}`,
    { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
  );
  return true;
}

function clearBroadcastFsm(userId) {
  broadcastFsm.delete(userId);
}

module.exports = { cbAdminBroadcast, handleBroadcastFsm, clearBroadcastFsm };
