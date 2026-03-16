'use strict';

const { getUserBalance, getDonateBalance } = require('../../db/users');

/** Команда /balance и кнопка 💰 Баланс */
async function balanceCommand(ctx) {
  const uid = ctx.from.id;
  const balance = getUserBalance(uid);
  const donateBalance = getDonateBalance(uid);
  await ctx.reply(
    `💰 <b>Ваш баланс:</b>\n\n` +
    `💰 Основной баланс: <b>${Math.round(balance).toLocaleString('ru')} монет</b>\n` +
    `⭐ Донатный баланс: <b>${Math.round(donateBalance).toLocaleString('ru')} монет</b>`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { balanceCommand };
