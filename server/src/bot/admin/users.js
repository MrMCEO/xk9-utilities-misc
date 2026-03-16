'use strict';

const { InlineKeyboard } = require('grammy');
const { requireAdmin } = require('./index');
const { getAllUsers, banUser } = require('../../db/users');

function escapeHtml(str) {
  return String(str || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

const PAGE_SIZE = 10;

/** Показать страницу пользователей */
async function showUsersPage(ctx, offset) {
  const users = getAllUsers(PAGE_SIZE, offset);

  if (!users.length && offset === 0) {
    await ctx.editMessageText('👥 Пока нет пользователей.');
    return;
  }

  let text = `👥 <b>Пользователи</b> (с ${offset + 1}):\n\n`;
  for (const u of users) {
    const banned = u.is_banned ? ' 🚫' : '';
    const balance = u.balance || 0;
    const name = escapeHtml(u.first_name || 'N/A');
    text += `🆔 <code>${u.telegram_id}</code> | ${name} | $${Math.round(balance).toLocaleString('ru')}${banned}\n`;
  }

  const kb = new InlineKeyboard();
  if (offset > 0) {
    kb.text('⬅️ Назад', `admin_users_page_${Math.max(0, offset - PAGE_SIZE)}`);
  }
  if (users.length === PAGE_SIZE) {
    kb.text('➡️ Далее', `admin_users_page_${offset + PAGE_SIZE}`);
  }
  kb.row().text('🔙 Меню', 'admin_back');

  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' });
}

/** Callback admin_users */
async function cbAdminUsers(ctx) {
  if (!requireAdmin(ctx)) return;
  await showUsersPage(ctx, 0);
  await ctx.answerCallbackQuery();
}

/** Callback admin_users_page_<offset> */
async function cbAdminUsersPage(ctx) {
  if (!requireAdmin(ctx)) return;
  const offset = parseInt(ctx.callbackQuery.data.split('_').pop(), 10) || 0;
  await showUsersPage(ctx, offset);
  await ctx.answerCallbackQuery();
}

/** Callback admin_ban_<id> */
async function cbAdminBan(ctx) {
  if (!requireAdmin(ctx)) return;
  const userId = parseInt(ctx.callbackQuery.data.replace('admin_ban_', ''), 10);
  if (isNaN(userId)) { await ctx.answerCallbackQuery('❌ Некорректный ID', { show_alert: true }); return; }
  banUser(userId, true);
  await ctx.answerCallbackQuery(`🚫 Пользователь ${userId} забанен`, { show_alert: true });
}

/** Callback admin_unban_<id> */
async function cbAdminUnban(ctx) {
  if (!requireAdmin(ctx)) return;
  const userId = parseInt(ctx.callbackQuery.data.replace('admin_unban_', ''), 10);
  if (isNaN(userId)) { await ctx.answerCallbackQuery('❌ Некорректный ID', { show_alert: true }); return; }
  banUser(userId, false);
  await ctx.answerCallbackQuery(`✅ Пользователь ${userId} разбанен`, { show_alert: true });
}

module.exports = { cbAdminUsers, cbAdminUsersPage, cbAdminBan, cbAdminUnban };
