'use strict';

const { InlineKeyboard, Keyboard } = require('grammy');
const { WEB_APP_URL, BOT_API_URL, COINS_PER_STAR } = require('../config');
const { getAdminStats, getActivity24h, getBetsHistory } = require('../db/games');
const { getPromos } = require('../db/promos');
const { getMaintenance } = require('../db/settings');

// Варианты пополнения: [звёзды, подпись]
const DONATE_OPTIONS = [
  [50,   '50 ⭐ → 500 монет'],
  [100,  '100 ⭐ → 1 000 монет'],
  [250,  '250 ⭐ → 2 500 монет'],
  [500,  '500 ⭐ → 5 000 монет'],
  [1000, '1 000 ⭐ → 10 000 монет'],
];

/**
 * Основная Reply клавиатура с кнопкой Web App.
 */
function getMainKeyboard(balance = 0, donateBalance = 0, isAdmin = false) {
  let url = `${WEB_APP_URL}?b=${balance}&db=${donateBalance}`;
  if (BOT_API_URL) url += `&api=${BOT_API_URL}`;
  if (isAdmin) url += '&admin=1';

  return new Keyboard()
    .webApp('🎮 Запустить приложение', url).row()
    .text('🎰 Казино').text('📊 Моя статистика').row()
    .text('💰 Баланс').text('📜 История игр').row()
    .text('💳 Пополнить').text('❓ Помощь')
    .resized();
}

/**
 * Inline клавиатура для открытия Web App (кнопка в сообщении).
 */
function getPlayInlineKeyboard(balance = 0, donateBalance = 0, isAdmin = false) {
  let url = `${WEB_APP_URL}?b=${balance}&db=${donateBalance}`;
  if (BOT_API_URL) url += `&api=${BOT_API_URL}`;
  if (isAdmin) url += '&admin=1';
  return new InlineKeyboard().webApp('🎮 Открыть приложение', url);
}

/** Инлайн клавиатура админ-панели */
function getAdminKeyboard() {
  return new InlineKeyboard()
    .text('📊 Статистика', 'admin_stats').text('👥 Пользователи', 'admin_users').row()
    .text('💰 Управление балансом', 'admin_balance').row()
    .text('📢 Рассылка', 'admin_broadcast').text('🎁 Промо-коды', 'admin_promos').row()
    .text('🔧 Режим обслуживания', 'admin_maintenance').row()
    .text('🏆 Топ игроков', 'admin_top');
}

/** Клавиатура пополнения через Stars */
function getDonateKeyboard() {
  const kb = new InlineKeyboard();
  for (const [stars, label] of DONATE_OPTIONS) {
    kb.text(label, `donate_${stars}`).row();
  }
  kb.text('✏️ Своя сумма', 'donate_custom');
  return kb;
}

/**
 * Собрать admindata для Web App (base64 JSON со статистикой).
 */
function buildAdminData() {
  const stats = getAdminStats();
  const promos = getPromos();
  const recent = getBetsHistory(20);
  const maint = getMaintenance();

  const adminData = {
    users: stats.total_users,
    bets_today: stats.bets_today,
    revenue_today: stats.revenue_today,
    active_promos: promos.filter(p => p.used_count < p.max_uses).length,
    activity_24h: getActivity24h(),
    promo_codes: promos.map(p => ({
      code: p.code, bonus: p.bonus, max_uses: p.max_uses, used_count: p.used_count,
    })),
    recent_bets: recent.slice(0, 10).map(r => ({
      player: r.first_name || r.username || 'Unknown',
      game: r.game_type,
      stake: r.stake,
      won: r.result === 'win',
      multiplier: r.multiplier || 1.0,
    })),
    maintenance: maint,
  };
  return Buffer.from(JSON.stringify(adminData)).toString('base64');
}

module.exports = { getMainKeyboard, getPlayInlineKeyboard, getAdminKeyboard, getDonateKeyboard, buildAdminData, DONATE_OPTIONS };
