'use strict';

const { InlineKeyboard } = require('grammy');
const { requireAdmin } = require('./index');
const { getMaintenance, setMaintenance } = require('../../db/settings');

/** Callback admin_maintenance — переключить режим обслуживания */
async function cbAdminMaintenance(ctx) {
  if (!requireAdmin(ctx)) return;

  const current = getMaintenance();
  setMaintenance(!current);
  const newState = !current;

  const status = newState ? '🔴 ВКЛЮЧЕН' : '🟢 ВЫКЛЮЧЕН';
  const description = newState
    ? 'Пользователи не смогут играть (кроме админов).'
    : 'Казино работает в обычном режиме.';

  await ctx.editMessageText(
    `🔧 <b>Режим обслуживания</b>\n\nСтатус: ${status}\n\n${description}`,
    {
      reply_markup: new InlineKeyboard().text('🔙 Назад', 'admin_back'),
      parse_mode: 'HTML',
    }
  );
  await ctx.answerCallbackQuery();
}

module.exports = { cbAdminMaintenance };
