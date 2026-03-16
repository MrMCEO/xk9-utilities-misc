'use strict';

const { ADMIN_IDS } = require('../../config');
const { getAdminKeyboard } = require('../keyboards');
const { getMaintenance } = require('../../db/settings');

/** Проверка admin доступа для callback */
function requireAdmin(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    ctx.answerCallbackQuery('❌ Нет прав', { show_alert: true }).catch(() => {});
    return false;
  }
  return true;
}

/** Команда /admin */
async function adminCommand(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply('❌ У вас нет прав администратора.');
    return;
  }
  const maint = getMaintenance();
  const maintStatus = maint ? '🔴 Обслуживание' : '🟢 Работает';
  await ctx.reply(
    `🔧 <b>Панель администратора</b>\n\nСтатус: ${maintStatus}`,
    { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
  );
}

/** Кнопка "Назад" в админ-панели */
async function adminBack(ctx) {
  if (!requireAdmin(ctx)) return;
  const maint = getMaintenance();
  const maintStatus = maint ? '🔴 Обслуживание' : '🟢 Работает';
  await ctx.editMessageText(
    `🔧 <b>Панель администратора</b>\n\nСтатус: ${maintStatus}`,
    { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
  );
  await ctx.answerCallbackQuery();
}

module.exports = { adminCommand, adminBack, requireAdmin };
