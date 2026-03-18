/**
 * minesweeper.js — Сапёр 6×6.
 * Позиции мин хранятся на сервере — клиент не знает их до конца игры.
 */

import { fetchAPI }       from './api.js';
import { openModal, closeModal, sndClick, sndWin, sndLose, sndPop, sndBoom, sndBet, haptic, pushHistory } from './ui.js';
import { changeBalance, getActiveBalance, activeWallet, fmtFull, fmtShort, fmtDonate } from './balance.js';
import { recordGame } from './session-stats.js';

const CELLS = 36;

const Mine = {
    active:    false,
    mineCount: 6,
    bet:       0,
    mult:      1.0,
    safe:      new Set(),
    sessionId: null,
};

export const mHistData = [];

/** Экспорт состояния активной игры для app.js */
export function isMineActive() { return Mine.active; }

/* ── Расчёт множителя (только для отображения hints) ── */
function mCalcMult(opened) {
    if (opened === 0) return 1.0;
    let p = 1;
    const s = CELLS - Mine.mineCount;
    for (let i = 0; i < opened; i++) p *= (s - i) / (CELLS - i);
    return Math.max(1.0, (1 / p) * 0.97);
}

/* ── Построить сетку ── */
function mBuildGrid() {
    const g = document.getElementById('mGrid');
    g.innerHTML = '';
    g.classList.remove('playing');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < CELLS; i++) {
        const c = document.createElement('div');
        c.className = 'm-cell hidden';
        c.dataset.i = i;
        c.setAttribute('role', 'gridcell');
        c.setAttribute('aria-label', 'Ячейка ' + (i + 1));
        frag.appendChild(c);
    }
    g.appendChild(frag);
    mCellCache.clear();
}

/* Cache grid cells for fast access */
const mCellCache = new Map();
const mCell = i => {
    let c = mCellCache.get(i);
    if (!c || !c.isConnected) {
        c = document.querySelector(`#mGrid [data-i="${i}"]`);
        if (c) mCellCache.set(i, c);
    }
    return c;
};

/* ── Event delegation ── */
document.getElementById('mGrid').addEventListener('click', e => {
    const c = e.target.closest('.m-cell');
    if (!c) return;
    mTap(parseInt(c.dataset.i));
});

/* ── Обновить статистику ── */
function mUpdateStats() {
    const multEl = document.getElementById('mMult');
    const chip   = multEl.closest('.stat-chip');
    const prev   = multEl.textContent;
    multEl.textContent = 'x' + Mine.mult.toFixed(2);
    document.getElementById('mOpened').textContent = Mine.safe.size;
    if (prev !== multEl.textContent) {
        multEl.classList.remove('pop'); void multEl.offsetWidth; multEl.classList.add('pop');
        if (chip) { chip.classList.remove('mult-pulse'); void chip.offsetWidth; chip.classList.add('mult-pulse'); }
    }
    if (chip) chip.classList.toggle('mult-high', Mine.mult >= 3);
}

function mUpdateNext() {
    document.getElementById('mNextVal').textContent = 'x' + mCalcMult(Mine.safe.size + 1).toFixed(2);
}

/* ── Старт игры ── */
async function mStart() {
    const bet = parseFloat(document.getElementById('mBetInput').value);
    if (!bet || bet <= 0) { openModal('⚠️', 'Ошибка', '', 'Введите корректную ставку', null); return; }
    const avail = getActiveBalance();
    if (bet > avail) {
        openModal('⚠️', 'Мало средств', '', activeWallet === 'donate' ? fmtDonate(avail) : fmtShort(avail), null);
        return;
    }

    const startBtn = document.getElementById('mStartBtn');
    const origText = startBtn.textContent;
    startBtn.textContent = 'Загрузка...';
    startBtn.disabled = true;

    try {
        const wallet = activeWallet;
        const data = await fetchAPI('/api/minesweeper/start', {
            stake: bet, wallet, mines: Mine.mineCount
        });

        Mine.sessionId = data.sessionId;
        Mine.active    = true;
        Mine.safe.clear();
        Mine.bet  = bet;
        Mine.mult = 1.0;

        try {
            localStorage.setItem('bfg_m_bet',   bet);
            localStorage.setItem('bfg_m_mines', Mine.mineCount);
        } catch(e) {}

        mCellCache.clear();
        mBuildGrid();
        document.getElementById('mGrid').classList.add('playing');
        mUpdateStats();
        mUpdateNext();
        document.getElementById('mNextHint').style.display  = 'block';
        document.getElementById('mSettings').style.display  = 'none';
        document.getElementById('mGamePanel').style.display = 'block';
        sndBet();
        haptic('medium');

    } catch(err) {
        openModal('⚠️', 'Ошибка', 'Не удалось начать игру', err.message || 'Проблема с сетью', null);
    } finally {
        startBtn.textContent = origText;
        startBtn.disabled = false;
    }
}

/* ── Клик по ячейке ── */
async function mTap(idx) {
    if (!Mine.active) return;
    if (Mine.safe.has(idx)) return;

    /* Оптимистичный UI — сразу показать состояние "нажато" */
    const cell = mCell(idx);
    if (cell) cell.classList.add('m-pending');

    /* Блокируем сетку на время запроса */
    document.getElementById('mGrid').classList.remove('playing');

    try {
        const data = await fetchAPI('/api/minesweeper/tap', {
            sessionId: Mine.sessionId, cell: idx
        });

        if (cell) cell.classList.remove('m-pending');

        if (data.hit) {
            /* Мина */
            const c = mCell(idx);
            c.classList.replace('hidden', 'mine-hit');
            c.textContent = '💣';
            sndBoom();
            haptic('heavy');
            await mGameOver(idx, data.mines || []);
        } else {
            /* Безопасно */
            Mine.safe.add(idx);
            const c = mCell(idx);
            c.classList.replace('hidden', 'safe');
            c.textContent = '💎';
            sndPop();
            haptic('light');
            Mine.mult = data.multiplier ?? mCalcMult(Mine.safe.size);
            mUpdateStats();
            mUpdateNext();
            document.getElementById('mGrid').classList.add('playing');

            if (Mine.safe.size >= CELLS - Mine.mineCount) {
                setTimeout(mCashout, 500);
            }
        }

    } catch(err) {
        /* Восстановить состояние */
        if (cell) cell.classList.remove('m-pending');
        if (Mine.active) document.getElementById('mGrid').classList.add('playing');
        openModal('⚠️', 'Ошибка', 'Не удалось обработать ход', err.message || 'Проблема с сетью', null);
    }
}

/* ── Показать все мины и завершить раунд ── */
async function mGameOver(hitIdx, mineList) {
    Mine.active = false;
    document.getElementById('mGrid').classList.remove('playing');
    document.getElementById('mNextHint').style.display = 'none';

    const others = mineList.filter(i => i !== hitIdx);
    for (const i of others) {
        await new Promise(r => setTimeout(r, 90));
        const c = mCell(i);
        if (c && c.classList.contains('hidden')) {
            c.classList.replace('hidden', 'mine-show');
            c.textContent = '💣';
        }
    }

    changeBalance(-Mine.bet);
    recordGame(false, -Mine.bet);

    setTimeout(() => {
        pushHistory(mHistData, 'mHistory', false, '💣 -' + fmtFull(Mine.bet));
        sndLose();
        openModal('💥', 'Мина!', 'Открыто безопасных: ' + Mine.safe.size, '-' + fmtFull(Mine.bet), false);
        setTimeout(closeModal, 1500);
        mResetUI();
    }, others.length * 90 + 300);
}

/* ── Забрать выигрыш ── */
async function mCashout() {
    if (!Mine.active) return;

    const cashoutBtn = document.getElementById('mCashoutBtn');
    cashoutBtn.disabled = true;

    try {
        const data = await fetchAPI('/api/minesweeper/cashout', { sessionId: Mine.sessionId });

        Mine.active = false;
        document.getElementById('mGrid').classList.remove('playing');
        document.getElementById('mNextHint').style.display = 'none';

        const finalMult = data.multiplier ?? Mine.mult;
        const total     = Mine.bet * finalMult;
        const profit    = total - Mine.bet;

        changeBalance(profit);
        recordGame(true, profit);
        pushHistory(mHistData, 'mHistory', true, '💎 x' + finalMult.toFixed(2));
        sndWin();
        openModal('💎', 'Выигрыш!', 'x' + finalMult.toFixed(2) + ' · Открыто: ' + Mine.safe.size, '+' + fmtFull(profit), true);
        setTimeout(closeModal, 3000);
        mResetUI();

    } catch(err) {
        cashoutBtn.disabled = false;
        Mine.active = true;
        if (Mine.active) document.getElementById('mGrid').classList.add('playing');
        openModal('⚠️', 'Ошибка', 'Не удалось забрать выигрыш', err.message || 'Проблема с сетью', null);
    }
}

function mResetUI() {
    document.getElementById('mSettings').style.display  = 'block';
    document.getElementById('mGamePanel').style.display = 'none';
    document.getElementById('mCashoutBtn').disabled     = false;
    document.querySelectorAll('#mGrid .m-cell.hidden').forEach(c => c.style.opacity = '0.22');
    document.getElementById('mMult').closest('.stat-chip')?.classList.remove('mult-high');
}

/* ── Кнопки ── */
document.getElementById('mStartBtn').addEventListener('click',   () => { sndClick(); mStart(); });
document.getElementById('mCashoutBtn').addEventListener('click', mCashout);

/* ── Пресеты мин ── */
document.querySelectorAll('.mine-opt').forEach(btn => {
    btn.addEventListener('click', () => {
        if (Mine.active) return;
        document.querySelectorAll('.mine-opt').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');
        const v = parseInt(btn.dataset.m);
        Mine.mineCount = v;
        document.getElementById('mMinesBadge').textContent = v;
        document.getElementById('mMineInput').value = v;
        haptic('light');
    });
});

/* ── Ручной ввод числа мин ── */
document.getElementById('mMineInput').addEventListener('input', function() {
    if (Mine.active) return;
    let v = parseInt(this.value);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 30) v = 30;
    this.value = v;
    Mine.mineCount = v;
    document.getElementById('mMinesBadge').textContent = v;
    document.querySelectorAll('.mine-opt').forEach(b => {
        if (parseInt(b.dataset.m) === v) b.classList.add('sel');
        else b.classList.remove('sel');
    });
});

/* ── Быстрые ставки ── */
document.getElementById('mSettings').querySelectorAll('.qb').forEach(b => {
    b.addEventListener('click', () => {
        document.getElementById('mBetInput').value = b.dataset.v;
        haptic('light');
    });
});

/* ── Инициализация ── */
(function restoreMineSettings() {
    try {
        const bet = localStorage.getItem('bfg_m_bet');
        if (bet) document.getElementById('mBetInput').value = bet;
        const mines = localStorage.getItem('bfg_m_mines');
        if (mines) {
            const v = parseInt(mines);
            Mine.mineCount = v;
            document.getElementById('mMineInput').value = v;
            document.getElementById('mMinesBadge').textContent = v;
            document.querySelectorAll('.mine-opt').forEach(b => {
                b.classList.toggle('sel', parseInt(b.dataset.m) === v);
            });
        }
    } catch(e) {}
})();

mBuildGrid();
