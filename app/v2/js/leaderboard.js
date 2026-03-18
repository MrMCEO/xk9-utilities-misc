/**
 * leaderboard.js — модуль лидерборда.
 * Загружает данные с сервера; при ошибке или dev-режиме показывает фейковые данные.
 */

let lbData = null;
let activeTab = 'balance';

/** Загрузить лидерборд и отрисовать. Вызывается при каждом переходе на таб. */
export async function loadLeaderboard() {
    const listEl   = document.getElementById('lbList');
    const rankEl   = document.getElementById('lbYourRank');
    if (!listEl || !rankEl) return;

    listEl.innerHTML = '<div class="lb-loading">Загрузка...</div>';
    rankEl.innerHTML = '';

    try {
        const res = await fetch(`${window.API_URL || ''}/api/leaderboard`, {
            headers: { 'X-Init-Data': window.Telegram?.WebApp?.initData || '' }
        });
        if (res.ok) {
            const data = await res.json();
            if (data.ok) lbData = data;
        }
    } catch (_) { /* ошибка сети — используем фейковые данные */ }

    if (!lbData || !lbData.ok) {
        lbData = _generateFakeLeaderboard();
    }

    _renderLeaderboard();
    _initTabs();
}

/** Фейковые данные для dev-режима */
function _generateFakeLeaderboard() {
    const names = ['Алексей', 'Мария', 'Дмитрий', 'Елена', 'Иван', 'Анна', 'Сергей', 'Ольга', 'Павел', 'Наталья'];
    return {
        ok: true,
        byBalance: names.map((n, i) => ({
            rank: i + 1,
            name: n,
            balance: Math.floor(5_000_000 / (i + 1)),
            isYou: i === 4,
        })),
        byWinnings: names.map((n, i) => ({
            rank: i + 1,
            name: n,
            totalWon: Math.floor(3_000_000 / (i + 1)),
            games: Math.floor(200 / (i + 1)),
            wins: Math.floor(100 / (i + 1)),
            isYou: i === 4,
        })),
        yourRank: { byBalance: 5, byWinnings: 5 },
    };
}

/** Форматировать число с разделителем тысяч */
function _fmt(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('ru-RU');
}

/** Метка медали/числа для ранга */
function _rankLabel(rank) {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `${rank}`;
}

/** CSS-классы для строки */
function _rowClass(rank, isYou) {
    const classes = ['lb-row'];
    if (isYou) classes.push('you');
    if (rank === 1) classes.push('top1');
    else if (rank === 2) classes.push('top2');
    else if (rank === 3) classes.push('top3');
    return classes.join(' ');
}

/** Отрисовать список по текущей вкладке */
function _renderLeaderboard() {
    const listEl = document.getElementById('lbList');
    const rankEl = document.getElementById('lbYourRank');
    if (!listEl || !rankEl || !lbData) return;

    const isBalance = activeTab === 'balance';
    const items     = isBalance ? lbData.byBalance : lbData.byWinnings;
    const yourRank  = isBalance ? lbData.yourRank?.byBalance : lbData.yourRank?.byWinnings;

    // --- Ваша позиция ---
    if (yourRank != null) {
        rankEl.innerHTML = `
            <div>
                <div class="rank-label">Ваше место</div>
                <div class="rank-num">#${yourRank}</div>
            </div>
            <div style="text-align:right">
                <div class="rank-label">${isBalance ? 'По балансу' : 'По выигрышам'}</div>
            </div>
        `;
        rankEl.style.display = 'flex';
    } else {
        rankEl.style.display = 'none';
    }

    // --- Список ---
    if (!items || items.length === 0) {
        listEl.innerHTML = '<div class="lb-empty">Нет данных</div>';
        return;
    }

    listEl.innerHTML = items.map(item => {
        const rankCls = item.rank <= 3 ? `lb-rank top${item.rank}` : 'lb-rank';
        const rowCls  = _rowClass(item.rank, item.isYou);
        const label   = _rankLabel(item.rank);
        const youTag  = item.isYou ? ' (Вы)' : '';

        if (isBalance) {
            return `
                <div class="${rowCls}">
                    <span class="${rankCls}">${label}</span>
                    <span class="lb-name">${_escape(item.name)}${youTag}</span>
                    <span class="lb-value">💰 ${_fmt(item.balance)}</span>
                </div>`;
        } else {
            return `
                <div class="${rowCls}">
                    <span class="${rankCls}">${label}</span>
                    <div class="lb-name">
                        ${_escape(item.name)}${youTag}
                        <span class="lb-extra">${item.games} игр · ${item.wins} побед</span>
                    </div>
                    <span class="lb-value">🏆 ${_fmt(item.totalWon)}</span>
                </div>`;
        }
    }).join('');
}

/** Безопасное экранирование HTML */
function _escape(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

/** Подключить обработчики переключателя вкладок лидерборда */
function _initTabs() {
    document.querySelectorAll('.lb-tab').forEach(btn => {
        // Удалить предыдущие обработчики (повторный вызов loadLeaderboard)
        btn.replaceWith(btn.cloneNode(true));
    });
    document.querySelectorAll('.lb-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.lb-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.lb;
            _renderLeaderboard();
        });
    });
}
