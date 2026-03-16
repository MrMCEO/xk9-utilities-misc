'use strict';

const { getUser } = require('../../db/users');
const { getPlayInlineKeyboard } = require('../keyboards');

/** Команда /play и /game — открыть Web App */
async function playCommand(ctx) {
  const u = getUser(ctx.from.id) || {};
  await ctx.reply(
    '🎮 <b>BFG Casino — Web App</b>\n\n🚀 Ракета · 💣 Сапер\nВыбирай игру и испытай удачу!',
    {
      reply_markup: getPlayInlineKeyboard(u.balance || 0, u.donate_balance || 0, ctx.isAdmin),
      parse_mode: 'HTML',
    }
  );
}

module.exports = { playCommand };
