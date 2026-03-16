'use strict';

const { getDb } = require('./connection');

/** Записать результат игры */
function addGame(telegramId, gameType, stake, result, winnings = 0, multiplier = 1.0) {
  const info = getDb().prepare(
    `INSERT INTO games (telegram_id, game_type, stake, result, winnings, multiplier)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(telegramId, gameType, stake, result, winnings, multiplier);
  return info.lastInsertRowid;
}

/** Последние игры пользователя */
function getUserGames(telegramId, limit = 15) {
  return getDb().prepare(
    `SELECT * FROM games WHERE telegram_id=? ORDER BY created_at DESC LIMIT ?`
  ).all(telegramId, limit);
}

/** Статистика пользователя по играм */
function getUserStats(telegramId) {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) as total_games,
      SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN result='lose' THEN 1 ELSE 0 END) as losses,
      COALESCE(SUM(stake), 0) as total_staked,
      COALESCE(SUM(winnings), 0) as total_winnings
    FROM games WHERE telegram_id=?
  `).get(telegramId);

  if (row && row.total_games > 0) {
    return {
      ...row,
      win_rate: (row.wins / row.total_games) * 100,
      profit: row.total_winnings - row.total_staked,
    };
  }
  return { total_games: 0, wins: 0, losses: 0, total_staked: 0, total_winnings: 0, win_rate: 0, profit: 0 };
}

/** Последние игры всех пользователей (для админ-панели) */
function getRecentGames(limit = 10) {
  return getDb().prepare(`
    SELECT g.*, u.first_name, u.username
    FROM games g JOIN users u ON g.telegram_id=u.telegram_id
    ORDER BY g.created_at DESC LIMIT ?
  `).all(limit);
}

/** История ставок с JOIN на users (для админ-панели) */
function getBetsHistory(limit = 50, gameType = null) {
  const db = getDb();
  if (gameType) {
    return db.prepare(`
      SELECT g.*, u.first_name, u.username
      FROM games g JOIN users u ON g.telegram_id=u.telegram_id
      WHERE g.game_type=? ORDER BY g.created_at DESC LIMIT ?
    `).all(gameType, limit);
  }
  return db.prepare(`
    SELECT g.*, u.first_name, u.username
    FROM games g JOIN users u ON g.telegram_id=u.telegram_id
    ORDER BY g.created_at DESC LIMIT ?
  `).all(limit);
}

/** Агрегированная статистика для админ-панели */
function getAdminStats() {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalBets = db.prepare('SELECT COUNT(*) as c FROM games').get().c;
  const totalWagered = db.prepare('SELECT COALESCE(SUM(stake),0) as s FROM games').get().s;
  const totalWon = db.prepare('SELECT COALESCE(SUM(winnings),0) as s FROM games').get().s;
  const newUsersToday = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at)=date('now')").get().c;
  const betsToday = db.prepare("SELECT COUNT(*) as c FROM games WHERE date(created_at)=date('now')").get().c;
  const revToday = db.prepare(
    "SELECT COALESCE(SUM(stake),0)-COALESCE(SUM(winnings),0) as r FROM games WHERE date(created_at)=date('now')"
  ).get().r;
  const byGame = db.prepare('SELECT game_type, COUNT(*) as cnt FROM games GROUP BY game_type').all();
  const bets_by_game = {};
  for (const row of byGame) bets_by_game[row.game_type] = row.cnt;

  return {
    total_users: totalUsers,
    total_bets: totalBets,
    total_wagered: totalWagered,
    total_won: totalWon,
    revenue: totalWagered - totalWon,
    new_users_today: newUsersToday,
    bets_today: betsToday,
    revenue_today: revToday,
    bets_by_game,
  };
}

/** Глобальная статистика (расширенная, для /stats) */
function getGlobalStats() {
  const db = getDb();
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalGames = db.prepare('SELECT COUNT(*) as c FROM games').get().c;
  const topPlayers = db.prepare(`
    SELECT u.first_name, u.username, COUNT(g.id) as game_count
    FROM games g JOIN users u ON g.telegram_id=u.telegram_id
    GROUP BY g.telegram_id ORDER BY game_count DESC LIMIT 3
  `).all();
  const donRow = db.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(amount_rub),0) as s FROM donations').get();

  return {
    total_users: totalUsers,
    total_games: totalGames,
    top_players: topPlayers,
    total_donations: donRow.cnt,
    total_stars: donRow.s,
  };
}

/** Топ-5 игроков по балансу и по количеству игр */
function getLeaderboard() {
  const db = getDb();
  const topBalance = db.prepare(
    'SELECT first_name, username, balance FROM users WHERE balance IS NOT NULL ORDER BY balance DESC LIMIT 5'
  ).all();
  const topGames = db.prepare(`
    SELECT u.first_name, u.username, COUNT(g.id) as game_count
    FROM games g JOIN users u ON g.telegram_id=u.telegram_id
    GROUP BY g.telegram_id ORDER BY game_count DESC LIMIT 5
  `).all();
  return { top_balance: topBalance, top_games: topGames };
}

/** Активность по часам за последние 24 часа (для графика в админ-панели) */
function getActivity24h() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT strftime('%H', created_at) as hour, COUNT(*) as cnt
    FROM games WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY hour
  `).all();

  const hourly = {};
  for (const r of rows) hourly[parseInt(r.hour, 10)] = r.cnt;

  const nowHour = new Date().getUTCHours();
  const result = [];
  for (let i = 0; i < 24; i++) {
    const h = (nowHour - 23 + i + 24) % 24;
    result.push(hourly[h] || 0);
  }
  return result;
}

/** Удалить старые игры (очистка) */
function cleanupOldGames(days = 30) {
  const info = getDb().prepare(
    `DELETE FROM games WHERE created_at < datetime('now', ? || ' days')`
  ).run(`-${days}`);
  return info.changes;
}

module.exports = {
  addGame,
  getUserGames,
  getUserStats,
  getRecentGames,
  getBetsHistory,
  getAdminStats,
  getGlobalStats,
  getLeaderboard,
  getActivity24h,
  cleanupOldGames,
};
