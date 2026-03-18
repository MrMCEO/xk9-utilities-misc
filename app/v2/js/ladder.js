/**
 * ladder.js — Лесенка 12 рядов.
 * Позиции камней хранятся на сервере — клиент не знает их до хода.
 */

import { fetchAPI }       from './api.js';
import { openModal, closeModal, sndClick, sndWin, sndLose, sndStep, sndHit, sndBet, haptic, hNotify, pushHistory } from './ui.js';
import { changeBalance, getActiveBalance, activeWallet, fmtFull, fmtShort, fmtDonate } from './balance.js';
import { recordGame } from './session-stats.js';

const LD_PLATFORMS = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 10];
const LD_ROWS      = 12;

const LD = {
    active:     false,
    bet:        0,
    stones:     3,
    currentRow: -1,
    mult:       1.0,
    locked:     false,
    sessionId:  null,
};

export const lHistData = [];

/** Экспорт состояния активной игры для app.js */
export function isLadderActive() { return LD.active; }

const LDel = {
    get mult()     { return document.getElementById('lMult'); },
    get rowLbl()   { return document.getElementById('lRow'); },
    get badge()    { return document.getElementById('lStonesBadge'); },
    get betInput() { return document.getElementById('lBetInput'); },
    get grid()     { return document.getElementById('lGrid'); },
    get nextHint() { return document.getElementById('lNextHint'); },
    get nextVal()  { return document.getElementById('lNextVal'); },
    get cashout()  { return document.getElementById('lCashoutBtn'); },
    get settings() { return document.getElementById('lSettings'); },
    get panel()    { return document.getElementById('lGamePanel'); },
};

/* ── Расчёт множителей ── */
function ldRowMult(rowIdx) {
    const p = (LD_PLATFORMS[rowIdx] - LD.stones) / LD_PLATFORMS[rowIdx];
    return (1 / p) * 0.97;
}
function ldCumul(upToRow) {
    let m = 1.0;
    for (let i = 0; i <= upToRow; i++) m *= ldRowMult(i);
    return m;
}

/* ── Кэш DOM-элементов сетки ── */
const rowCache  = new Map();
const cellCache = new Map();

/* ── Построить сетку ── */
function ldBuildGrid() {
    rowCache.clear();
    cellCache.clear();
    const g = LDel.grid;
    g.innerHTML = '';
    g.style.position = 'relative';
    for (let r = LD_ROWS - 1; r >= 0; r--) {
        const row = document.createElement('div');
        row.className  = 'ladder-row future';
        row.dataset.row = r;

        const lbl = document.createElement('span');
        lbl.className   = 'lr-label';
        lbl.textContent = r + 1;
        row.appendChild(lbl);

        const count = LD_PLATFORMS[r];
        for (let p = 0; p < count; p++) {
            const cell = document.createElement('div');
            cell.className = 'l-cell';
            cell.dataset.r = r;
            cell.dataset.p = p;
            cell.setAttribute('role', 'button');
            cell.setAttribute('aria-label', 'Платформа ' + (p + 1) + ', ряд ' + (r + 1));
            row.appendChild(cell);
        }
        g.appendChild(row);
    }
    const charEl = document.createElement('div');
    charEl.className   = 'ld-char-start';
    charEl.id          = 'ldChar';
    charEl.textContent = '🧍';
    g.appendChild(charEl);
    requestAnimationFrame(() => { g.scrollTop = g.scrollHeight; });
}

function ldGetRow(r) {
    if (rowCache.has(r)) return rowCache.get(r);
    const el = LDel.grid.querySelector(`.ladder-row[data-row="${r}"]`);
    if (el) rowCache.set(r, el);
    return el;
}
function ldGetCell(r, p) {
    const key = `${r}_${p}`;
    if (cellCache.has(key)) return cellCache.get(key);
    const el = LDel.grid.querySelector(`.ladder-row[data-row="${r}"] .l-cell[data-p="${p}"]`);
    if (el) cellCache.set(key, el);
    return el;
}

function ldSetStates(activeRow) {
    for (let r = 0; r < LD_ROWS; r++) {
        const row = ldGetRow(r);
        if (!row) continue;
        row.classList.remove('active', 'cleared', 'future');
        if      (r < activeRow)   row.classList.add('cleared');
        else if (r === activeRow) row.classList.add('active');
        else                      row.classList.add('future');
    }
    // Плавная прокрутка с задержкой — после начала анимации прыжка
    setTimeout(() => {
        const activeEl = ldGetRow(activeRow);
        if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
}

/* ── Персонаж — получить или создать ── */
function ldGetPlayer() {
    return document.getElementById('lPlayer');
}
function ldCreatePlayer() {
    const player = document.createElement('div');
    player.id = 'lPlayer';
    player.className = 'ladder-player';
    player.textContent = '🧍';
    LDel.grid.appendChild(player);
    return player;
}

/* ── Переместить персонажа к выбранной ячейке ── */
function ldMovePlayerToRow(row, platform) {
    const player = ldGetPlayer() || ldCreatePlayer();
    const targetCell = ldGetCell(row, platform);
    if (!targetCell) return;

    // Скрыть стартовый символ при первом шаге
    const charStart = document.getElementById('ldChar');
    if (charStart) charStart.style.opacity = '0';

    const grid = LDel.grid;
    const gridRect = grid.getBoundingClientRect();
    const cellRect  = targetCell.getBoundingClientRect();
    const scrollTop = grid.scrollTop;

    const left = cellRect.left - gridRect.left + cellRect.width / 2 - 12;
    const top  = cellRect.top  - gridRect.top  + scrollTop - 28;

    player.style.left = left + 'px';
    player.style.top  = top  + 'px';

    // Анимация прыжка
    player.classList.remove('jumping', 'celebrate', 'falling');
    void player.offsetWidth; // reflow
    player.classList.add('jumping');
    setTimeout(() => player.classList.remove('jumping'), 400);
}

/* ── Победный танец ── */
function ldCelebratePlayer() {
    const player = ldGetPlayer();
    if (!player) return;
    player.classList.remove('jumping', 'falling');
    void player.offsetWidth;
    player.classList.add('celebrate');
    setTimeout(() => player.classList.remove('celebrate'), 600);
}

/* ── Падение при проигрыше ── */
function ldFallPlayer() {
    const player = ldGetPlayer();
    if (!player) return;
    player.classList.remove('jumping', 'celebrate');
    void player.offsetWidth;
    player.classList.add('falling');
}

/* ── Анимированное раскрытие результата ── */
async function ldReveal(rowIdx, stoneSet, chosenPlatform, isHit) {
    if (!isHit) {
        const cc = ldGetCell(rowIdx, chosenPlatform);
        if (cc) { cc.classList.add('l-safe'); cc.textContent = '💎'; }
        // Персонаж запрыгивает на безопасную ячейку
        ldMovePlayerToRow(rowIdx, chosenPlatform);
    }
    for (const platIdx of stoneSet) {
        await new Promise(r => setTimeout(r, 65));
        const cell = ldGetCell(rowIdx, platIdx);
        if (!cell) continue;
        if (platIdx === chosenPlatform && isHit) {
            cell.classList.add('l-hit');   cell.textContent = '💥';
            // Персонаж падает при попадании на камень
            ldFallPlayer();
        } else {
            cell.classList.add('l-stone'); cell.textContent = '🪨';
        }
    }
}

function ldUpdateStats() {
    LDel.mult.textContent   = 'x' + LD.mult.toFixed(2);
    LDel.rowLbl.textContent = Math.max(0, LD.currentRow + 1) + '/' + LD_ROWS;
    LDel.mult.classList.remove('pop'); void LDel.mult.offsetWidth; LDel.mult.classList.add('pop');

    const chip = LDel.mult.closest('.stat-chip');
    if (chip) {
        chip.classList.remove('mult-pulse'); void chip.offsetWidth; chip.classList.add('mult-pulse');
        chip.classList.toggle('mult-high', LD.mult >= 3);
    }

    const nextRow = LD.currentRow + 1;
    if (nextRow < LD_ROWS) {
        LDel.nextVal.textContent = 'x' + ldCumul(nextRow).toFixed(2);
    }
}

/* ── Клик по платформе ── */
async function ldTap(rowIdx, platIdx) {
    if (!LD.active || LD.locked) return;
    if (rowIdx !== LD.currentRow + 1) return;

    LD.locked = true;
    ldGetRow(rowIdx)?.classList.remove('active');

    try {
        const data = await fetchAPI('/api/ladder/step', {
            sessionId: LD.sessionId, row: rowIdx, platform: platIdx
        });

        const survived = data.safe;
        const stones   = data.stones || [];
        const isHit    = !survived;

        if (survived) sndStep(); else sndHit();
        haptic(survived ? 'light' : 'heavy');
        await ldReveal(rowIdx, stones, platIdx, isHit);

        if (survived) {
            LD.currentRow = rowIdx;
            LD.mult       = data.multiplier ?? ldCumul(rowIdx);
            ldUpdateStats();

            if (LD.currentRow === LD_ROWS - 1) {
                ldCelebratePlayer();
                await new Promise(r => setTimeout(r, 400));
                ldWin(true);
            } else {
                LDel.nextHint.style.display = 'block';
                LDel.cashout.disabled = false;
                ldSetStates(LD.currentRow + 1);
                LD.locked = false;
            }
        } else {
            await new Promise(r => setTimeout(r, 550));
            ldGameOver();
        }

    } catch(err) {
        LD.locked = false;
        ldSetStates(rowIdx); /* вернуть активность ряда */
        openModal('⚠️', 'Ошибка', 'Не удалось обработать ход', err.message || 'Проблема с сетью', null);
    }
}

function ldGameOver() {
    LD.active = false;
    LD.locked = false;
    changeBalance(-LD.bet);
    recordGame(false, -LD.bet);
    hNotify('error');
    const rowReached = LD.currentRow + 1;
    pushHistory(lHistData, 'lHistory', false, '💥 r' + rowReached);
    sndLose();
    openModal('💥', 'Упал!', 'Дошёл до ряда ' + rowReached + ' из ' + LD_ROWS, '-' + fmtFull(LD.bet), false);
    setTimeout(closeModal, 1500);
    ldResetUI();
}

function ldWin(topReached) {
    LD.active = false;
    LD.locked = false;
    const total  = LD.bet * LD.mult;
    const profit = total - LD.bet;
    changeBalance(profit);
    recordGame(true, profit);
    hNotify('success');
    ldCelebratePlayer();
    const sub = topReached
        ? '🏆 Покорил вершину! x' + LD.mult.toFixed(2)
        : 'x' + LD.mult.toFixed(2) + ' · Ряд ' + (LD.currentRow + 1) + '/' + LD_ROWS;
    pushHistory(lHistData, 'lHistory', true, '🎉 x' + LD.mult.toFixed(2));
    sndWin();
    openModal('🎉', 'Победа!', sub, '+' + fmtFull(profit), true);
    setTimeout(closeModal, 3000);
    ldResetUI();
}

async function ldCashout() {
    if (!LD.active || LD.locked || LD.currentRow < 0) return;

    LDel.cashout.disabled = true;
    LD.locked = true;

    try {
        const data = await fetchAPI('/api/ladder/cashout', { sessionId: LD.sessionId });
        LD.mult = data.multiplier ?? LD.mult;
        ldWin(false);
    } catch(err) {
        LD.locked = false;
        LDel.cashout.disabled = false;
        openModal('⚠️', 'Ошибка', 'Не удалось забрать выигрыш', err.message || 'Проблема с сетью', null);
    }
}

function ldResetUI() {
    LDel.settings.style.display = 'block';
    LDel.panel.style.display    = 'none';
    LDel.nextHint.style.display = 'none';
    LDel.cashout.disabled = true;
    LD.currentRow = -1;
    LD.mult = 1.0;
    LDel.mult.textContent   = 'x1.00';
    LDel.rowLbl.textContent = '0/12';
    LDel.mult.closest('.stat-chip')?.classList.remove('mult-high');
    ldBuildGrid();
}

async function ldStart() {
    const bet = parseFloat(LDel.betInput.value);
    if (!bet || bet <= 0) { openModal('⚠️', 'Ошибка', '', 'Введите корректную ставку', null); return; }
    const avail = getActiveBalance();
    if (bet > avail) {
        openModal('⚠️', 'Мало средств', '', activeWallet === 'donate' ? fmtDonate(avail) : fmtShort(avail), null);
        return;
    }

    const startBtn = document.getElementById('lStartBtn');
    const origText = startBtn.textContent;
    startBtn.textContent = 'Загрузка...';
    startBtn.disabled = true;

    try {
        const wallet = activeWallet;
        const data   = await fetchAPI('/api/ladder/start', { stake: bet, wallet, stones: LD.stones });

        LD.sessionId  = data.sessionId;
        LD.bet        = bet;
        LD.active     = true;
        LD.locked     = false;
        LD.currentRow = -1;
        LD.mult       = 1.0;

        try {
            localStorage.setItem('bfg_l_bet',    bet);
            localStorage.setItem('bfg_l_stones', LD.stones);
        } catch(e) {}

        ldBuildGrid();
        ldSetStates(0);
        LDel.settings.style.display = 'none';
        LDel.panel.style.display    = 'block';
        LDel.nextHint.style.display = 'none';
        LDel.cashout.disabled       = true;
        ldUpdateStats();
        sndBet();
        haptic('medium');

    } catch(err) {
        openModal('⚠️', 'Ошибка', 'Не удалось начать игру', err.message || 'Проблема с сетью', null);
    } finally {
        startBtn.textContent = origText;
        startBtn.disabled = false;
    }
}

/* ── Event delegation (сетка) ── */
document.getElementById('lGrid').addEventListener('click', e => {
    const cell = e.target.closest('.l-cell');
    if (!cell) return;
    ldTap(parseInt(cell.dataset.r), parseInt(cell.dataset.p));
});

/* ── Кнопки ── */
document.getElementById('lStartBtn').addEventListener('click',   () => { sndClick(); ldStart(); });
document.getElementById('lCashoutBtn').addEventListener('click', ldCashout);

/* ── Пресеты камней ── */
document.querySelectorAll('.stone-opt').forEach(btn => {
    btn.addEventListener('click', () => {
        if (LD.active) return;
        document.querySelectorAll('.stone-opt').forEach(b => b.classList.remove('sel'));
        btn.classList.add('sel');
        LD.stones = parseInt(btn.dataset.s);
        LDel.badge.textContent = LD.stones;
        haptic('light');
    });
});

/* ── Быстрые ставки ── */
document.getElementById('lSettings').querySelectorAll('.qb').forEach(b => {
    b.addEventListener('click', () => {
        LDel.betInput.value = b.dataset.v;
        haptic('light');
    });
});

/* ── Инициализация ── */
(function restoreLadderSettings() {
    try {
        const bet = localStorage.getItem('bfg_l_bet');
        if (bet) LDel.betInput.value = bet;
        const stones = localStorage.getItem('bfg_l_stones');
        if (stones) {
            const v = parseInt(stones);
            LD.stones = v;
            LDel.badge.textContent = v;
            document.querySelectorAll('.stone-opt').forEach(b => {
                b.classList.toggle('sel', parseInt(b.dataset.s) === v);
            });
        }
    } catch(e) {}
})();

ldBuildGrid();
