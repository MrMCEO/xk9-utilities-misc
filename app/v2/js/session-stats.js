/**
 * session-stats.js — статистика текущей сессии.
 * Данные сбрасываются при обновлении страницы (сессионная статистика).
 */

let stats = { games: 0, wins: 0, losses: 0, profit: 0 };

/**
 * Зафиксировать результат игры.
 * @param {boolean} won          — победа или проигрыш
 * @param {number}  profitAmount — чистая прибыль (положительная при победе, отрицательная при проигрыше)
 */
export function recordGame(won, profitAmount) {
    stats.games++;
    if (won) stats.wins++; else stats.losses++;
    stats.profit += profitAmount;
    updateUI();
}

function updateUI() {
    const gamesEl  = document.getElementById('ssGames');
    const winsEl   = document.getElementById('ssWins');
    const lossesEl = document.getElementById('ssLosses');
    const profitEl = document.getElementById('ssProfit');
    if (!gamesEl) return;

    gamesEl.textContent  = stats.games;
    winsEl.textContent   = stats.wins;
    lossesEl.textContent = stats.losses;

    const sign = stats.profit >= 0 ? '+' : '';
    profitEl.textContent = `${sign}${stats.profit.toLocaleString('ru', { maximumFractionDigits: 0 })}`;
    profitEl.className   = stats.profit >= 0 ? 'ss-val positive' : 'ss-val negative';
}
