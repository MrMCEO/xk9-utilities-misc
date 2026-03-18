/**
 * crash-mp.js — Мультиплеерный Краш: WebSocket клиент + Canvas-анимация графика.
 */

import { haptic, hNotify, sndWin, sndLose, sndBet, openModal, closeModal } from './ui.js';
import { changeBalance, setBalanceFromServer, getActiveBalance, activeWallet, fmtFull, fmtShort, fmtDonate } from './balance.js';
import { recordGame } from './session-stats.js';

/* ════════════════════════════════════════════════════════
   MP КРАШ — WebSocket клиент
════════════════════════════════════════════════════════ */

/* ── Авто-кэшаут ── */
let mpAutoCashoutTarget = 0;

/* ── Canvas — массив точек графика ── */
let mpChartPoints = [];
let mpWaitingEnd  = 0;   // timestamp окончания обратного отсчёта

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
        if (MPCrash.frame) { cancelAnimationFrame(MPCrash.frame); MPCrash.frame = null; }
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
    MPCrash.phase     = 'waiting';
    MPCrash.mult      = 1.0;
    MPCrash.cashedOut = false;
    MPCrash.betPlaced = false;
    mpChartPoints     = [];

    const countdown = msg.countdownMs ?? msg.countdown_ms ?? 5000;
    mpWaitingEnd = Date.now() + countdown;
    mpUpdateStatus(`Ожидание ${Math.ceil(countdown / 1000)}с`);
    mpRenderMult('x1.00', false);
    mpRenderPlayers();

    /* Запустить Canvas-анимацию ожидания */
    if (MPCrash.frame) cancelAnimationFrame(MPCrash.frame);
    MPCrash.frame = requestAnimationFrame(mpAnimateWaiting);
}

function mpPhaseRunning(msg) {
    MPCrash.phase     = 'running';
    MPCrash.startTime = Date.now() - (msg.elapsedMs ?? msg.elapsed_ms ?? 0);
    mpChartPoints     = [];

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
    if (MPCrash.frame) { cancelAnimationFrame(MPCrash.frame); MPCrash.frame = null; }

    const crashAt = msg.crashAt ?? msg.crash_at ?? MPCrash.mult;
    mpRenderMult('x' + crashAt.toFixed(2), true);
    mpUpdateStatus(`💥 Краш на x${crashAt.toFixed(2)}`);

    /* Нарисовать финальный экран краша на Canvas */
    mpDrawCrash(crashAt);

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
    const acInputCrash = document.getElementById('mpAutoCashout');
    if (acInputCrash) acInputCrash.disabled = false;
    const cashoutBtn = document.getElementById('mpCashoutBtn');
    if (cashoutBtn) cashoutBtn.disabled = true;
}

/* ════════════════════════════════════════════════════════
   CANVAS — вспомогательные функции
════════════════════════════════════════════════════════ */

/**
 * Синхронизировать физический размер Canvas с CSS-размером с учётом DPR.
 * Сохраняет логические размеры в _logicW / _logicH.
 */
function mpResizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w   = canvas.offsetWidth  || 300;
    const h   = canvas.offsetHeight || 180;
    const pw  = Math.round(w * dpr);
    const ph  = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width  = pw;
        canvas.height = ph;
        canvas.getContext('2d').scale(dpr, dpr);
    }
    canvas._logicW = w;
    canvas._logicH = h;
}

/** true — тёмная тема, false — светлая */
function isDark() {
    return document.documentElement.getAttribute('data-theme') !== 'light';
}

/* ── Canvas: фаза waiting (обратный отсчёт) ── */
function mpAnimateWaiting() {
    if (MPCrash.phase !== 'waiting') return;

    const canvas = document.getElementById('mpCanvas');
    if (!canvas) { MPCrash.frame = requestAnimationFrame(mpAnimateWaiting); return; }

    mpResizeCanvas(canvas);
    const ctx  = canvas.getContext('2d');
    const W    = canvas._logicW;
    const H    = canvas._logicH;
    const dark = isDark();

    ctx.clearRect(0, 0, W, H);

    if (dark) {
        ctx.fillStyle = 'rgba(5,5,26,0.55)';
        ctx.fillRect(0, 0, W, H);
    }

    /* Заголовок */
    ctx.fillStyle  = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
    ctx.font       = 'bold 11px monospace';
    ctx.textAlign  = 'center';
    ctx.fillText('СЛЕДУЮЩИЙ РАУНД', W / 2, H / 2 - 22);

    /* Анимированный таймер */
    const secLeft = Math.max(0, Math.ceil((mpWaitingEnd - Date.now()) / 1000));
    const pulse   = 0.80 + 0.20 * Math.sin(Date.now() / 280);
    ctx.globalAlpha = pulse;
    ctx.fillStyle   = dark ? '#f5a623' : 'rgba(160,105,0,1)';
    ctx.font        = 'bold 40px monospace';
    ctx.fillText(`${secLeft}с`, W / 2, H / 2 + 18);
    ctx.globalAlpha = 1;

    MPCrash.frame = requestAnimationFrame(mpAnimateWaiting);
}

/* ── Canvas: фаза running (график роста множителя) ── */
function mpAnimateRunning() {
    if (MPCrash.phase !== 'running') return;

    const canvas = document.getElementById('mpCanvas');
    if (!canvas) { MPCrash.frame = requestAnimationFrame(mpAnimateRunning); return; }

    mpResizeCanvas(canvas);
    const ctx  = canvas.getContext('2d');
    const W    = canvas._logicW;
    const H    = canvas._logicH;
    const dark = isDark();

    ctx.clearRect(0, 0, W, H);

    if (dark) {
        ctx.fillStyle = 'rgba(5,5,26,0.55)';
        ctx.fillRect(0, 0, W, H);
    }

    /* Добавить точку текущего кадра */
    mpChartPoints.push({ t: Date.now(), m: MPCrash.mult });
    if (mpChartPoints.length > 600) mpChartPoints.shift();

    const PAD_L  = 34;
    const PAD_B  = 6;
    const chartW = W - PAD_L;
    const chartH = H - PAD_B;
    const maxM   = Math.max(MPCrash.mult * 1.25, 2);

    /* Динамический шаг сетки */
    let step = 0.5;
    if (maxM > 10)  step = 2;
    if (maxM > 25)  step = 5;
    if (maxM > 60)  step = 15;
    if (maxM > 120) step = 30;

    /* Сетка + метки */
    ctx.setLineDash([2, 5]);
    ctx.lineWidth  = 1;
    ctx.font       = '9px monospace';
    ctx.textAlign  = 'right';
    for (let m = step; m <= maxM; m += step) {
        const y = chartH - (m / maxM) * chartH * 0.92;
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
        ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.28)';
        ctx.fillText(`${Number.isInteger(m) ? m : m.toFixed(1)}x`, PAD_L - 2, y + 3);
    }
    ctx.setLineDash([]);

    /* Кривая + заливка */
    if (mpChartPoints.length > 1) {
        const t0      = mpChartPoints[0].t;
        const elapsed = Date.now() - t0;

        const px = p => ({
            x: PAD_L + ((p.t - t0) / Math.max(elapsed, 1)) * chartW,
            y: chartH - (p.m / maxM) * chartH * 0.92,
        });

        /* Заливка */
        ctx.beginPath();
        mpChartPoints.forEach((p, i) => {
            const { x, y } = px(p);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        const last = px(mpChartPoints[mpChartPoints.length - 1]);
        ctx.lineTo(PAD_L + chartW, last.y);
        ctx.lineTo(PAD_L + chartW, chartH);
        ctx.lineTo(PAD_L, chartH);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, chartH);
        grad.addColorStop(0, 'rgba(0,230,118,0.20)');
        grad.addColorStop(1, 'rgba(0,230,118,0.01)');
        ctx.fillStyle = grad;
        ctx.fill();

        /* Линия кривой */
        ctx.beginPath();
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth   = 2.5;
        ctx.lineJoin    = 'round';
        ctx.shadowColor = '#00e676';
        ctx.shadowBlur  = 10;
        mpChartPoints.forEach((p, i) => {
            const { x, y } = px(p);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;

        /* Точка на конце кривой */
        ctx.beginPath();
        ctx.arc(PAD_L + chartW, last.y, 4, 0, Math.PI * 2);
        ctx.fillStyle   = '#00e676';
        ctx.shadowColor = '#00e676';
        ctx.shadowBlur  = 14;
        ctx.fill();
        ctx.shadowBlur  = 0;
    }

    /* Большой множитель по центру */
    const m = MPCrash.mult;
    const mc = m >= 5 ? '#f5a623' : m >= 2 ? '#00e676' : (dark ? '#fff' : '#111');
    ctx.textAlign   = 'center';
    ctx.shadowColor = mc;
    ctx.shadowBlur  = m >= 2 ? 18 : 6;
    ctx.fillStyle   = mc;
    ctx.font        = 'bold 40px monospace';
    ctx.fillText(`${m.toFixed(2)}x`, W / 2, H / 2 + 16);
    ctx.shadowBlur  = 0;

    MPCrash.frame = requestAnimationFrame(mpAnimateRunning);
}

/* ── Canvas: экран краша (статичный) ── */
function mpDrawCrash(crashedAt) {
    const canvas = document.getElementById('mpCanvas');
    if (!canvas) return;

    mpResizeCanvas(canvas);
    const ctx  = canvas.getContext('2d');
    const W    = canvas._logicW;
    const H    = canvas._logicH;
    const dark = isDark();

    ctx.clearRect(0, 0, W, H);

    /* Красный полупрозрачный фон */
    ctx.fillStyle = dark ? 'rgba(255,68,85,0.10)' : 'rgba(255,68,85,0.07)';
    ctx.fillRect(0, 0, W, H);

    /* Финальная кривая — красная */
    if (mpChartPoints.length > 1) {
        const PAD_L  = 34;
        const PAD_B  = 6;
        const chartW = W - PAD_L;
        const chartH = H - PAD_B;
        const maxM   = Math.max(crashedAt * 1.25, 2);
        const t0      = mpChartPoints[0].t;
        const elapsed = mpChartPoints[mpChartPoints.length - 1].t - t0;

        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,68,85,0.65)';
        ctx.lineWidth   = 2;
        ctx.lineJoin    = 'round';
        ctx.shadowColor = 'rgba(255,68,85,0.4)';
        ctx.shadowBlur  = 8;
        mpChartPoints.forEach((p, i) => {
            const x = PAD_L + ((p.t - t0) / Math.max(elapsed, 1)) * chartW;
            const y = chartH - (p.m / maxM) * chartH * 0.92;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    /* Текст CRASH */
    ctx.textAlign   = 'center';
    ctx.fillStyle   = '#ff4455';
    ctx.shadowColor = '#ff4455';
    ctx.shadowBlur  = 20;
    ctx.font        = 'bold 38px monospace';
    ctx.fillText('CRASH', W / 2, H / 2 - 6);
    ctx.font        = 'bold 22px monospace';
    ctx.fillText(`${crashedAt.toFixed(2)}x`, W / 2, H / 2 + 24);
    ctx.shadowBlur  = 0;
}

/* ════════════════════════════════════════════════════════
   АНИМАЦИЯ МНОЖИТЕЛЯ (game loop)
════════════════════════════════════════════════════════ */

function mpLoop() {
    if (MPCrash.phase !== 'running') return;
    const t = (Date.now() - MPCrash.startTime) / 1000;
    MPCrash.mult = 1 + t * 0.1 + Math.pow(t, 2) * 0.012;
    mpRenderMult('x' + MPCrash.mult.toFixed(2), false);

    /* Авто-кэшаут */
    if (mpAutoCashoutTarget > 0 && MPCrash.mult >= mpAutoCashoutTarget && MPCrash.betPlaced && !MPCrash.cashedOut) {
        mpCashout(true);
        return;
    }

    /* Запустить Canvas-кадр */
    MPCrash.frame = requestAnimationFrame(mpAnimateRunning);
}

/* ── Кешаут ── */
let mpCashoutIsAuto = false;

function mpCashout(isAuto = false) {
    if (!MPCrash.connected || MPCrash.phase !== 'running') return;
    if (!MPCrash.betPlaced || MPCrash.cashedOut) return;
    MPCrash.cashedOut = true;
    mpCashoutIsAuto = isAuto;
    MPCrash.ws.send(JSON.stringify({ type: 'cashout', sessionId: MPCrash.sessionId }));
}

function mpCashoutResult(msg) {
    const acInput = document.getElementById('mpAutoCashout');
    if (msg.ok) {
        setBalanceFromServer(msg.balance);
        sndWin();
        const modalTitle = mpCashoutIsAuto
            ? `Авто-кэшаут на x${(msg.multiplier || 1).toFixed(2)}`
            : 'Множитель x' + (msg.multiplier || 1).toFixed(2);
        openModal('🎉', 'Победа!', modalTitle, '+' + fmtFull(msg.winnings ?? 0), true);
        setTimeout(closeModal, 1500);
    } else {
        if (msg.balance !== undefined) setBalanceFromServer(msg.balance);
        sndLose();
        openModal('💥', 'Слишком поздно', '', '-' + fmtFull(MPCrash.bet), false);
        setTimeout(closeModal, 1500);
    }
    mpCashoutIsAuto = false;
    MPCrash.betPlaced = false;
    MPCrash.cashedOut = false;
    if (acInput) acInput.disabled = false;
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

    const acInput = document.getElementById('mpAutoCashout');
    const acVal = parseFloat(acInput?.value);
    mpAutoCashoutTarget = (acVal >= 1.01) ? acVal : 0;
    if (acInput) acInput.disabled = true;

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
    const acInput = document.getElementById('mpAutoCashout');
    if (acInput) acInput.disabled = false;
}

/* ── UI helpers ── */

/** Экранировать HTML — защита от XSS при вставке данных от других игроков */
function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
}

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
            <span class="name">${esc(p.name || 'Игрок')}</span>
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
        /* Инициализировать Canvas — показать экран ожидания */
        const canvas = document.getElementById('mpCanvas');
        if (canvas) {
            requestAnimationFrame(() => {
                mpResizeCanvas(canvas);
                MPCrash.frame = requestAnimationFrame(mpAnimateWaiting);
            });
        }
        mpConnect();
    }
}
