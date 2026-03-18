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
import { initDeposit }     from './deposit.js';
import { initAdmin }       from './admin.js';
import { loadHistory }     from './history.js';
import { loadLeaderboard } from './leaderboard.js';

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
    rocket:       'screenRocket',
    mine:         'screenMine',
    ladder:       'screenLadder',
    'crash-mp':   'screenCrashMp',
    history:      'screenHistory',
    leaderboard:  'screenLeaderboard',
};

/* Объект-обёртка для передачи curTab по ссылке в admin.js */
const curTabRef = {
    get value() { return curTab; },
    set value(v) { curTab = v; }
};

/** Единая функция переключения вкладки */
function switchTab(tab) {
    if (tab === curTab) return;

    /* Предупреждение при активной игре */
    if (isAnyGameActive()) {
        openModal('⚠️', 'Внимание', 'У вас активная игра! Переключение вкладки не остановит её.', '', null);
    }

    /* Скрыть текущий экран */
    document.getElementById(tabMap[curTab])?.classList.remove('active');

    /* Обновить состояние старых tab-btn (для обратной совместимости) */
    document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    const oldTabBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (oldTabBtn) {
        oldTabBtn.classList.add('active');
        oldTabBtn.setAttribute('aria-selected', 'true');
    }

    /* Обновить активный пункт бокового меню */
    document.querySelectorAll('.sidebar-item[data-tab]').forEach(b => b.classList.remove('active'));
    const sidebarItem = document.querySelector(`.sidebar-item[data-tab="${tab}"]`);
    if (sidebarItem) sidebarItem.classList.add('active');

    curTab = tab;

    /* Показать новый экран */
    document.getElementById(tabMap[tab])?.classList.add('active');

    /* Подключить мультиплеерный краш при первом переходе */
    if (tab === 'crash-mp') ensureMpCrashInit();

    /* Загрузить историю ставок при переходе на вкладку */
    if (tab === 'history') loadHistory();

    /* Загрузить лидерборд при переходе на вкладку */
    if (tab === 'leaderboard') loadLeaderboard();

    haptic('light');
}

/* Старые tab-btn — работают через switchTab */
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ════════════════════════════════════
   БУРГЕР-МЕНЮ
════════════════════════════════════ */
const burgerBtn       = document.getElementById('burgerBtn');
const sidebar         = document.getElementById('sidebar');
const sidebarOverlay  = document.getElementById('sidebarOverlay');
const sidebarClose    = document.getElementById('sidebarClose');

function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('open');
}
function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
}

burgerBtn?.addEventListener('click', openSidebar);
sidebarClose?.addEventListener('click', closeSidebar);
sidebarOverlay?.addEventListener('click', closeSidebar);

/* Выбор вкладки из бокового меню */
document.querySelectorAll('.sidebar-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
        closeSidebar();
    });
});

/* Свайп для открытия/закрытия меню */
let touchStartX = 0;
document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
}, { passive: true });
document.addEventListener('touchend', (e) => {
    const diff = e.changedTouches[0].clientX - touchStartX;
    /* Свайп вправо от левого края → открыть меню */
    if (touchStartX < 30 && diff > 60) openSidebar();
    /* Свайп влево при открытом меню → закрыть */
    if (sidebar.classList.contains('open') && diff < -60) closeSidebar();
}, { passive: true });

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
