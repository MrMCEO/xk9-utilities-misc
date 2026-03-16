'use strict';

const { InlineKeyboard } = require('grammy');
const { requireAdmin } = require('./index');
const { getPromos, createPromo } = require('../../db/promos');
const { getAdminKeyboard } = require('../keyboards');
const { ADMIN_IDS } = require('../../config');

// FSM: Map<userId, { step, code?, bonus? }>
const promoFsm = new Map();

/** Callback admin_promos — список кодов */
async function cbAdminPromos(ctx) {
  if (!requireAdmin(ctx)) return;
  const promos = getPromos();

  let text = '🎁 <b>Промо-коды</b>\n\n';
  if (promos.length) {
    for (const p of promos) {
      text += `<code>${p.code}</code> | +${p.bonus.toLocaleString('ru')} монет | ${p.used_count}/${p.max_uses} исп.\n`;
    }
  } else {
    text += 'Промо-кодов пока нет.\n';
  }

  const kb = new InlineKeyboard()
    .text('➕ Создать промо', 'admin_create_promo').row()
    .text('🔙 Назад', 'admin_back');

  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' });
  await ctx.answerCallbackQuery();
}

/** Callback admin_create_promo */
async function cbAdminCreatePromo(ctx) {
  if (!requireAdmin(ctx)) return;
  promoFsm.set(ctx.from.id, { step: 'waiting_code', ts: Date.now() });
  await ctx.editMessageText(
    '🎁 <b>Создание промо-кода</b>\n\nВведите код (латинские буквы и цифры):',
    { parse_mode: 'HTML' }
  );
  await ctx.answerCallbackQuery();
}

/**
 * Обработчик FSM создания промо.
 * Возвращает true если сообщение обработано.
 */
async function handlePromoFsm(ctx) {
  if (!ADMIN_IDS.includes(ctx.from.id)) return false;
  const state = promoFsm.get(ctx.from.id);
  if (!state) return false;

  const text = (ctx.message && ctx.message.text ? ctx.message.text.trim() : '');

  if (state.step === 'waiting_code') {
    const code = text.toUpperCase();
    if (!code || !/^[A-Z0-9]+$/.test(code)) {
      await ctx.reply('❌ Код должен содержать только латинские буквы и цифры:');
      return true;
    }
    promoFsm.set(ctx.from.id, { ...state, step: 'waiting_bonus', code, ts: Date.now() });
    await ctx.reply(`Код: <code>${code}</code>\n\nВведите бонус (количество монет):`, { parse_mode: 'HTML' });
    return true;
  }

  if (state.step === 'waiting_bonus') {
    const bonus = parseInt(text, 10);
    if (isNaN(bonus) || bonus <= 0) {
      await ctx.reply('❌ Введите целое положительное число:');
      return true;
    }
    promoFsm.set(ctx.from.id, { ...state, step: 'waiting_max_uses', bonus, ts: Date.now() });
    await ctx.reply(`Бонус: <b>${bonus.toLocaleString('ru')} монет</b>\n\nВведите максимальное количество использований:`, { parse_mode: 'HTML' });
    return true;
  }

  if (state.step === 'waiting_max_uses') {
    const maxUses = parseInt(text, 10);
    if (isNaN(maxUses) || maxUses <= 0) {
      await ctx.reply('❌ Введите целое положительное число:');
      return true;
    }

    promoFsm.delete(ctx.from.id);
    const { code, bonus } = state;

    if (createPromo(code, bonus, maxUses)) {
      await ctx.reply(
        `✅ Промо-код создан!\n\nКод: <code>${code}</code>\nБонус: <b>${bonus.toLocaleString('ru')} монет</b>\nМакс. использований: <b>${maxUses}</b>`,
        { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
      );
    } else {
      await ctx.reply(
        `❌ Промо-код <code>${code}</code> уже существует.`,
        { reply_markup: getAdminKeyboard(), parse_mode: 'HTML' }
      );
    }
    return true;
  }

  return false;
}

function clearPromoFsm(userId) {
  promoFsm.delete(userId);
}

/** Геттер для TTL-очистки из bot/index.js */
function getFsmMap() { return promoFsm; }

module.exports = { cbAdminPromos, cbAdminCreatePromo, handlePromoFsm, clearPromoFsm, getFsmMap };
