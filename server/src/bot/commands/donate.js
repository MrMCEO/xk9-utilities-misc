'use strict';

const { COINS_PER_STAR } = require('../../config');
const { getDonateKeyboard } = require('../keyboards');
const { addDonation } = require('../../db/donations');

/** Отправить инвойс Telegram Stars */
async function sendDonateInvoice(ctx, userId, amountStars) {
  const coins = amountStars * COINS_PER_STAR;
  await ctx.replyWithInvoice(
    'Пополнение BFG Casino',
    `Зачислит ${coins.toLocaleString('ru')} монет на ваш игровой баланс`,
    `donate_${amountStars}_${userId}`,
    'XTR',
    [{ label: `${coins.toLocaleString('ru')} монет`, amount: amountStars }],
    { provider_token: '', start_parameter: 'donate' }
  );
}

/** Команда /donate и кнопка 💳 Пополнить */
async function donateCommand(ctx) {
  await ctx.reply(
    `⭐ <b>Пополнение баланса</b>\n\n1 звезда = ${COINS_PER_STAR.toLocaleString('ru')} монет\n\nВыберите сумму пополнения:`,
    { reply_markup: getDonateKeyboard(), parse_mode: 'HTML' }
  );
}

/** Обработать выбор готовой суммы (callback donate_<N>) */
async function donateCbAmount(ctx) {
  const parts = ctx.callbackQuery.data.split('_');
  const amountStars = parseInt(parts[1], 10);
  if (isNaN(amountStars) || amountStars <= 0 || amountStars > 2500) {
    await ctx.answerCallbackQuery('Неверная сумма');
    return;
  }
  await ctx.answerCallbackQuery();
  await sendDonateInvoice(ctx, ctx.from.id, amountStars);
}

/** Обработать pre_checkout_query */
async function preCheckoutHandler(ctx) {
  const payload = ctx.preCheckoutQuery.invoice_payload;
  if (!payload.startsWith('donate_')) {
    await ctx.answerPreCheckoutQuery(false, 'Неверный платёж');
    return;
  }
  await ctx.answerPreCheckoutQuery(true);
}

/** Обработать successful_payment */
async function successfulPaymentHandler(ctx) {
  const payment = ctx.message.successful_payment;
  const telegramId = ctx.from.id;

  let amountStars;
  try {
    amountStars = parseInt(payment.invoice_payload.split('_')[1], 10);
  } catch {
    await ctx.reply('❌ Ошибка обработки платежа. Обратитесь к администратору.');
    return;
  }

  if (!amountStars || amountStars <= 0) return;

  const coins = amountStars * COINS_PER_STAR;

  try {
    const newBalance = addDonation(
      telegramId,
      payment.telegram_payment_charge_id,
      payment.provider_payment_charge_id || '',
      amountStars,
      coins
    );
    await ctx.reply(
      `✅ <b>Баланс пополнен!</b>\n\n` +
      `Оплачено: <b>${amountStars} ⭐</b>\n` +
      `Зачислено: <b>${coins.toLocaleString('ru')} монет</b>\n` +
      `⭐ Донатный баланс: <b>${newBalance.toLocaleString('ru')} монет</b>`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error(`Ошибка зачисления доната user=${telegramId}:`, e.message);
    await ctx.reply('❌ Ошибка зачисления. Обратитесь к администратору.');
  }
}

module.exports = { donateCommand, donateCbAmount, preCheckoutHandler, successfulPaymentHandler, sendDonateInvoice };
