'use strict';

const { isUserBanned, updateBalanceChecked, updateBalance } = require('../../db/users');
const { getMaintenance } = require('../../db/settings');
const { addGame } = require('../../db/games');
const { ADMIN_IDS } = require('../../config');

const MAX_STAKE = 10_000_000;

// Множители с весами (вероятностями)
const MULTIPLIERS = [
  [0,    0.25],
  [0.25, 0.15],
  [0.5,  0.15],
  [0.75, 0.10],
  [1,    0.10],
  [1.25, 0.08],
  [1.5,  0.07],
  [2,    0.05],
  [5,    0.03],
  [10,   0.015],
  [15,   0.005],
  [100,  0.0005],
];

function pickMultiplier() {
  const total = MULTIPLIERS.reduce((s, [, w]) => s + w, 0);
  let rand = Math.random() * total;
  for (const [mult, weight] of MULTIPLIERS) {
    rand -= weight;
    if (rand <= 0) return mult;
  }
  return 0;
}

/** Команда /casino <ставка> и кнопка 🎰 Казино */
async function casinoCommand(ctx) {
  if (isUserBanned(ctx.from.id)) {
    await ctx.reply('🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.');
    return;
  }
  if (getMaintenance() && !ADMIN_IDS.includes(ctx.from.id)) {
    await ctx.reply('🔧 Казино на техническом обслуживании. Попробуйте позже.');
    return;
  }

  const text = ctx.message && ctx.message.text ? ctx.message.text : '';
  const args = text.split(/\s+/);

  // Нажата кнопка без аргумента
  if (text === '🎰 Казино' || (args.length < 2)) {
    await ctx.reply(
      '❌ <b>Казино</b>\n\n' +
      'Использование: <code>/casino &lt;ставка&gt;</code>\n' +
      'Пример: <code>/casino 100</code>\n\n' +
      '🎰 Множители:\n' +
      '❌ x0, x0.25, x0.5, x0.75\n' +
      '✅ x1, x1.25, x1.5, x2, x5, x10, x15, x100',
      { parse_mode: 'HTML' }
    );
    return;
  }

  const stakeRaw = parseFloat(args[1]);
  if (isNaN(stakeRaw) || stakeRaw <= 0) {
    await ctx.reply('❌ Ставка должна быть больше 0');
    return;
  }
  if (stakeRaw > MAX_STAKE) {
    await ctx.reply(`❌ Максимальная ставка: ${MAX_STAKE.toLocaleString('ru')}`);
    return;
  }

  const multiplier = pickMultiplier();
  const winnings = stakeRaw * multiplier;
  const profit = winnings - stakeRaw;

  const { success, balance } = updateBalanceChecked(ctx.from.id, -stakeRaw);
  if (!success) {
    await ctx.reply(`❌ Недостаточно средств. Ваш баланс: ${balance.toLocaleString('ru', { minimumFractionDigits: 2 })} $`);
    return;
  }

  if (winnings > 0) updateBalance(ctx.from.id, winnings);

  addGame(ctx.from.id, 'casino', stakeRaw, profit > 0 ? 'win' : 'lose', winnings, multiplier);

  const emoji = multiplier >= 2 ? '🎉' : multiplier >= 1 ? '😐' : '💀';

  await ctx.reply(
    `🎰 <b>Казино</b>\n\n` +
    `${emoji} Множитель: <b>x${multiplier}</b>\n\n` +
    `Ставка: $${stakeRaw.toLocaleString('ru', { minimumFractionDigits: 2 })}\n` +
    `Выигрыш: $${winnings.toLocaleString('ru', { minimumFractionDigits: 2 })}\n` +
    `${profit >= 0 ? '✅' : '❌'} Профит: <b>$${profit.toLocaleString('ru', { minimumFractionDigits: 2 })}</b>`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { casinoCommand };
