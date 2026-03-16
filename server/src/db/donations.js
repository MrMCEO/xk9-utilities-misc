'use strict';

const { getDb } = require('./connection');

/**
 * Записать платёж Telegram Stars и зачислить монеты на donate_balance.
 * Одна транзакция с UNIQUE constraint защитой от дублей.
 * Возвращает новый donate_balance.
 */
function addDonation(telegramId, telegramPaymentChargeId, providerPaymentChargeId, amountStars, coinsCredited) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO donations (telegram_id, telegram_payment_charge_id, provider_payment_charge_id, amount_rub, coins_credited)
       VALUES (?, ?, ?, ?, ?)`
    ).run(telegramId, telegramPaymentChargeId, providerPaymentChargeId || null, amountStars, coinsCredited);

    const row = db.prepare(
      `UPDATE users SET donate_balance=donate_balance+?, updated_at=CURRENT_TIMESTAMP
       WHERE telegram_id=? RETURNING donate_balance`
    ).get(coinsCredited, telegramId);

    return row ? row.donate_balance : 0;
  });
  return tx();
}

/** История пополнений пользователя */
function getUserDonations(telegramId, limit = 10) {
  return getDb().prepare(
    'SELECT * FROM donations WHERE telegram_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(telegramId, limit);
}

module.exports = { addDonation, getUserDonations };
