/**
 * balance.js — управление балансами (основной и донатный).
 * Экспортирует функции и реактивные переменные для использования в других модулях.
 */

/* ── Состояние ── */
export let balance       = _loadBalance();
export let donateBalance = _loadDonate();
export let activeWallet  = _loadWallet();

function _loadBalance() {
    try { const v = localStorage.getItem('bfg_balance'); return v !== null ? parseFloat(v) : 1_000_000; }
    catch(e) { return 1_000_000; }
}
function _loadDonate() {
    try { const v = localStorage.getItem('bfg_donate_balance'); return v !== null ? parseFloat(v) : 0; }
    catch(e) { return 0; }
}
function _loadWallet() {
    try { return localStorage.getItem('bfg_active_wallet') || 'main'; }
    catch(e) { return 'main'; }
}

/* ── Форматирование ── */
export function fmtFull(v)   { return '$' + Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 }); }
export function fmtShort(v)  { return '$' + Math.round(v).toLocaleString('ru-RU'); }
export function fmtDonate(v) { return '⭐ ' + Math.round(v).toLocaleString('ru-RU'); }

/* ── Получить активный баланс ── */
export function getActiveBalance() {
    return activeWallet === 'donate' ? donateBalance : balance;
}

/* ── Анимированный счётчик ── */
function animateCounter(el, startVal, endVal, duration, fmtFn) {
    const startTime = performance.now();
    const diff = endVal - startVal;
    function step(now) {
        const elapsed = Math.min(now - startTime, duration);
        const t       = elapsed / duration;
        const eased   = 1 - Math.pow(1 - t, 4); // easeOutQuart
        el.textContent = fmtFn(startVal + diff * eased);
        if (elapsed < duration) requestAnimationFrame(step);
        else el.textContent = fmtFn(endVal);
    }
    requestAnimationFrame(step);
}

/* ── Изменить баланс (delta может быть отрицательным) ── */
export function changeBalance(delta) {
    const balEl    = document.getElementById('balVal');
    const balDonEl = document.getElementById('balDonate');

    if (activeWallet === 'donate') {
        const prev = donateBalance;
        if (delta < 0 && donateBalance + delta < 0) donateBalance = 0;
        else donateBalance += delta;
        try { localStorage.setItem('bfg_donate_balance', donateBalance); } catch(e) {}
        animateCounter(balDonEl, prev, donateBalance, 600, v => '⭐ ' + Math.round(v).toLocaleString('ru-RU'));
    } else {
        const prev = balance;
        balance += delta;
        try { localStorage.setItem('bfg_balance', balance); } catch(e) {}
        animateCounter(balEl, prev, balance, 700, fmtShort);
        balEl.classList.remove('fu', 'fd');
        void balEl.offsetWidth;
        balEl.classList.add(delta >= 0 ? 'fu' : 'fd');
    }
}

/* ── Установить активный кошелёк ── */
export function setActiveWallet(wallet) {
    activeWallet = wallet;
    try { localStorage.setItem('bfg_active_wallet', wallet); } catch(e) {}
    document.querySelectorAll('.wallet-toggle').forEach(toggle => {
        toggle.querySelectorAll('.wt-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.wallet === wallet);
        });
    });
}

/* ── Синхронизировать отображение обоих балансов ── */
export function renderBalances() {
    const balEl    = document.getElementById('balVal');
    const balDonEl = document.getElementById('balDonate');
    if (balEl)    balEl.textContent    = fmtShort(balance);
    if (balDonEl) balDonEl.textContent = fmtDonate(donateBalance);
}

/* ── Инициализация баланса из URL-параметра ?b=N ── */
export function initBalanceFromUrl() {
    try {
        const urlB = new URLSearchParams(window.location.search).get('b');
        if (urlB !== null) {
            const val = parseFloat(urlB);
            if (!isNaN(val) && val >= 0) {
                balance = val;
                try { localStorage.setItem('bfg_balance', balance); } catch(e) {}
                const balEl = document.getElementById('balVal');
                if (balEl) balEl.textContent = fmtShort(balance);
            }
        }
    } catch(e) {}
}

/* ── Инициализация донатного баланса из URL-параметра ?db=N ── */
export function initDonateFromUrl() {
    try {
        const urlDb = new URLSearchParams(window.location.search).get('db');
        const balDonEl = document.getElementById('balDonate');
        if (urlDb !== null) {
            const val = parseInt(urlDb);
            if (!isNaN(val) && val >= 0) {
                donateBalance = val;
                try { localStorage.setItem('bfg_donate_balance', donateBalance); } catch(e) {}
                if (balDonEl) balDonEl.textContent = fmtDonate(donateBalance);
            }
        } else {
            /* Fallback: start_param из Telegram initData */
            const ud = window.Telegram?.WebApp?.initDataUnsafe;
            if (ud && ud.start_param) {
                const m = ud.start_param.match(/^db(\d+)$/);
                if (m) {
                    donateBalance = parseInt(m[1]);
                    try { localStorage.setItem('bfg_donate_balance', donateBalance); } catch(e) {}
                    if (balDonEl) balDonEl.textContent = fmtDonate(donateBalance);
                }
            }
        }
    } catch(e) {}
}

/* ── Установить баланс напрямую с сервера (без дельты) ── */
export function setBalanceFromServer(serverBalance) {
    const balEl = document.getElementById('balVal');
    const prev  = balance;
    balance = serverBalance;
    try { localStorage.setItem('bfg_balance', balance); } catch(e) {}
    if (balEl) {
        animateCounter(balEl, prev, balance, 700, fmtShort);
        balEl.classList.remove('fu', 'fd');
        void balEl.offsetWidth;
        balEl.classList.add(balance >= prev ? 'fu' : 'fd');
    }
}

/* ── Прямое обновление донатного баланса (после пополнения) ── */
export function addDonate(amount) {
    const balDonEl = document.getElementById('balDonate');
    const prev = donateBalance;
    donateBalance += amount;
    try { localStorage.setItem('bfg_donate_balance', donateBalance); } catch(e) {}
    if (balDonEl) {
        animateCounter(balDonEl, prev, donateBalance, 600, v => '⭐ ' + Math.round(v).toLocaleString('ru-RU'));
    }
}
