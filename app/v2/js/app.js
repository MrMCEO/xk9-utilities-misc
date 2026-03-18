/**
 * app.js — точка входа приложения.
 * Инициализирует Telegram WebApp, тему, навигацию табов, баланс из URL,
 * привязывает ripple-эффекты и запускает все игровые модули.
 */

// Dev-режим: если нет Telegram — подключить моки
if (!window.Telegram?.WebApp?.initData) {
    import('./dev-mock.js');
}

import { renderBalances, setActiveWallet, activeWallet, initBalanceFromUrl, initDonateFromUrl } from './balance.js';
import { applyRipples, initModalBindings, haptic, openModal } from './ui.js';
import { initDeposit }  from './deposit.js';
import { initAdmin }    from './admin.js';

/* Импортируем игровые модули для их side-effect инициализации */
import { isRocketActive } from './rocket.js';
import { isMineActive }   from './minesweeper.js';
import { isLadderActive } from './ladder.js';

/** Проверить, активна ли хоть одна игра */
function isAnyGameActive() {
    return isRocketActive() || isMineActive() || isLadderActive();
}

/* ════════════════════════════════════
   WS URL ДЛЯ МУЛЬТИПЛЕЕРНОГО КРАША
════════════════════════════════════ */
if (!window.MP_CRASH_WS_URL) {
    const proto   = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const apiHost = window.API_URL ? new URL(window.API_URL).host : location.host;
    window.MP_CRASH_WS_URL = `${proto}//${apiHost}/ws/crash`;
}

/* MP Краш — инициализируется один раз при наличии экрана */
let _mpCrashInit = false;
function ensureMpCrashInit() {
    if (_mpCrashInit) return;
    _mpCrashInit = true;
    import('./crash-mp.js').then(m => m.initCrashMp());
}

/* ════════════════════════════════════
   TELEGRAM
════════════════════════════════════ */
const tg = window.Telegram?.WebApp || {};
if (tg.ready) { tg.ready(); tg.expand(); tg.disableVerticalSwipes?.(); }

/* ════════════════════════════════════
   ТЕМА
════════════════════════════════════ */
const html = document.documentElement;

function applyTheme(t) {
    html.setAttribute('data-theme', t);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = t === 'dark' ? '🌙' : '☀️';
    try { localStorage.setItem('bfg_theme', t); } catch(e) {}
}

(function initTheme() {
    let s;
    try { s = localStorage.getItem('bfg_theme'); } catch(e) {}
    applyTheme(s || tg.colorScheme || 'dark');
})();

document.getElementById('themeBtn').addEventListener('click', () => {
    applyTheme(html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    haptic('light');
});

/* ════════════════════════════════════
   НАВИГАЦИЯ ТАБОВ
════════════════════════════════════ */
let curTab = 'rocket';
const tabMap = {
    rocket:   'screenRocket',
    mine:     'screenMine',
    ladder:   'screenLadder',
    'crash-mp': 'screenCrashMp',
};

/* Объект-обёртка для передачи curTab по ссылке в admin.js */
const curTabRef = {
    get value() { return curTab; },
    set value(v) { curTab = v; }
};

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === curTab) return;

        /* Предупреждение при активной игре */
        if (isAnyGameActive()) {
            openModal('⚠️', 'Внимание', 'У вас активная игра! Переключение вкладки не остановит её.', '', null);
        }

        document.getElementById(tabMap[curTab])?.classList.remove('active');
        document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        curTab = tab;
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        document.getElementById(tabMap[tab])?.classList.add('active');

        /* Подключить мультиплеерный краш при первом переходе на таб */
        if (tab === 'crash-mp') ensureMpCrashInit();

        haptic('light');
    });
});

/* ════════════════════════════════════
   КОШЕЛЁК — клики на все тогглы
════════════════════════════════════ */
document.querySelectorAll('.wallet-toggle').forEach(toggle => {
    toggle.addEventListener('click', e => {
        const btn = e.target.closest('.wt-btn');
        if (!btn) return;
        setActiveWallet(btn.dataset.wallet);
        haptic('light');
    });
});

/* ════════════════════════════════════
   ИНИЦИАЛИЗАЦИЯ БАЛАНСОВ
════════════════════════════════════ */
initBalanceFromUrl();
initDonateFromUrl();
renderBalances();
setActiveWallet(activeWallet);

/* ════════════════════════════════════
   МОДАЛЬНЫЕ ОКНА
════════════════════════════════════ */
initModalBindings();

/* ════════════════════════════════════
   ПОПОЛНЕНИЕ
════════════════════════════════════ */
initDeposit();

/* ════════════════════════════════════
   ADMIN
════════════════════════════════════ */
initAdmin(curTabRef, tabMap);

/* ════════════════════════════════════
   RIPPLES
════════════════════════════════════ */
applyRipples();

/* ════════════════════════════════════
   AUDIO CONTEXT RESUME (по первому жесту)
════════════════════════════════════ */
document.addEventListener('click', () => {
    if (window._audioCtx && window._audioCtx.state === 'suspended') {
        window._audioCtx.resume();
    }
}, { once: true });

/* ════════════════════════════════════
   ПРЕДУПРЕЖДЕНИЕ ПРИ УХОДЕ С АКТИВНОЙ ИГРЫ
════════════════════════════════════ */
window.addEventListener('beforeunload', (e) => {
    if (isAnyGameActive()) {
        e.preventDefault();
        e.returnValue = 'У вас активная игра!';
    }
});
