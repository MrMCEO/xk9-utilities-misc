/**
 * history.js — Вкладка "📋 История ставок".
 * Работает в двух режимах:
 *  1. С сервером — загружает через GET /api/history
 *  2. Локально  — из массива _localHistory (записи за текущую сессию)
 */

const GAME_ICONS = {
    rocket:      '🚀',
    minesweeper: '💣',
    ladder:      '🪜',
    'crash-mp':  '🌐',
};

const GAME_NAMES = {
    rocket:      'Ракета',
    minesweeper: 'Сапёр',
    ladder:      'Лесенка',
    'crash-mp':  'Онлайн',
};

/* ── Локальный буфер (работает без сервера) ── */
const _localHistory = [];

/**
 * Добавить запись в локальный буфер истории.
 * Вызывается из rocket.js, minesweeper.js, ladder.js, crash-mp.js при завершении игры.
 *
 * @param {object} entry
 * @param {string} entry.game_type   — 'rocket' | 'minesweeper' | 'ladder' | 'crash-mp'
 * @param {number} entry.stake       — размер ставки
 * @param {boolean} entry.won        — выиграл?
 * @param {number} entry.multiplier  — итоговый множитель
 * @param {number} entry.winnings    — выплата (включая ставку)
 * @param {string} [entry.wallet]    — 'main' | 'donate'
 */
export function addLocalHistory(entry) {
    _localHistory.unshift({
        id:         Date.now(),
        game_type:  entry.game_type  || 'rocket',
        stake:      entry.stake      || 0,
        won:        !!entry.won,
        multiplier: entry.multiplier || 1.0,
        winnings:   entry.winnings   || 0,
        wallet:     entry.wallet     || 'main',
        created_at: new Date().toISOString(),
        _local:     true,
    });
    /* Держим не более 200 локальных записей */
    if (_localHistory.length > 200) _localHistory.length = 200;
}

/* ── Состояние модуля ── */
let _serverGames = [];   /* загруженные с сервера */
let _currentFilter = 'all';
let _offset        = 0;
let _total         = 0;
let _loading       = false;
let _serverLoaded  = false;

/* ── DOM ── */
const el = {
    get stats()    { return document.getElementById('historyStats');    },
    get list()     { return document.getElementById('historyList');     },
    get loadMore() { return document.getElementById('historyLoadMore'); },
};

/* ════════════════════════════════════
   PUBLIC API
════════════════════════════════════ */

/**
 * Загрузить (или обновить) историю при переключении на вкладку.
 * При первом вызове пытается загрузить данные с сервера.
 */
export async function loadHistory() {
    if (_loading) return;

    /* Если уже грузили с сервера — просто перерисовать (с учётом локальных новых записей) */
    if (_serverLoaded) {
        _render();
        return;
    }

    _showLoading();
    _loading = true;

    try {
        const initData = window.Telegram?.WebApp?.initData || '';
        if (!initData) throw new Error('no_init_data');

        const apiUrl = (window.API_URL || '') + `/api/history?limit=50&offset=0`;
        const res = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'X-Init-Data': initData },
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error('server_error');
        const data = await res.json();
        if (!data.ok) throw new Error('api_error');

        _serverGames   = data.games || [];
        _total         = data.total || 0;
        _offset        = _serverGames.length;
        _serverLoaded  = true;

    } catch (_err) {
        /* Сервер недоступен или нет initData — работаем только с локальным буфером */
        _serverLoaded = false;
    } finally {
        _loading = false;
    }

    _render();
}

/* ── Кнопка "Загрузить ещё" ── */
async function _loadMore() {
    if (_loading) return;
    _loading = true;

    try {
        const initData = window.Telegram?.WebApp?.initData || '';
        const apiUrl = (window.API_URL || '') + `/api/history?limit=50&offset=${_offset}`;
        const res = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'X-Init-Data': initData },
            signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        if (data.ok) {
            _serverGames = _serverGames.concat(data.games || []);
            _total       = data.total;
            _offset      = _serverGames.length;
        }
    } catch (_) {}

    _loading = false;
    _render();
}

/* ════════════════════════════════════
   INTERNAL RENDER
════════════════════════════════════ */

function _mergedGames() {
    /* Объединяем локальные (не дубликаты с сервера) + серверные */
    const serverIds = new Set(_serverGames.map(g => g.created_at));
    const freshLocal = _localHistory.filter(g => {
        /* Локальная запись считается дублём если совпадает created_at (ISO) — маловероятно */
        return !serverIds.has(g.created_at);
    });
    /* Локальные идут первыми (они свежее), потом серверные */
    return [...freshLocal, ..._serverGames];
}

function _filteredGames() {
    const all = _mergedGames();
    if (_currentFilter === 'all') return all;
    return all.filter(g => g.game_type === _currentFilter);
}

function _showLoading() {
    if (el.list) el.list.innerHTML = '<div class="history-loading">Загрузка...</div>';
    if (el.loadMore) el.loadMore.style.display = 'none';
}

function _render() {
    const games = _filteredGames();
    _renderStats(games);
    _renderList(games);
    _renderLoadMore();
}

function _renderStats(games) {
    const container = el.stats;
    if (!container) return;

    const total  = games.length;
    const wins   = games.filter(g => g.won).length;
    const losses = total - wins;

    /* Профит = сумма выплат - сумма ставок */
    let profit = 0;
    for (const g of games) {
        profit += (g.won ? g.winnings - g.stake : -g.stake);
    }

    const profitColor = profit >= 0 ? 'var(--green)' : 'var(--red)';
    const profitSign  = profit >= 0 ? '+' : '';

    container.innerHTML = `
        <div class="hs-item">
            <div class="hs-val">${total}</div>
            <div class="hs-label">Игр</div>
        </div>
        <div class="hs-item">
            <div class="hs-val" style="color:var(--green)">${wins}</div>
            <div class="hs-label">Побед</div>
        </div>
        <div class="hs-item">
            <div class="hs-val" style="color:var(--red)">${losses}</div>
            <div class="hs-label">Проигрышей</div>
        </div>
        <div class="hs-item">
            <div class="hs-val" style="color:${profitColor}">${profitSign}${_fmtShort(profit)}</div>
            <div class="hs-label">Профит</div>
        </div>
    `;
}

function _renderList(games) {
    const container = el.list;
    if (!container) return;

    if (games.length === 0) {
        container.innerHTML = `
            <div class="history-empty">
                <div class="history-empty-icon">📋</div>
                ${_currentFilter === 'all'
                    ? 'История пуста — сыграйте первую игру!'
                    : 'Нет игр в этой категории'}
            </div>
        `;
        return;
    }

    const frag = document.createDocumentFragment();
    for (const g of games) {
        const item = _buildItem(g);
        frag.appendChild(item);
    }
    container.innerHTML = '';
    container.appendChild(frag);
}

function _buildItem(g) {
    const div = document.createElement('div');
    div.className = 'history-item' + (g.won ? '' : ' lost');

    const icon  = GAME_ICONS[g.game_type] || '🎮';
    // SECURITY: если тип игры неизвестен — показываем заглушку, не пользовательские данные
    const name  = GAME_NAMES[g.game_type] || 'Игра';
    const mult  = (g.multiplier || 1).toFixed(2);
    const time  = _timeAgo(g.created_at);
    const stake = _fmtShort(g.stake);

    let amountHtml;
    if (g.won) {
        const profit = g.winnings - g.stake;
        amountHtml = `<div class="hi-amount win">+${_fmtShort(profit)}</div>`;
    } else {
        amountHtml = `<div class="hi-amount lose">-${stake}</div>`;
    }

    div.innerHTML = `
        <div class="hi-icon">${icon}</div>
        <div class="hi-info">
            <div class="hi-game">${name}</div>
            <div class="hi-time">${time} · ставка ${stake}</div>
        </div>
        <div class="hi-result">
            <div class="hi-mult">${g.won ? 'x' + mult : '💥'}</div>
            ${amountHtml}
        </div>
    `;
    return div;
}

function _renderLoadMore() {
    const btn = el.loadMore;
    if (!btn) return;
    /* Показываем кнопку только если есть серверные данные и ещё не всё загружено */
    const hasMore = _serverLoaded && _offset < _total;
    btn.style.display = hasMore ? 'block' : 'none';
}

/* ════════════════════════════════════
   HELPERS
════════════════════════════════════ */

/**
 * Возвращает строку "X мин назад", "Xч назад", "вчера", "DD.MM".
 */
function _timeAgo(dateStr) {
    if (!dateStr) return '';
    const now  = Date.now();
    const then = new Date(dateStr).getTime();
    // SECURITY: если дата невалидна — возвращаем пустую строку, а не dateStr (защита от XSS)
    if (isNaN(then)) return '';

    const diffMs  = now - then;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffH   = Math.floor(diffMin / 60);
    const diffD   = Math.floor(diffH   / 24);

    if (diffSec < 60)  return 'только что';
    if (diffMin < 60)  return diffMin + ' мин назад';
    if (diffH   < 24)  return diffH + 'ч назад';
    if (diffD   === 1) return 'вчера';
    if (diffD   < 7)   return diffD + ' дн назад';

    const d = new Date(then);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}`;
}

/**
 * Короткое форматирование числа: 1500 → "1.5K", 1000000 → "1M".
 */
function _fmtShort(n) {
    n = Math.round(Math.abs(n));
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '')     + 'K';
    return String(n);
}

/* ════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ ФИЛЬТРОВ И КНОПКИ
════════════════════════════════════ */
(function _initHistoryControls() {
    document.querySelectorAll('.hf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.hf-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _currentFilter = btn.dataset.filter || 'all';
            _render();
        });
    });

    const loadMoreBtn = document.getElementById('historyLoadMore');
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', _loadMore);
    }
})();
