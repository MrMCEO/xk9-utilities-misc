/**
 * crash-mp.js — Мультиплеерный Краш: WebSocket клиент + Canvas.
 * Логика без изменений — только вынесена в отдельный модуль.
 */

import { haptic, hNotify, sndWin, sndLose, openModal, closeModal } from './ui.js';
import { changeBalance, setBalanceFromServer, getActiveBalance, activeWallet, fmtFull, fmtShort, fmtDonate } from './balance.js';

/* ════════════════════════════════════════════════════════
   MP КРАШ — WebSocket клиент
════════════════════════════════════════════════════════ */

const MPCrash = {
    ws:         null,
    connected:  false,
    phase:      'waiting',  // 'waiting' | 'running' | 'crashed'
    mult:       1.0,
    bet:        0,
    betPlaced:  false,
    cashedOut:  false,
    sessionId:  null,
    players:    [],
    startTime:  null,
    frame:      null,
};

/* ── Получить URL сервера MP Краш ── */
function getMpWsUrl() {
    return window.MP_CRASH_WS_URL || '';
}

/* ── Подключиться к серверу ── */
export function mpConnect() {
    const url = getMpWsUrl();
    if (!url) {
        console.warn('[crash-mp] MP_CRASH_WS_URL не настроен');
        return;
    }
    if (MPCrash.ws && MPCrash.ws.readyState < WebSocket.CLOSING) return;

    MPCrash.ws = new WebSocket(url);

    MPCrash.ws.addEventListener('open', () => {
        MPCrash.connected = true;
        mpUpdateStatus('В сети');
        /* Отправить auth с initData */
        const initData = window.Telegram?.WebApp?.initData || '';
        MPCrash.ws.send(JSON.stringify({ type: 'auth', initData }));
    });

    MPCrash.ws.addEventListener('message', e => {
        try { mpHandleMessage(JSON.parse(e.data)); } catch(err) { console.error('[crash-mp] parse error', err); }
    });

    MPCrash.ws.addEventListener('close', () => {
        MPCrash.connected = false;
        mpUpdateStatus('Переподключение...');
        setTimeout(mpConnect, 3000);
    });

    MPCrash.ws.addEventListener('error', () => {
        MPCrash.ws?.close();
    });
}

/* ── Обработка входящих сообщений ── */
function mpHandleMessage(msg) {
    switch (msg.type) {
        case 'waiting':
            mpPhaseWaiting(msg);
            break;
        case 'start':
            mpPhaseRunning(msg);
            break;
        case 'crash':
            mpPhaseCrashed(msg);
            break;
        case 'players_update':
            MPCrash.players = msg.players || [];
            mpRenderPlayers();
            break;
        case 'cashout_result':
            mpCashoutResult(msg);
            break;
        case 'error':
            openModal('⚠️', 'Ошибка', '', msg.message || 'Ошибка сервера', null);
            mpResetBet();
            break;
    }
}

/* ── Фазы ── */
function mpPhaseWaiting(msg) {
    MPCrash.phase   = 'waiting';
    MPCrash.mult    = 1.0;
    MPCrash.cashedOut = false;
    MPCrash.betPlaced = false;

    const countdown = msg.countdownMs ?? msg.countdown_ms ?? 5000;
    mpUpdateStatus(`Ожидание ${Math.ceil(countdown / 1000)}с`);
    mpRenderMult('x1.00', false);
    mpRenderPlayers();
}

function mpPhaseRunning(msg) {
    MPCrash.phase     = 'running';
    MPCrash.startTime = Date.now() - (msg.elapsedMs ?? msg.elapsed_ms ?? 0);

    /* Кнопка Забрать — разблокировать если ставка есть */
    const cashoutBtn = document.getElementById('mpCashoutBtn');
    if (cashoutBtn && MPCrash.betPlaced && !MPCrash.cashedOut) {
        cashoutBtn.disabled = false;
    }

    mpUpdateStatus('В полёте 🚀');
    if (MPCrash.frame) cancelAnimationFrame(MPCrash.frame);
    mpLoop();
}

function mpPhaseCrashed(msg) {
    MPCrash.phase = 'crashed';
    if (MPCrash.frame) cancelAnimationFrame(MPCrash.frame);

    const crashAt = msg.crashAt ?? msg.crash_at ?? MPCrash.mult;
    mpRenderMult('x' + crashAt.toFixed(2), true);
    mpUpdateStatus(`💥 Краш на x${crashAt.toFixed(2)}`);

    /* Если ставка была, но не кешаутили — проигрыш.
       Сервер уже списал ставку при placeBet — НЕ списываем повторно.
       Только показываем анимацию краша. Если сервер прислал balance — обновляем. */
    if (MPCrash.betPlaced && !MPCrash.cashedOut) {
        if (msg.balance !== undefined) setBalanceFromServer(msg.balance);
        sndLose();
        openModal('💥', 'Краш!', 'Упало на x' + crashAt.toFixed(2), '-' + fmtFull(MPCrash.bet), false);
        setTimeout(closeModal, 1500);
    }

    MPCrash.betPlaced = false;
    MPCrash.cashedOut = false;
    const cashoutBtn = document.getElementById('mpCashoutBtn');
    if (cashoutBtn) cashoutBtn.disabled = true;
}

/* ── Анимация множителя ── */
function mpLoop() {
    if (MPCrash.phase !== 'running') return;
    const t = (Date.now() - MPCrash.startTime) / 1000;
    MPCrash.mult = 1 + t * 0.1 + Math.pow(t, 2) * 0.012;
    mpRenderMult('x' + MPCrash.mult.toFixed(2), false);
    MPCrash.frame = requestAnimationFrame(mpLoop);
}

/* ── Кешаут ── */
function mpCashout() {
    if (!MPCrash.connected || MPCrash.phase !== 'running') return;
    if (!MPCrash.betPlaced || MPCrash.cashedOut) return;
    MPCrash.cashedOut = true;
    MPCrash.ws.send(JSON.stringify({ type: 'cashout', sessionId: MPCrash.sessionId }));
}

function mpCashoutResult(msg) {
    if (msg.ok) {
        /* Выигрыш — сервер уже зачислил средства */
        setBalanceFromServer(msg.balance);
        sndWin();
        openModal('🎉', 'Победа!', 'Множитель x' + (msg.multiplier || 1).toFixed(2), '+' + fmtFull(msg.winnings ?? 0), true);
        setTimeout(closeModal, 1500);
    } else {
        /* Сервер сообщил, что краш был до нашего кешаута */
        if (msg.balance !== undefined) setBalanceFromServer(msg.balance);
        sndLose();
        openModal('💥', 'Слишком поздно', '', '-' + fmtFull(MPCrash.bet), false);
        setTimeout(closeModal, 1500);
    }
    MPCrash.betPlaced = false;
    MPCrash.cashedOut = false;
    const cashoutBtn = document.getElementById('mpCashoutBtn');
    if (cashoutBtn) cashoutBtn.disabled = true;
}

/* ── Сделать ставку ── */
function mpPlaceBet() {
    if (!MPCrash.connected || MPCrash.phase !== 'waiting') return;
    if (MPCrash.betPlaced) return;

    const betInput = document.getElementById('mpBetInput');
    const bet      = parseFloat(betInput?.value || '0');
    if (!bet || bet <= 0) { openModal('⚠️', 'Ошибка', '', 'Введите корректную ставку', null); return; }

    const avail = getActiveBalance();
    if (bet > avail) {
        openModal('⚠️', 'Мало средств', '', activeWallet === 'donate' ? fmtDonate(avail) : fmtShort(avail), null);
        return;
    }

    MPCrash.bet = bet;
    MPCrash.ws.send(JSON.stringify({
        type:      'bet',
        stake:     bet,
        wallet:    activeWallet,
        initData:  window.Telegram?.WebApp?.initData || ''
    }));
    MPCrash.betPlaced = true;

    const betBtn = document.getElementById('mpBetBtn');
    if (betBtn) betBtn.disabled = true;

    haptic('medium');
}

function mpResetBet() {
    MPCrash.betPlaced = false;
    MPCrash.cashedOut = false;
    const betBtn = document.getElementById('mpBetBtn');
    if (betBtn) betBtn.disabled = false;
}

/* ── UI helpers ── */
function mpUpdateStatus(text) {
    const el = document.getElementById('mpStatus');
    if (el) el.textContent = text;
}

function mpRenderMult(text, crashed) {
    const el = document.getElementById('mpMult');
    if (!el) return;
    el.textContent = text;
    el.className   = 'mult-display' + (crashed ? ' crashed' : '');
}

function mpRenderPlayers() {
    const list = document.getElementById('mpPlayersList');
    if (!list) return;
    if (!MPCrash.players.length) {
        list.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:8px">Нет игроков</div>';
        return;
    }
    list.innerHTML = MPCrash.players.map(p => `
        <div class="crash-mp-player-row ${p.lost ? 'lost' : ''}">
            <span class="name">${p.name || 'Игрок'}</span>
            <span class="bet">${fmtShort(p.stake)}</span>
            <span class="mult">${p.cashed_out ? 'x' + p.mult.toFixed(2) : p.lost ? '💥' : '…'}</span>
        </div>
    `).join('');
}

/* ── Привязка кнопок ── */
export function initCrashMp() {
    const betBtn     = document.getElementById('mpBetBtn');
    const cashoutBtn = document.getElementById('mpCashoutBtn');

    if (betBtn)     betBtn.addEventListener('click',     mpPlaceBet);
    if (cashoutBtn) cashoutBtn.addEventListener('click', mpCashout);

    /* Быстрые ставки */
    document.getElementById('screenCrashMp')?.querySelectorAll('.qb').forEach(b => {
        b.addEventListener('click', () => {
            const inp = document.getElementById('mpBetInput');
            if (inp) inp.value = b.dataset.v;
            haptic('light');
        });
    });

    /* Подключение только если экран MP Краш присутствует в DOM */
    if (document.getElementById('screenCrashMp')) {
        mpConnect();
    }
}
