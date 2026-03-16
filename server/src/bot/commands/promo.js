'use strict';

const { isUserBanned } = require('../../db/users');
const { usePromo } = require('../../db/promos');

/** Команда /promo CODE */
async function promoCommand(ctx) {
  if (isUserBanned(ctx.from.id)) {
    await ctx.reply('🚫 Ваш аккаунт заблокирован.');
    return;
  }

  const text = ctx.message && ctx.message.text ? ctx.message.text.trim() : '';
  const args = text.split(/\s+/);

  if (args.length < 2) {
    await ctx.reply('❌ Использование: /promo <код>\nПример: /promo BONUS100');
    return;
  }

  const code = args[1].trim();
  const { success, message } = usePromo(ctx.from.id, code);

  if (success) {
    await ctx.reply(`🎁 <b>Промо-код активирован!</b>\n\n${message}`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(`❌ ${message}`);
  }
}

module.exports = { promoCommand };
