/**
 * rocket.js — Ракета: canvas-анимация + вызовы API.
 * Клиент не знает crash_at до ответа сервера.
 */

import { fetchAPI }        from './api.js';
import { openModal, closeModal, sndClick, sndWin, sndLose, sndBet, sndMilestone, haptic } from './ui.js';
import { changeBalance, getActiveBalance, activeWallet, fmtFull, fmtShort, fmtDonate } from './balance.js';
import { recordGame } from './session-stats.js';
import { addLocalHistory } from './history.js';

/* ── Авто-кэшаут ── */
let rAutoCashoutTarget = 0;

/* ── Polling состояния краша ── */
let rCheckInterval = null;

function rStopPolling() {
    if (rCheckInterval !== null) {
        clearInterval(rCheckInterval);
        rCheckInterval = null;
    }
}

function rStartPolling() {
    rStopPolling();
    rCheckInterval = setInterval(async () => {
        if (!R.active || R.cashedOut) { rStopPolling(); return; }
        try {
            const data = await fetchAPI('/api/rocket/check', { sessionId: R.sessionId });
            if (data.crashed) {
                rStopPolling();
                // Предотвратить повторный cashout
                R.cashedOut = true;
                R.active = false;
                cancelAnimationFrame(R.frame);
                R.crashAt = data.crashedAt;
                R.mult    = data.crashedAt;
                const elapsed = (Date.now() - R.t0) / 1000;
                rCrashVisual(elapsed);
            }
        } catch {
            // Игнорируем ошибки polling — краш будет обнаружен при следующем тике
        }
    }, 200);
}

/* ── Ссылки на DOM-элементы ── */
const R = {
    active: false, cashedOut: false,
    mult: 1.0, crashAt: 0, bet: 0, t0: 0,
    sessionId: null,
    frame: null,
    history: [],
    els: {
        mult:        document.getElementById('rMult'),
        hint:        document.getElementById('rHint'),
        btn:         document.getElementById('rActionBtn'),
        betInput:    document.getElementById('rBetInput'),
        histBar:     document.getElementById('rHistory'),
        canvas:      document.getElementById('rCanvas'),
        rocket:      document.getElementById('rRocket'),
        autoCashout: document.getElementById('rAutoCashout'),
    }
};

/** Экспорт состояния активной игры для app.js */
export function isRocketActive() { return R.active; }

const html = document.documentElement;
const rCtx = R.els.canvas.getContext('2d', { alpha: false });

let rCanvasW = 0, rCanvasH = 0;

function rSyncCanvasSize() {
    const cv = R.els.canvas;
    const w = cv.offsetWidth, h = cv.offsetHeight;
    if (cv.width !== w || cv.height !== h) {
        cv.width  = w;
        cv.height = h;
        rCanvasW  = w;
        rCanvasH  = h;
        starsReady = false;
    }
}

if (window.ResizeObserver) {
    new ResizeObserver(() => { rSyncCanvasSize(); }).observe(R.els.canvas);
}

/* ── Stars pool ── */
const STARS = [];
let starsReady = false;

function initStars(W, H) {
    starsReady = true;
    for (let i = 0; i < 60; i++) {
        STARS[i] = {
            x: Math.random() * W,
            y: Math.random() * H,
            r: Math.random() * 1.3 + 0.3,
            op: Math.random() * 0.55 + 0.15,
            phase: Math.random() * Math.PI * 2,
            spd: Math.random() * 0.7 + 0.3
        };
    }
}

/* ── Trajectory curve ── */
function curveFrac(n) { return 0.25 * n + 0.75 * Math.pow(n, 3); }
function elapsed2n(t) { return 1 - 1 / (1 + t / 7); }

function rDraw(elapsed, crashed) {
    const cv = R.els.canvas;
    if (cv.width !== cv.offsetWidth || cv.height !== cv.offsetHeight) rSyncCanvasSize();
    const W = rCanvasW || cv.offsetWidth;
    const H = rCanvasH || cv.offsetHeight;
    const cx = rCtx;
    const isDark = html.getAttribute('data-theme') === 'dark';

    cx.clearRect(0, 0, W, H);

    if (isDark) { cx.fillStyle = '#05051a'; cx.fillRect(0, 0, W, H); }

    if (!starsReady || STARS.length === 0) initStars(W, H);

    const now = Date.now() / 1000;
    const starSpeed = R.active ? Math.min(1.5 + (R.mult - 1) * 0.5, 10) : 0;

    for (const s of STARS) {
        const twinkle = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(now * 1.4 + s.phase));
        const opacity = isDark ? twinkle : twinkle * 0.28;
        cx.beginPath();
        cx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        cx.fillStyle = isDark ? `rgba(200,210,255,${opacity})` : `rgba(61,90,254,${opacity})`;
        cx.fill();
        if (R.active && starSpeed > 0) {
            s.y += s.spd * starSpeed;
            if (s.y > H + 2) { s.y = -2; s.x = Math.random() * W; }
        }
    }

    if (elapsed > 0) {
        const MX = 18, MY = 14;
        const Wc = W - MX * 2;
        const Hc = H - MY * 2;
        const n = elapsed2n(elapsed);
        const lineColor = crashed ? 'rgba(255,68,85,0.85)' : 'rgba(61,90,254,0.90)';
        const fillTop   = crashed ? 'rgba(255,68,85,0.18)'  : 'rgba(61,90,254,0.18)';

        function getCurvePoint(frac) {
            const f  = Math.min(frac, n);
            const cf = curveFrac(f);
            return { x: MX + f * Wc, y: MY + Hc - cf * Hc };
        }

        const SEGS = 80;
        const grad = cx.createLinearGradient(0, H, 0, MY);
        grad.addColorStop(0, fillTop);
        grad.addColorStop(1, 'transparent');

        const curvePath = new Path2D();
        curvePath.moveTo(MX, H - MY);
        for (let i = 0; i <= SEGS; i++) {
            const p = getCurvePoint(i / SEGS);
            curvePath.lineTo(p.x, p.y);
        }
        const tipP = getCurvePoint(n);

        const fillPath = new Path2D(curvePath);
        fillPath.lineTo(tipP.x, H - MY);
        fillPath.closePath();
        cx.fillStyle = grad;
        cx.fill(fillPath);

        cx.strokeStyle = lineColor;
        cx.lineWidth   = 2;
        cx.lineJoin    = 'round';
        cx.stroke(curvePath);

        /* Position rocket emoji */
        const tip  = getCurvePoint(n);
        const prev = getCurvePoint(Math.max(0, n - 0.04));
        const dx   = tip.x - prev.x;
        const dy   = tip.y - prev.y;
        const angleRad  = Math.atan2(-dy, dx);
        const rotateDeg = 45 - angleRad * 180 / Math.PI;
        const el = R.els.rocket;
        const ew = 26, eh = 26;
        el.style.left      = (tip.x - ew / 2) + 'px';
        el.style.top       = (tip.y - eh / 2) + 'px';
        el.style.transform = `rotate(${rotateDeg}deg)`;
        el.style.display   = 'block';
        el.style.filter    = crashed
            ? 'drop-shadow(0 0 10px rgba(255,68,85,0.8)) grayscale(0.6)'
            : 'drop-shadow(0 0 9px rgba(61,90,254,0.7))';
    } else {
        const el = R.els.rocket;
        el.style.left      = '18px';
        el.style.top       = (rCanvasH - 38) + 'px';
        el.style.transform = 'rotate(0deg)';
        el.style.display   = 'block';
        el.style.filter    = 'drop-shadow(0 0 8px rgba(61,90,254,0.5))';
    }
}

/* ── Animation loop ── */
const R_MILESTONES = [2, 3, 5, 7, 10, 15, 20, 30, 50, 100];
let rLastMilestone = 0;

function rTriggerMilestone(el) {
    el.classList.remove('milestone');
    void el.offsetWidth;
    el.classList.add('milestone');
    sndMilestone();
    haptic('medium');
    el.addEventListener('animationend', () => el.classList.remove('milestone'), { once: true });
}

function rLoop() {
    if (!R.active) return;
    const t = (Date.now() - R.t0) / 1000;
    const prevMult = R.mult;
    R.mult = 1 + t * 0.1 + Math.pow(t, 2) * 0.012;
    R.els.mult.textContent = 'x' + R.mult.toFixed(2);

    for (const m of R_MILESTONES) {
        if (prevMult < m && R.mult >= m && rLastMilestone !== m) {
            rLastMilestone = m;
            rTriggerMilestone(R.els.mult);
            break;
        }
    }

    rDraw(t, false);

    /* Авто-кэшаут — срабатывает если достигнут заданный множитель */
    if (rAutoCashoutTarget > 0 && R.mult >= rAutoCashoutTarget && !R.cashedOut) {
        rCashout(true);
        return;
    }

    R.frame = requestAnimationFrame(rLoop);
}

function rPushHistory(mult, won) {
    R.history.unshift({ mult, won });
    if (R.history.length > 22) R.history.pop();
    R.els.histBar.innerHTML = R.history.map(h =>
        `<span class="h-chip ${h.won ? 'w' : 'l'}">x${h.mult.toFixed(2)}</span>`
    ).join('');
}

/* ── Старт игры — запрос к серверу ── */
async function rStart() {
    const bet = parseFloat(R.els.betInput.value);
    if (!bet || bet <= 0) { openModal('⚠️', 'Ошибка', '', 'Введите корректную ставку', null); return; }
    const avail = getActiveBalance();
    if (bet > avail) {
        openModal('⚠️', 'Мало средств', '', activeWallet === 'donate' ? fmtDonate(avail) : fmtShort(avail), null);
        return;
    }

    /* Считываем авто-кэшаут */
    const acVal = parseFloat(R.els.autoCashout?.value);
    rAutoCashoutTarget = (acVal >= 1.01) ? acVal : 0;

    /* Блокируем кнопку на время запроса */
    const origText = R.els.btn.textContent;
    R.els.btn.textContent = 'Загрузка...';
    R.els.btn.disabled = true;
    R.els.betInput.disabled = true;
    if (R.els.autoCashout) R.els.autoCashout.disabled = true;

    try {
        const wallet = activeWallet;
        const data = await fetchAPI('/api/rocket/start', { stake: bet, wallet });

        R.sessionId = data.sessionId;
        R.crashAt   = 0; /* crashAt НЕ приходит от сервера — краш обнаруживается только через cashout */
        R.active    = true;
        R.cashedOut = false;
        R.mult      = 1.0;
        R.bet       = bet;
        R.t0        = Date.now();
        rLastMilestone = 0;

        try { localStorage.setItem('bfg_r_bet', bet); } catch(e) {}

        R.els.btn.disabled  = false;
        R.els.btn.textContent = 'Забрать выигрыш';
        R.els.btn.className   = 'btn btn-green';
        R.els.mult.className  = 'mult-display';
        R.els.hint.textContent = '🚀 В полёте — нажмите чтобы забрать!';
        sndBet();
        haptic('medium');

        R.frame = requestAnimationFrame(rLoop);
        rStartPolling();

    } catch(err) {
        R.els.btn.textContent   = origText;
        R.els.btn.disabled      = false;
        R.els.betInput.disabled = false;
        if (R.els.autoCashout) R.els.autoCashout.disabled = false;
        openModal('⚠️', 'Ошибка', 'Не удалось начать игру', err.message || 'Проблема с сетью', null);
    }
}

/* ── Cashout ── */
async function rCashout(isAuto = false) {
    if (!R.active || R.cashedOut) return;
    R.cashedOut = true;
    rStopPolling();
    // НЕ останавливаем анимацию здесь — блокируем только кнопку
    R.els.btn.disabled = true;

    try {
        const data = await fetchAPI('/api/rocket/cashout', { sessionId: R.sessionId });

        // Останавливаем анимацию после ответа сервера
        cancelAnimationFrame(R.frame);
        const elapsed = (Date.now() - R.t0) / 1000;
        const localMult = R.mult;

        const finalMult = data.multiplier ?? localMult;
        const won       = data.ok ?? true;

        R.active = false;
        rDraw(elapsed, false);
        R.els.betInput.disabled = false;
        if (R.els.autoCashout) R.els.autoCashout.disabled = false;
        R.els.btn.disabled      = false;
        R.els.btn.textContent   = 'Сделать ставку';
        R.els.btn.className     = 'btn btn-brand';
        R.els.mult.className    = 'mult-display';

        if (won) {
            const total  = R.bet * finalMult;
            const profit = total - R.bet;
            rPushHistory(finalMult, true);
            sndWin();
            changeBalance(profit);
            recordGame(true, profit);
            addLocalHistory({ game_type: 'rocket', stake: R.bet, won: true, multiplier: finalMult, winnings: total, wallet: activeWallet });
            R.els.hint.textContent = '✅ Забрали ' + fmtFull(total);
            R.els.mult.textContent = 'x' + finalMult.toFixed(2);
            const modalTitle = isAuto
                ? `Авто-кэшаут на x${finalMult.toFixed(2)}`
                : 'Множитель x' + finalMult.toFixed(2);
            setTimeout(() => {
                openModal('🎉', 'Победа!', modalTitle, '+' + fmtFull(profit), true);
                setTimeout(closeModal, 3000);
            }, 200);
        } else {
            /* Краш произошёл до нашего кешаута */
            R.crashAt = data.crashAt ?? finalMult;
            R.mult    = R.crashAt;
            rCrashVisual(elapsed);
        }

    } catch(err) {
        /* Сеть пропала — откатываем состояние и возобновляем polling */
        R.cashedOut = false;
        R.active    = true;
        R.els.btn.disabled = false;
        openModal('⚠️', 'Ошибка', 'Не удалось забрать выигрыш', err.message || 'Проблема с сетью', null);
        R.frame = requestAnimationFrame(rLoop);
        rStartPolling();
    }
}

/* ── Локальный краш (вызывается при обнаружении краша через polling) ── */
function rCrash() {
    rStopPolling();
    cancelAnimationFrame(R.frame);
    R.active = false;
    const elapsed = (Date.now() - R.t0) / 1000;
    rCrashVisual(elapsed);
}

function rCrashVisual(elapsed) {
    rPushHistory(R.crashAt, false);
    sndLose();
    changeBalance(-R.bet);
    recordGame(false, -R.bet);
    addLocalHistory({ game_type: 'rocket', stake: R.bet, won: false, multiplier: R.crashAt, winnings: 0, wallet: activeWallet });
    rDraw(elapsed, true);
    R.els.mult.classList.add('crashed');
    R.els.mult.textContent = 'x' + R.crashAt.toFixed(2);
    R.els.hint.textContent = '💥 Краш!';
    R.els.betInput.disabled = false;
    if (R.els.autoCashout) R.els.autoCashout.disabled = false;
    R.els.btn.disabled      = false;
    R.els.btn.textContent   = 'Сделать ставку';
    R.els.btn.className     = 'btn btn-brand';
    haptic('heavy');
    setTimeout(() => {
        openModal('💥', 'Краш!', 'Упало на x' + R.crashAt.toFixed(2), '-' + fmtFull(R.bet), false);
        setTimeout(closeModal, 1500);
    }, 650);
}

/* ── Кнопка действия ── */
document.getElementById('rActionBtn').addEventListener('click', () => {
    const btn = R.els.btn;
    /* Синхронная защита от двойного нажатия до того, как disabled успеет сработать */
    if (btn.dataset.pending) return;
    sndClick();
    if (R.active && !R.cashedOut) rCashout();
    else if (!R.active) {
        btn.dataset.pending = '1';
        rStart().finally(() => { delete btn.dataset.pending; });
    }
});

/* ── Быстрые ставки ── */
document.getElementById('screenRocket').querySelectorAll('.qb').forEach(b => {
    b.addEventListener('click', () => {
        R.els.betInput.value = b.dataset.v;
        haptic('light');
    });
});

/* ── Инициализация ── */
(function initRocketDraw() {
    try { const b = localStorage.getItem('bfg_r_bet'); if (b) R.els.betInput.value = b; } catch(e) {}
    requestAnimationFrame(() => { rSyncCanvasSize(); rDraw(0, false); });
})();
