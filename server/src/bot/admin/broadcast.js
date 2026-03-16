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
    '📢 Рассылка\n\nВведите текст сообщения для всех пользователей:',
  );
  await ctx.answerCallbackQuery();
}

/**
 * Обработчик FSM рассылки.
 * Возвращает true если сообщение обработано.
 * Использует cursor-based пагинацию (по 100 пользователей).
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

  // Подсчитать общее количество (первая страница для отображения)
  const firstPage = getAllUsers(1, 0);
  await ctx.reply(`📢 Начинаю рассылку...`);

  let sent = 0, failed = 0, offset = 0;
  const PAGE_SIZE = 100;

  // cursor-based пагинация: читаем по 100 юзеров за раз
  while (true) {
    const users = getAllUsers(PAGE_SIZE, offset);
    if (!users.length) break;

    for (const user of users) {
      if (user.is_banned) continue;
      try {
        await ctx.api.sendMessage(user.telegram_id, text);
        sent++;
      } catch {
        failed++;
      }
      // throttle: ~20 сообщений/сек
      await new Promise(r => setTimeout(r, 50));
    }

    offset += PAGE_SIZE;
    if (users.length < PAGE_SIZE) break;
  }

  await ctx.reply(
    `📢 Рассылка завершена\n\n✅ Отправлено: ${sent}\n❌ Не доставлено: ${failed}`,
    { reply_markup: getAdminKeyboard() }
  );
  return true;
}

function clearBroadcastFsm(userId) {
  broadcastFsm.delete(userId);
}

module.exports = { cbAdminBroadcast, handleBroadcastFsm, clearBroadcastFsm };
