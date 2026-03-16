'use strict';

const { getDb } = require('./connection');

/** Сохранить завершённый краш-раунд */
function saveCrashRound({ crashPoint, roundHash, serverSeed, playersCount, totalBets, totalWon }) {
  const info = getDb().prepare(
    `INSERT INTO crash_rounds (crash_point, round_hash, server_seed, players_count, total_bets, total_won)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(crashPoint, roundHash || null, serverSeed || null, playersCount || 0, totalBets || 0, totalWon || 0);
  return info.lastInsertRowid;
}

/** Последние краш-раунды */
function getRecentCrashRounds(limit = 20) {
  return getDb().prepare(
    'SELECT * FROM crash_rounds ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

module.exports = { saveCrashRound, getRecentCrashRounds };
