'use strict';

const { Bot } = require('grammy');
const { BOT_TOKEN, ADMIN_IDS, WEB_APP_URL, COINS_PER_STAR } = require('../config');

// Команды
const { startCommand } = require('./commands/start');
const { playCommand } = require('./commands/play');
const { balanceCommand } = require('./commands/balance');
const { casinoCommand } = require('./commands/casino');
const { donateCommand, donateCbAmount, preCheckoutHandler, successfulPaymentHandler, sendDonateInvoice } = require('./commands/donate');
const { promoCommand } = require('./commands/promo');

// Middleware
const { registrationMiddleware, adminCheckMiddleware } = require('./middlewares');

// Admin
const { adminCommand, adminBack } = require('./admin/index');
const { cbAdminStats, statsCommand, cbAdminTop, leaderboardCommand } = require('./admin/stats');
const { cbAdminUsers, cbAdminUsersPage, cbAdminBan, cbAdminUnban } = require('./admin/users');
const { cbAdminBalance, setbalanceCommand, handleBalanceFsm, clearBalanceFsm } = require('./admin/balance');
const { cbAdminBroadcast, handleBroadcastFsm, clearBroadcastFsm } = require('./admin/broadcast');
const { cbAdminPromos, cbAdminCreatePromo, handlePromoFsm, clearPromoFsm } = require('./admin/promos');
const { cbAdminMaintenance } = require('./admin/maintenance');

// Web App data
const { handleWebAppData } = require('./webapp-data');

// Keyboards
const { getDonateKeyboard } = require('./keyboards');

// DB
const { getUserGames, getUserStats } = require('../db/games');
const { getDonateBalance } = require('../db/users');

function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

/**
 * Создать и настроить grammy Bot со всеми обработчиками.
 */
function createBot() {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан в .env');

  const bot = new Bot(BOT_TOKEN);

  // Глобальные middleware
  bot.use(registrationMiddleware);
  bot.use(adminCheckMiddleware);

  // ===== Команды =====
  bot.command('start', startCommand);
  bot.command('play', playCommand);
  bot.command('game', playCommand);
  bot.command('balance', balanceCommand);
  bot.command('casino', casinoCommand);
  bot.command('donate', donateCommand);
  bot.command('promo', promoCommand);
  bot.command('admin', adminCommand);
  bot.command('stats', statsCommand);
  bot.command('leaderboard', leaderboardCommand);
  bot.command('setbalance', setbalanceCommand);

  // /history
  bot.command('history', async (ctx) => {
    const games = getUserGames(ctx.from.id, 15);
    if (!games.length) { await ctx.reply('📜 У вас пока нет игр в истории.'); return; }
    let text = '📜 <b>Последние игры:</b>\n\n';
    games.forEach((g, i) => {
      const emoji = g.result === 'win' ? '✅' : '❌';
      text += `${i + 1}. ${emoji} <b>${g.game_type}</b> | Ставка: $${Number(g.stake).toLocaleString('ru', { minimumFractionDigits: 2 })} | Выигрыш: $${Number(g.winnings).toLocaleString('ru', { minimumFractionDigits: 2 })}\n`;
    });
    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // /help
  bot.command('help', async (ctx) => {
    await ctx.reply(
      '📖 <b>Справка по BFG Casino</b>\n\n' +
      '🎮 <b>Игры в приложении:</b>\n' +
      '🚀 <b>Ракета</b> — забирай выигрыш до краша, множитель растёт\n' +
      '💣 <b>Сапер</b> — открывай ячейки, избегай мин, множитель растёт\n' +
      '🎰 <b>Казино</b> — быстрая игра прямо в боте\n\n' +
      '💰 <b>Команды:</b>\n' +
      '/start - Запустить бота\n' +
      '/play - Открыть игровое приложение\n' +
      '/casino - Игра в казино (&lt;ставка&gt;)\n' +
      '/balance - Проверить баланс\n' +
      '/history - История игр\n' +
      '/donate - Пополнить баланс\n' +
      '/promo - Активировать промо-код\n' +
      '/help - Эта справка\n\n' +
      '🔧 <b>Админ:</b>\n' +
      '/admin - Панель администратора\n' +
      '/stats - Статистика казино\n' +
      '/setbalance - Изменить баланс',
      { parse_mode: 'HTML' }
    );
  });

  // ===== Кнопки Reply-клавиатуры =====
  bot.hears('🎰 Казино', casinoCommand);
  bot.hears('💰 Баланс', balanceCommand);
  bot.hears('📊 Моя статистика', async (ctx) => {
    const stats = getUserStats(ctx.from.id);
    if (stats.total_games === 0) { await ctx.reply('📊 У вас пока нет игр. Испытайте удачу! 🎮'); return; }
    const text =
      `📊 <b>Ваша статистика:</b>\n\n` +
      `🎮 Игр сыграно: <b>${stats.total_games}</b>\n` +
      `✅ Побед: <b>${stats.wins}</b>\n` +
      `❌ Поражений: <b>${stats.losses}</b>\n` +
      `📈 Win Rate: <b>${stats.win_rate.toFixed(1)}%</b>\n\n` +
      `💵 Всего поставлено: <b>$${Number(stats.total_staked).toLocaleString('ru', { minimumFractionDigits: 2 })}</b>\n` +
      `💰 Всего выиграно: <b>$${Number(stats.total_winnings).toLocaleString('ru', { minimumFractionDigits: 2 })}</b>\n` +
      `${stats.profit >= 0 ? '🟢' : '🔴'} Профит: <b>$${Number(stats.profit).toLocaleString('ru', { minimumFractionDigits: 2 })}</b>`;
    await ctx.reply(text, { parse_mode: 'HTML' });
  });
  bot.hears('📜 История игр', async (ctx) => {
    const games = getUserGames(ctx.from.id, 15);
    if (!games.length) { await ctx.reply('📜 У вас пока нет игр в истории.'); return; }
    let text = '📜 <b>Последние игры:</b>\n\n';
    games.forEach((g, i) => {
      const emoji = g.result === 'win' ? '✅' : '❌';
      text += `${i + 1}. ${emoji} <b>${g.game_type}</b> | Ставка: $${Number(g.stake).toFixed(2)} | Выигрыш: $${Number(g.winnings).toFixed(2)}\n`;
    });
    await ctx.reply(text, { parse_mode: 'HTML' });
  });
  bot.hears('💳 Пополнить', donateCommand);
  bot.hears('❓ Помощь', async (ctx) => {
    await ctx.reply(
      '📖 <b>Справка по BFG Casino</b>\n\n' +
      '🎮 <b>Игры:</b> Ракета, Сапер, Казино\n' +
      '/play — открыть приложение\n' +
      '/casino &lt;сумма&gt; — быстрая игра\n' +
      '/balance — баланс\n' +
      '/donate — пополнить Stars\n' +
      '/promo &lt;код&gt; — промо-код',
      { parse_mode: 'HTML' }
    );
  });

  // ===== Callback кнопки (Admin) =====
  bot.callbackQuery('admin_stats', cbAdminStats);
  bot.callbackQuery('admin_users', cbAdminUsers);
  bot.callbackQuery(/^admin_users_page_\d+$/, cbAdminUsersPage);
  bot.callbackQuery('admin_balance', cbAdminBalance);
  bot.callbackQuery('admin_broadcast', cbAdminBroadcast);
  bot.callbackQuery('admin_promos', cbAdminPromos);
  bot.callbackQuery('admin_create_promo', cbAdminCreatePromo);
  bot.callbackQuery('admin_maintenance', cbAdminMaintenance);
  bot.callbackQuery('admin_top', cbAdminTop);
  bot.callbackQuery('admin_back', adminBack);
  bot.callbackQuery(/^admin_ban_\d+$/, cbAdminBan);
  bot.callbackQuery(/^admin_unban_\d+$/, cbAdminUnban);

  // ===== Callback кнопки (Donate) =====
  bot.callbackQuery('donate_custom', async (ctx) => {
    // Выставить FSM-ожидание произвольной суммы
    donateFsm.set(ctx.from.id, { step: 'waiting_amount' });
    await ctx.reply(
      '✏️ <b>Произвольная сумма</b>\n\nВведите количество звёзд (минимум 1, максимум 2500):',
      { parse_mode: 'HTML' }
    );
    await ctx.answerCallbackQuery();
  });
  bot.callbackQuery(/^donate_\d+$/, donateCbAmount);

  // ===== Web App Data =====
  bot.on('message:web_app_data', handleWebAppData);

  // ===== Telegram Payments =====
  bot.on('pre_checkout_query', preCheckoutHandler);
  bot.on('message:successful_payment', successfulPaymentHandler);

  // ===== Общий обработчик текстовых сообщений (FSM) =====
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id;

    // Donate custom amount FSM
    const donateState = donateFsm.get(userId);
    if (donateState && donateState.step === 'waiting_amount') {
      const text = ctx.message.text.trim();
      if (!/^\d+$/.test(text)) {
        await ctx.reply('❌ Введите целое число. Попробуйте ещё раз:');
        return;
      }
      const amount = parseInt(text, 10);
      if (amount < 1 || amount > 2500) {
        await ctx.reply('❌ Сумма должна быть от 1 до 2500 звёзд. Попробуйте ещё раз:');
        return;
      }
      donateFsm.delete(userId);
      await sendDonateInvoice(ctx, userId, amount);
      return;
    }

    // Admin FSM — balance
    if (await handleBalanceFsm(ctx)) return;
    // Admin FSM — broadcast
    if (await handleBroadcastFsm(ctx)) return;
    // Admin FSM — promo creation
    if (await handlePromoFsm(ctx)) return;
  });

  // Обработка ошибок
  bot.catch((err) => {
    console.error('Grammy error:', err.message);
  });

  return bot;
}

// FSM для donate custom amount (Map<userId, state>)
const donateFsm = new Map();

module.exports = { createBot };
