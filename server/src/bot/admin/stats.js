'use strict';

const { InlineKeyboard } = require('grammy');
const { requireAdmin } = require('./index');
const { getAdminStats } = require('../../db/games');
const { getGlobalStats, getLeaderboard } = require('../../db/games');
const { ADMIN_IDS } = require('../../config');

function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function fmtName(p) {
  return escapeHtml(p.first_name || p.username || 'Unknown');
}

/** Показать статистику (callback admin_stats) */
async function cbAdminStats(ctx) {
  if (!requireAdmin(ctx)) return;
  const s = getAdminStats();

  let gamesText = '';
  for (const [gameType, cnt] of Object.entries(s.bets_by_game)) {
    gamesText += `  ${gameType}: <b>${cnt.toLocaleString('ru')}</b>\n`;
  }
  if (!gamesText) gamesText = '  нет данных\n';

  const text =
    `📊 <b>Статистика BFG Casino</b>\n\n` +
    `👥 Пользователей: <b>${s.total_users.toLocaleString('ru')}</b>\n` +
    `🆕 Новых сегодня: <b>${s.new_users_today}</b>\n\n` +
    `🎮 Всего ставок: <b>${s.total_bets.toLocaleString('ru')}</b>\n` +
    `🎮 Ставок сегодня: <b>${s.bets_today.toLocaleString('ru')}</b>\n\n` +
    `💸 Всего поставлено: <b>${Math.round(s.total_wagered).toLocaleString('ru')}</b>\n` +
    `💰 Всего выиграно: <b>${Math.round(s.total_won).toLocaleString('ru')}</b>\n` +
    `${s.revenue >= 0 ? '🟢' : '🔴'} Доход казино: <b>${Math.round(s.revenue).toLocaleString('ru')}</b>\n` +
    `${s.revenue_today >= 0 ? '🟢' : '🔴'} Доход сегодня: <b>${Math.round(s.revenue_today).toLocaleString('ru')}</b>\n\n` +
    `🎯 <b>Ставки по играм:</b>\n${gamesText}`;

  await ctx.editMessageText(text, {
    reply_markup: new InlineKeyboard().text('🔙 Назад', 'admin_back'),
    parse_mode: 'HTML',
  });
  await ctx.answerCallbackQuery();
}

/** Команда /stats (расширенная для администраторов) */
async function statsCommand(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply('❌ У вас нет прав администратора.');
    return;
  }
  const s = getGlobalStats();
  let top = '';
  for (let i = 0; i < s.top_players.length; i++) {
    top += `  ${i + 1}. ${fmtName(s.top_players[i])} — ${s.top_players[i].game_count} игр\n`;
  }
  if (!top) top = '  нет данных\n';

  await ctx.reply(
    `📊 <b>Статистика BFG Casino</b>\n\n` +
    `👥 Пользователей: <b>${s.total_users}</b>\n` +
    `🎮 Всего игр: <b>${s.total_games}</b>\n\n` +
    `🏆 <b>Топ-3 игрока:</b>\n${top}\n` +
    `💸 Донатов: <b>${s.total_donations}</b> на <b>${s.total_stars.toLocaleString('ru')} ⭐</b>`,
    { parse_mode: 'HTML' }
  );
}

/** Топ игроков (callback admin_top) */
async function cbAdminTop(ctx) {
  if (!requireAdmin(ctx)) return;
  const lb = getLeaderboard();

  let balanceLines = '';
  lb.top_balance.forEach((p, i) => {
    balanceLines += `  ${i + 1}. ${fmtName(p)} — <b>$${Math.round(p.balance).toLocaleString('ru')}</b>\n`;
  });
  if (!balanceLines) balanceLines = '  нет данных\n';

  let gamesLines = '';
  lb.top_games.forEach((p, i) => {
    gamesLines += `  ${i + 1}. ${fmtName(p)} — <b>${p.game_count} игр</b>\n`;
  });
  if (!gamesLines) gamesLines = '  нет данных\n';

  await ctx.editMessageText(
    `🏆 <b>Топ игроков</b>\n\n💰 <b>По балансу:</b>\n${balanceLines}\n🎮 <b>По играм:</b>\n${gamesLines}`,
    { reply_markup: new InlineKeyboard().text('🔙 Назад', 'admin_back'), parse_mode: 'HTML' }
  );
  await ctx.answerCallbackQuery();
}

/** Команда /leaderboard (для всех) */
async function leaderboardCommand(ctx) {
  const lb = getLeaderboard();

  let balanceLines = '';
  lb.top_balance.forEach((p, i) => {
    balanceLines += `  ${i + 1}. ${fmtName(p)} — <b>$${Math.round(p.balance).toLocaleString('ru')}</b>\n`;
  });
  if (!balanceLines) balanceLines = '  нет данных\n';

  let gamesLines = '';
  lb.top_games.forEach((p, i) => {
    gamesLines += `  ${i + 1}. ${fmtName(p)} — <b>${p.game_count} игр</b>\n`;
  });
  if (!gamesLines) gamesLines = '  нет данных\n';

  await ctx.reply(
    `🏆 <b>Топ игроков</b>\n\n💰 <b>По балансу:</b>\n${balanceLines}\n🎮 <b>По играм:</b>\n${gamesLines}`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { cbAdminStats, statsCommand, cbAdminTop, leaderboardCommand };
