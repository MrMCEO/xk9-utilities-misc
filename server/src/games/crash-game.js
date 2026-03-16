'use strict';

const { generateCrashPoint, generateServerSeed, hashServerSeed } = require('./provably-fair');
const { updateBalanceChecked, updateDonateBalanceChecked, updateBalance, updateDonateBalance } = require('../db/users');
const { addGame } = require('../db/games');
const { saveCrashRound } = require('../db/crash-rounds');

// Состояния краш-раунда
const STATE = {
  WAITING: 'waiting',   // ожидание ставок
  RUNNING: 'running',   // ракета летит
  CRASHED: 'crashed',   // краш
};

const WAITING_TIME = 8000;    // мс — время приёма ставок
const TICK_INTERVAL = 100;    // мс — интервал обновления множителя
const CRASHED_TIME = 3000;    // мс — показ результата после краша

/**
 * Формула роста множителя для краш-игры.
 * t — секунды с начала раунда
 */
function calcMultiplier(elapsed) {
  const t = elapsed / 1000;
  return Math.max(1.0, 1 + t * 0.1 + t * t * 0.012);
}

class CrashGame {
  constructor(broadcast) {
    this.broadcast = broadcast; // fn(data) — рассылка всем WS клиентам
    this.state = STATE.WAITING;
    this.multiplier = 1.0;
    this.crashAt = 1.0;
    this.serverSeed = null;
    this.roundHash = null;
    this.startTime = null;
    this.bets = new Map(); // telegramId -> { stake, wallet, cashedOut, cashoutMult }
    this._tickTimer = null;
    this._roundTimer = null;
    this.roundId = 0;
  }

  /** Запустить игровой цикл */
  start() {
    this._beginWaiting();
  }

  /** Начать фазу ожидания ставок */
  _beginWaiting() {
    this.state = STATE.WAITING;
    this.bets.clear();
    this.multiplier = 1.0;

    // Готовим следующий раунд — генерируем seed заранее
    this.serverSeed = generateServerSeed();
    this.roundHash = hashServerSeed(this.serverSeed);
    const { crashPoint } = generateCrashPoint(this.serverSeed);
    this.crashAt = crashPoint;
    this.roundId++;

    this.broadcast({
      type: 'waiting',
      roundId: this.roundId,
      nextRoundHash: this.roundHash, // клиент может проверить после краша
      timeLeft: WAITING_TIME,
    });

    this._roundTimer = setTimeout(() => this._beginRound(), WAITING_TIME);
  }

  /** Принять ставку (вызывается из WS handler) */
  placeBet(telegramId, stake, wallet = 'main') {
    if (this.state !== STATE.WAITING) {
      return { ok: false, error: 'round_running' };
    }
    if (this.bets.has(telegramId)) {
      return { ok: false, error: 'already_bet' };
    }

    const useDonate = wallet === 'donate';
    let result;
    if (useDonate) {
      result = updateDonateBalanceChecked(telegramId, Math.round(stake));
    } else {
      result = updateBalanceChecked(telegramId, -stake);
    }
    if (!result.success) {
      return { ok: false, error: 'insufficient_funds', balance: result.balance };
    }

    this.bets.set(telegramId, { stake, wallet, cashedOut: false, cashoutMult: null });
    return { ok: true, balance: result.balance };
  }

  /** Кешаут (вызывается из WS handler) */
  cashout(telegramId) {
    if (this.state !== STATE.RUNNING) {
      return { ok: false, error: 'not_running' };
    }
    const bet = this.bets.get(telegramId);
    if (!bet) return { ok: false, error: 'no_bet' };
    if (bet.cashedOut) return { ok: false, error: 'already_cashed_out' };

    const mult = this.multiplier;
    const winnings = Math.round(bet.stake * mult * 100) / 100;

    const useDonate = bet.wallet === 'donate';
    let newBalance;
    if (useDonate) {
      newBalance = updateDonateBalance(telegramId, Math.round(winnings));
    } else {
      newBalance = updateBalance(telegramId, winnings);
    }

    bet.cashedOut = true;
    bet.cashoutMult = mult;
    addGame(telegramId, 'crash', bet.stake, 'win', winnings, mult);

    return { ok: true, multiplier: mult, winnings, balance: newBalance };
  }

  /** Начать раунд */
  _beginRound() {
    this.state = STATE.RUNNING;
    this.startTime = Date.now();

    this.broadcast({
      type: 'start',
      roundId: this.roundId,
      serverSeedHash: this.roundHash,
    });

    this._tickTimer = setInterval(() => this._tick(), TICK_INTERVAL);
  }

  /** Тик — обновить множитель */
  _tick() {
    const elapsed = Date.now() - this.startTime;
    this.multiplier = Math.min(100, calcMultiplier(elapsed));

    // Проверяем краш
    if (this.multiplier >= this.crashAt) {
      this._doCrash();
      return;
    }

    this.broadcast({ type: 'tick', multiplier: Math.round(this.multiplier * 100) / 100 });
  }

  /** Выполнить краш */
  _doCrash() {
    clearInterval(this._tickTimer);
    this._tickTimer = null;
    this.state = STATE.CRASHED;

    // Записываем проигравших
    for (const [telegramId, bet] of this.bets) {
      if (!bet.cashedOut) {
        addGame(telegramId, 'crash', bet.stake, 'lose', 0, this.crashAt);
      }
    }

    // Статистика раунда
    let totalBets = 0, totalWon = 0, playerCount = 0;
    for (const bet of this.bets.values()) {
      totalBets += bet.stake;
      playerCount++;
      if (bet.cashedOut) totalWon += Math.round(bet.stake * bet.cashoutMult * 100) / 100;
    }

    saveCrashRound({
      crashPoint: this.crashAt,
      roundHash: this.roundHash,
      serverSeed: this.serverSeed,
      playersCount: playerCount,
      totalBets,
      totalWon,
    });

    this.broadcast({
      type: 'crash',
      crashAt: this.crashAt,
      serverSeed: this.serverSeed, // раскрываем seed после краша для верификации
      roundId: this.roundId,
    });

    this._roundTimer = setTimeout(() => this._beginWaiting(), CRASHED_TIME);
  }

  /** Получить текущее состояние (для нового клиента) */
  getState() {
    return {
      state: this.state,
      multiplier: this.multiplier,
      crashAt: this.state === STATE.CRASHED ? this.crashAt : undefined,
      roundId: this.roundId,
      roundHash: this.roundHash,
    };
  }
}

module.exports = { CrashGame, calcMultiplier, STATE };
