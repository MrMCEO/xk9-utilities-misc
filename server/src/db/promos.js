'use strict';

const { getDb } = require('./connection');

/** Создать новый промо-код. Возвращает true если создан, false если уже существует. */
function createPromo(code, bonus, maxUses) {
  try {
    getDb().prepare(
      'INSERT INTO promo_codes (code, bonus, max_uses) VALUES (?, ?, ?)'
    ).run(code.toUpperCase(), bonus, maxUses);
    return true;
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return false;
    throw e;
  }
}

/**
 * Использовать промо-код пользователем.
 * Вся логика обёрнута в транзакцию — защита от race condition.
 * Возвращает { success: bool, message: string }
 */
function usePromo(telegramId, code) {
  const db = getDb();
  const upper = code.toUpperCase();

  const tx = db.transaction((tid, c) => {
    const promo = db.prepare('SELECT * FROM promo_codes WHERE code=?').get(c);
    if (!promo) return { success: false, message: 'Промо-код не найден' };
    if (promo.used_count >= promo.max_uses) return { success: false, message: 'Промо-код исчерпан' };

    const used = db.prepare('SELECT 1 FROM promo_uses WHERE promo_code=? AND telegram_id=?').get(c, tid);
    if (used) return { success: false, message: 'Вы уже использовали этот промо-код' };

    db.prepare('INSERT INTO promo_uses (promo_code, telegram_id) VALUES (?, ?)').run(c, tid);
    db.prepare('UPDATE promo_codes SET used_count=used_count+1 WHERE code=?').run(c);
    db.prepare(
      `UPDATE users SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?`
    ).run(promo.bonus, tid);

    return { success: true, message: `Начислено ${promo.bonus.toLocaleString('ru')} монет!` };
  });

  return tx(telegramId, upper);
}

/** Список всех промо-кодов */
function getPromos() {
  return getDb().prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
}

/** Удалить промо-код (для возможного расширения) */
function deletePromo(code) {
  const info = getDb().prepare('DELETE FROM promo_codes WHERE code=?').run(code.toUpperCase());
  return info.changes > 0;
}

module.exports = { createPromo, usePromo, getPromos, deletePromo };
