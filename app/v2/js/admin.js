/**
 * admin.js — Админ-панель.
 * Доступ: ?admin=1 (передаётся ботом только проверенным админам).
 * Данные: ?admindata=BASE64(JSON) от бота.
 */

import { haptic, openModal, closeModal, addRipple } from './ui.js';

export function initAdmin(curTabRef, tabMap) {
    const urlParams = new URLSearchParams(window.location.search);
    /* Бот передаёт admin=1 только проверенным администраторам.
       Данные всё равно приходят от сервера — клиент только отображает. */
    const isAdmin   = urlParams.get('admin') === '1';

    const adminBtn = document.getElementById('adminBtn');
    if (!isAdmin) return;

    adminBtn.classList.add('visible');

    let adminData = {};
    try {
        adminData = JSON.parse(atob(urlParams.get('admindata') || 'e30='));
    } catch(e) { adminData = {}; }

    let maintenanceOn = adminData.maintenance || false;
    let prevTab = curTabRef.value;

    /* ── Навигация ── */
    function openAdmin() {
        prevTab = curTabRef.value;
        Object.values(tabMap).forEach(id => document.getElementById(id)?.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.tab-bar').style.display = 'none';
        document.getElementById('screenAdmin').classList.add('active');
        haptic('light');
    }

    function closeAdmin() {
        document.getElementById('screenAdmin').classList.remove('active');
        document.querySelector('.tab-bar').style.display = '';
        const tabId = tabMap[prevTab] || tabMap.rocket;
        document.getElementById(tabId)?.classList.add('active');
        document.querySelectorAll('.tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === prevTab);
        });
        haptic('light');
    }

    adminBtn.addEventListener('click', openAdmin);
    document.getElementById('adminBackBtn').addEventListener('click', closeAdmin);

    /* ── Dashboard ── */
    document.getElementById('adUsers').textContent      = (adminData.users ?? 0).toLocaleString('ru-RU');
    document.getElementById('adBetsToday').textContent  = (adminData.bets_today ?? 0).toLocaleString('ru-RU');
    document.getElementById('adRevenue').textContent    = '$' + (adminData.revenue_today ?? 0).toLocaleString('ru-RU');
    document.getElementById('adPromos').textContent     = (adminData.active_promos ?? 0).toLocaleString('ru-RU');

    /* ── Activity Chart ── */
    const html = document.documentElement;

    function drawChart() {
        const canvas = document.getElementById('adminChart');
        const ctx    = canvas.getContext('2d');
        const dpr    = window.devicePixelRatio || 1;
        const w      = canvas.offsetWidth;
        const h      = canvas.offsetHeight;
        canvas.width  = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        const data  = adminData.activity_24h || new Array(24).fill(0);
        const max   = Math.max(...data, 1);
        const barW  = (w - 30) / 24;
        const pad   = 2;
        const isDark = html.getAttribute('data-theme') === 'dark';

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(61,90,254,0.08)';
        ctx.lineWidth   = 1;
        for (let i = 0; i < 4; i++) {
            const y = 10 + (h - 30) * (i / 3);
            ctx.beginPath();
            ctx.moveTo(24, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        for (let i = 0; i < 24; i++) {
            const barH = (data[i] / max) * (h - 30);
            const x    = 24 + i * barW + pad;
            const y    = h - 18 - barH;
            const grad = ctx.createLinearGradient(x, y, x, h - 18);
            grad.addColorStop(0, 'rgba(61,90,254,0.9)');
            grad.addColorStop(1, 'rgba(61,90,254,0.3)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.roundRect(x, y, barW - pad * 2, barH, 2);
            ctx.fill();
        }

        ctx.fillStyle  = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
        ctx.font       = '9px -apple-system, sans-serif';
        ctx.textAlign  = 'center';
        for (let i = 0; i < 24; i += 4) {
            ctx.fillText(i + 'ч', 24 + i * barW + barW / 2, h - 4);
        }
    }

    new MutationObserver(() => requestAnimationFrame(drawChart))
        .observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    requestAnimationFrame(drawChart);

    /* ── XSS escaping ── */
    function esc(s) {
        const d = document.createElement('div');
        d.textContent = String(s ?? '');
        return d.innerHTML;
    }

    /* ── Промо-коды ── */
    const promos = adminData.promo_codes || [];
    if (promos.length > 0) {
        document.getElementById('adPromoBody').innerHTML = promos.map(p =>
            `<tr><td>${esc(p.code)}</td><td>${esc(p.bonus)}</td><td>${esc(p.max_uses - p.used_count)}</td></tr>`
        ).join('');
    }

    /* ── История ставок ── */
    const bets = adminData.recent_bets || [];
    if (bets.length > 0) {
        document.getElementById('adBetsBody').innerHTML = bets.map(b =>
            `<tr>
                <td>${esc(b.player || b.user_id || '—')}</td>
                <td>${esc(b.game || '—')}</td>
                <td>$${esc((b.stake || 0).toLocaleString('ru-RU'))}</td>
                <td class="${b.won ? 'win-cell' : 'lose-cell'}">${b.won ? 'Win' : 'Lose'}</td>
                <td>x${esc((b.multiplier || 0).toFixed(2))}</td>
            </tr>`
        ).join('');
    }

    /* ── Обновить данные ── */
    document.getElementById('adRefreshBtn').addEventListener('click', () => {
        haptic('medium');
        /* Данные обновляются через бота: /admin → данные передаются в URL при следующем открытии */
        openModal('ℹ️', 'Обновление', 'Закройте панель и откройте снова через /admin в боте', '', null);
        setTimeout(closeModal, 2000);
    });

    /* ── Maintenance toggle ── */
    const maintBtn = document.getElementById('adMaintenanceBtn');
    function updateMaintBtn() {
        maintBtn.classList.toggle('active-toggle', maintenanceOn);
        maintBtn.textContent = maintenanceOn ? '🔧 Обслуживание ВКЛ' : '🔧 Режим обслуживания';
    }
    updateMaintBtn();

    maintBtn.addEventListener('click', () => {
        maintenanceOn = !maintenanceOn;
        updateMaintBtn();
        haptic('medium');
        /* Отправить команду боту через sendData */
        try {
            const tgApp = window.Telegram?.WebApp;
            if (tgApp?.sendData) {
                tgApp.sendData(JSON.stringify({ action: 'admin_maintenance_toggle' }));
            }
        } catch(e) {}
    });

    /* ── Управление балансом ── */
    document.getElementById('adBalBtn').addEventListener('click', () => {
        const userId = parseInt(document.getElementById('adBalUserId').value);
        const amount = parseFloat(document.getElementById('adBalAmount').value);
        if (!userId || isNaN(amount)) {
            openModal('⚠️', 'Ошибка', '', 'Введите User ID и сумму', null);
            return;
        }
        haptic('medium');
        /* Отправить команду боту через sendData */
        try {
            const tgApp = window.Telegram?.WebApp;
            if (tgApp?.sendData) {
                tgApp.sendData(JSON.stringify({ action: 'admin_balance', userId, amount }));
            }
        } catch(e) {}
        openModal('✅', 'Отправлено', '', 'Запрос на изменение баланса', null);
        setTimeout(closeModal, 1500);
    });

    /* Ripples для admin кнопок */
    document.querySelectorAll('.admin-ctrl-btn').forEach(btn => {
        if (!btn.dataset.ripple) { addRipple(btn); btn.dataset.ripple = '1'; }
    });
}
