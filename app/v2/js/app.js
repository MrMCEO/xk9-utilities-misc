/**
 * app.js — точка входа приложения.
 * Инициализирует Telegram WebApp, тему, навигацию табов, баланс из URL,
 * привязывает ripple-эффекты и запускает все игровые модули.
 */

import { renderBalances, setActiveWallet, activeWallet, initBalanceFromUrl, initDonateFromUrl } from './balance.js';
import { applyRipples, initModalBindings, haptic } from './ui.js';
import { initDeposit }  from './deposit.js';
import { initAdmin }    from './admin.js';

/* Импортируем игровые модули для их side-effect инициализации */
import './rocket.js';
import './minesweeper.js';
import './ladder.js';

/* MP Краш подключается только если присутствует экран */
if (document.getElementById('screenCrashMp')) {
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
    rocket: 'screenRocket',
    mine:   'screenMine',
    ladder: 'screenLadder',
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
        document.getElementById(tabMap[curTab])?.classList.remove('active');
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        curTab = tab;
        btn.classList.add('active');
        document.getElementById(tabMap[tab])?.classList.add('active');
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
