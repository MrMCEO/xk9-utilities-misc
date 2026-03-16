/**
 * deposit.js — Пополнение баланса через Telegram Stars.
 */

import { haptic, hNotify, openModal, confStart } from './ui.js';
import { addDonate, fmtDonate, donateBalance } from './balance.js';

const BOT_USERNAME = 'BFGCasinoBot';

const depositModal   = document.getElementById('depositModal');
const depositContent = document.getElementById('depositContent');
const depositSuccess = document.getElementById('depositSuccess');
const depositInput   = document.getElementById('depositAmtInput');

function tg() { return window.Telegram?.WebApp || {}; }

export function openDeposit() {
    if (!tg().initDataUnsafe?.user) {
        openModal('ℹ️', 'Только в Telegram', 'Откройте приложение через бота @' + BOT_USERNAME, '', null);
        return;
    }
    haptic('light');
    depositContent.style.display = 'block';
    depositSuccess.classList.remove('show');
    depositModal.classList.add('open');
}

export function closeDeposit() {
    depositModal.classList.remove('open');
}

function initiatePayment(_amount) {
    /* Пополнение через Stars временно недоступно — серверный эндпоинт не реализован */
    closeDeposit();
    openModal('ℹ️', 'Временно недоступно', 'Пополнение временно недоступно', 'Попробуйте позже', null);
}

function handleInvoiceClosed(amount, result) {
    if (result && result.status === 'paid') {
        addDonate(amount);
        confStart();
        depositContent.style.display = 'none';
        document.getElementById('depositSuccessSub').textContent =
            '+' + amount.toLocaleString('ru-RU') + ' ₽ зачислено на счёт';
        depositSuccess.classList.add('show');
        hNotify('success');
    } else if (result && result.status !== 'pending') {
        closeDeposit();
    }
}

export function initDeposit() {
    document.getElementById('depositBtn').addEventListener('click', openDeposit);

    depositModal.addEventListener('click', e => {
        if (e.target === depositModal) closeDeposit();
    });

    document.getElementById('depositSuccessClose').addEventListener('click', closeDeposit);

    /* Preset buttons */
    depositModal.querySelectorAll('.dep-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            haptic('medium');
            initiatePayment(parseInt(btn.dataset.amount));
        });
    });

    /* Manual pay button */
    document.getElementById('depositManualBtn').addEventListener('click', () => {
        const val = parseInt(depositInput.value);
        if (!val || val < 1) { depositInput.focus(); return; }
        haptic('medium');
        initiatePayment(val);
    });

    /* Global Telegram invoiceClosed event */
    if (tg().onEvent) {
        tg().onEvent('invoiceClosed', data => {
            if (depositModal.classList.contains('open')) {
                const match  = data && data.url && data.url.match(/deposit_(\d+)/);
                const amount = match ? parseInt(match[1]) : parseInt(depositInput.value) || 0;
                handleInvoiceClosed(amount, data);
            }
        });
    }
}
