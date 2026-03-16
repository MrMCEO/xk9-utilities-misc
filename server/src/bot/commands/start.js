'use strict';

const { WEB_APP_URL, BOT_API_URL } = require('../../config');
const { getOrCreateUser, getDonateBalance } = require('../../db/users');
const { getMainKeyboard } = require('../keyboards');

/**
 * Команда /start — приветствие и регистрация.
 * Поддерживает deep link /start donate.
 */
async function startCommand(ctx) {
  const user = getOrCreateUser(
    ctx.from.id,
    ctx.from.username || null,
    ctx.from.first_name || null,
    ctx.from.last_name || null
  );

  const args = ctx.match;

  // Deep link /start donate → меню пополнения
  if (args === 'donate') {
    const { getDonateKeyboard } = require('../keyboards');
    const { COINS_PER_STAR } = require('../../config');
    await ctx.reply(
      `⭐ <b>Пополнение баланса</b>\n\n1 звезда = ${COINS_PER_STAR.toLocaleString('ru')} монет\n\nВыберите сумму пополнения:`,
      { reply_markup: getDonateKeyboard(), parse_mode: 'HTML' }
    );
    return;
  }

  const donateBalance = getDonateBalance(ctx.from.id);
  const isAdmin = ctx.isAdmin;

  // Устанавливаем кнопку меню с Web App (персональный URL с балансом)
  let menuUrl = `${WEB_APP_URL}?b=${user.balance}&db=${donateBalance}`;
  if (BOT_API_URL) menuUrl += `&api=${BOT_API_URL}`;
  if (isAdmin) menuUrl += '&admin=1';

  try {
    await ctx.api.setChatMenuButton({
      chat_id: ctx.from.id,
      menu_button: { type: 'web_app', text: '🎮 Играть', web_app: { url: menuUrl } },
    });
  } catch {}

  const name = ctx.from.first_name ? ctx.from.first_name.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) : '';

  await ctx.reply(
    `🎰 <b>Добро пожаловать в BFG Casino!</b>\n\n` +
    `👤 ${name}, ваш баланс: <b>${(user.balance || 0).toLocaleString('ru', { minimumFractionDigits: 2 })} $</b>\n\n` +
    `🚀 Запускайте игру и испытайте удачу!\nНажмите кнопку ниже 👇`,
    {
      reply_markup: getMainKeyboard(user.balance, donateBalance, isAdmin),
      parse_mode: 'HTML',
    }
  );
}

module.exports = { startCommand };
