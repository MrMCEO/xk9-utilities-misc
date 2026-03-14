const { generateSeed, computeCrashPoint, getRoundHash } = require('./provably-fair');
const db = require('./db');

const BETTING_DURATION = 10; // Секунды на ставки
const PAUSE_DURATION = 3;   // Пауза между раундами
const TICK_INTERVAL = 50;    // Интервал обновления множителя (мс)
const MAX_MULTIPLIER = 1000; // Максимальный множитель (лимит на случай недостижимого краша)

/**
 * Класс краш-игры
 * Управляет жизненным циклом раундов, сбирает ставки, обрабатывает кешауты и сохраняет результаты
 */
class CrashGame {
  /**
   * @param {WsManager} wsManager - Менеджер WebSocket-соединений
   * @param {number[]} adminIds - Список ID администраторов (могут играть на обслуживании)
   */
  constructor(wsManager, adminIds = []) {
    this.ws = wsManager;
    this.adminIds = adminIds;
    this.state = 'waiting'; // 'betting' | 'running' | 'crashed'
    this.roundCounter = 0;
    this.serverSeed = generateSeed();
    this.currentRound = null;
    this.history = []; // Последние 20 раундов для истории клиента
    this._running = false;
    this._tickTimer = null;
    this._bettingTimer = null;
    this._bettingStartTime = 0;

    // Подписываем обработчики на события WsManager
    wsManager.onConnect = (userId, ws) => this._onConnect(userId, ws);
    wsManager.onDisconnect = (userId, ws) => this._onDisconnect(userId, ws);
    wsManager.onMessage = (userId, data, ws) => this._onMessage(userId, data, ws);
  }

  /**
   * Запустить игровой цикл
   */
  async start() {
    this._running = true;
    console.log('[CrashGame] Engine started');
    this._loop();
  }

  /**
   * Остановить игровой цикл
   */
  stop() {
    this._running = false;
    if (this._tickTimer) clearInterval(this._tickTimer);
    if (this._bettingTimer) clearInterval(this._bettingTimer);
  }

  /**
   * Главный игровой цикл (Betting → Running → Crashed → Pause → повтор)
   */
  async _loop() {
    while (this._running) {
      try {
        // Этап 1: генерация нового раунда с фиксированной краш-точкой
        this.roundCounter++;
        const crashPoint = computeCrashPoint(this.serverSeed, this.roundCounter);
        const roundHash = getRoundHash(this.serverSeed, this.roundCounter);

        this.currentRound = {
          roundId: this.roundCounter,
          serverSeed: this.serverSeed,
          crashPoint,
          roundHash,
          bets: new Map(), // userId -> bet (amount, cashoutMult, autoCashout)
          startTime: 0,
        };

        // Этап 2: фаза ставок (BETTING_DURATION секунд)
        this.state = 'betting';
        this.ws.broadcast({
          type: 'round_start',
          round_id: this.roundCounter,
          hash: roundHash,
          betting_duration: BETTING_DURATION,
        });

        await this._bettingCountdown();

        // Этап 3: фаза игры — множитель растёт до краш-точки
        this.state = 'running';
        this.currentRound.startTime = Date.now();
        this.ws.broadcast({
          type: 'game_start',
          round_id: this.roundCounter,
          players: this._getBetsSummary(),
        });

        await this._runMultiplier();

        // Этап 4: краш достигнут, обработка результатов
        this.state = 'crashed';
        this._processCrash();

        const seed = this.serverSeed;
        // Сохранить раунд в истории (для отправки новым клиентам)
        this.history.unshift({
          round_id: this.currentRound.roundId,
          crash_point: this.currentRound.crashPoint,
          hash: roundHash,
          seed,
          players: this.currentRound.bets.size,
        });
        if (this.history.length > 20) this.history.pop();

        // Отправить всем клиентам результат раунда с доказательством справедливости
        this.ws.broadcast({
          type: 'crashed',
          crash_point: this.currentRound.crashPoint,
          round_id: this.roundCounter,
          seed, // Открыть seed, чтобы клиент мог проверить краш-точку
          hash: roundHash,
          results: this._getResultsSummary(),
          history: this.history.slice(0, 15),
        });

        this._saveRound();

        // Генерировать новый seed для следующего раунда
        this.serverSeed = generateSeed();

        // Этап 5: пауза перед новым раундом
        await this._sleep(PAUSE_DURATION * 1000);
      } catch (err) {
        console.error('[CrashGame] Loop error:', err);
        await this._sleep(5000);
      }
    }
  }

  /**
   * Отсчёт времени на ставки (одна секунда за итерацию)
   */
  _bettingCountdown() {
    return new Promise((resolve) => {
      this._bettingStartTime = Date.now();
      let remaining = BETTING_DURATION;
      this._bettingTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(this._bettingTimer);
          this._bettingTimer = null;
          resolve();
        } else {
          this.ws.broadcast({ type: 'betting_tick', remaining });
        }
      }, 1000);
    });
  }

  /**
   * Запустить множитель: каждые TICK_INTERVAL мс отправить обновление
   */
  _runMultiplier() {
    return new Promise((resolve) => {
      const startTime = this.currentRound.startTime;

      this._tickTimer = setInterval(() => {
        const elapsed = (Date.now() - startTime) / 1000;
        const mult = this._calcMult(elapsed);

        // Обработать автокешауты игроков при достижении их лимита
        this._processAutoCashouts(mult);

        // Остановить, если достигнута краш-точка или лимит множителя
        if (mult >= this.currentRound.crashPoint || mult >= MAX_MULTIPLIER) {
          clearInterval(this._tickTimer);
          this._tickTimer = null;
          this.state = 'crashed'; // Немедленно блокировать cashout (защита от race condition)
          resolve();
          return;
        }

        this.ws.broadcast({
          type: 'tick',
          mult: Math.round(mult * 100) / 100,
          elapsed: Math.round(elapsed * 100) / 100,
        });
      }, TICK_INTERVAL);
    });
  }

  /**
   * Вычислить множитель от времени (квадратичная функция)
   * Формула: mult = 1 + t*0.1 + t²*0.012
   */
  _calcMult(elapsed) {
    return 1 + elapsed * 0.1 + elapsed * elapsed * 0.012;
  }

  /**
   * Обработчик подключения: отправить состояние игры и историю
   */
  _onConnect(userId, ws) {
    const msg = {
      type: 'state',
      round_id: this.currentRound ? this.currentRound.roundId : 0,
      state: this.state,
      history: this.history.slice(0, 15),
      online: this.ws.onlineCount,
    };

    if (this.currentRound) {
      msg.hash = this.currentRound.roundHash;
      msg.players = this._getBetsSummary();

      // Если раунд в процессе, отправить текущий множитель
      if (this.state === 'running') {
        const elapsed = (Date.now() - this.currentRound.startTime) / 1000;
        msg.mult = Math.round(this._calcMult(elapsed) * 100) / 100;
        msg.elapsed = Math.round(elapsed * 100) / 100;
      } else if (this.state === 'betting') {
        const elapsed = (Date.now() - this._bettingStartTime) / 1000;
        msg.betting_remaining = Math.max(0, BETTING_DURATION - elapsed);
      }
    }

    this.ws.sendTo(userId, msg);
    this.ws.broadcast({ type: 'online', count: this.ws.onlineCount });
  }

  /**
   * Обработчик отключения: уведомить остальных об изменении онлайна
   */
  _onDisconnect(userId, ws) {
    this.ws.broadcast({ type: 'online', count: this.ws.onlineCount });
  }

  /**
   * Маршрутизатор сообщений от клиента
   */
  _onMessage(userId, data, ws) {
    switch (data.type) {
      case 'place_bet':
        this._handleBet(userId, data);
        break;
      case 'cashout':
        this._handleCashout(userId);
        break;
      case 'chat':
        this._handleChat(userId, data);
        break;
    }
  }

  /**
   * Обработчик ставки: валидация, снятие средств, регистрация в раунде
   */
  _handleBet(userId, data) {
    // Проверка: ставки принимаются только в фазе betting
    if (this.state !== 'betting' || !this.currentRound) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Ставки закрыты' });
      return;
    }

    // Проверка: один пользователь — одна ставка за раунд
    if (this.currentRound.bets.has(userId)) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Ставка уже сделана' });
      return;
    }

    const amount = parseFloat(data.amount);
    if (!amount || amount <= 0 || amount > 10_000_000) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Некорректная ставка' });
      return;
    }

    // Проверки безопасности: бан и обслуживание
    if (db.isBanned(userId)) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Аккаунт заблокирован' });
      return;
    }

    if (db.getMaintenance() && !this.adminIds.includes(userId)) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Казино на обслуживании' });
      return;
    }

    // Выбрать кошелёк (основной или донат) — только разрешённые значения
    let wallet = data.wallet || 'main';
    if (!['main', 'donate'].includes(wallet)) wallet = 'main';
    const betAmount = wallet === 'donate' ? Math.floor(amount) : amount;

    const user = db.getUser(userId);
    if (!user) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Сначала запустите бота командой /start' });
      return;
    }

    // Снять средства с проверкой баланса (атомарная операция)
    let result;
    if (wallet === 'donate') {
      result = db.updateDonateBalanceChecked(userId, betAmount);
    } else {
      result = db.updateBalanceChecked(userId, -betAmount);
    }

    if (!result.success) {
      this.ws.sendTo(userId, { type: 'error', msg: 'Недостаточно средств' });
      return;
    }

    const username = user.first_name || user.username || 'Player';

    // Валидация автокешаута: должен быть в диапазоне [1.01, MAX_MULTIPLIER]
    let autoCashout = data.auto_cashout ? parseFloat(data.auto_cashout) : null;
    if (autoCashout !== null && (autoCashout < 1.01 || autoCashout > MAX_MULTIPLIER)) autoCashout = null;

    const bet = {
      userId,
      username,
      amount: betAmount,
      wallet,
      cashoutMult: null, // null = ещё не выведено, иначе множитель кешаута
      autoCashout,
    };

    this.currentRound.bets.set(userId, bet);

    // Подтвердить ставку игроку
    this.ws.sendTo(userId, {
      type: 'bet_confirmed',
      amount,
      balance: result.balance,
    });

    // Уведомить всех об новой ставке
    this.ws.broadcast({
      type: 'new_bet',
      user_id: userId,
      username,
      amount,
    });
  }

  /**
   * Обработчик ручного кешаута игрока
   */
  _handleCashout(userId) {
    if (this.state !== 'running' || !this.currentRound) return;

    const bet = this.currentRound.bets.get(userId);
    if (!bet || bet.cashoutMult !== null) return; // Уже выведено или нет такой ставки

    const elapsed = (Date.now() - this.currentRound.startTime) / 1000;
    const mult = this._calcMult(elapsed);

    // Не кешаутить, если краш уже произошёл
    if (mult >= this.currentRound.crashPoint) return;

    this._doCashout(bet, Math.round(mult * 100) / 100);
  }

  /**
   * Выполнить кешаут: зачислить выигрыш и уведомить
   */
  _doCashout(bet, mult) {
    bet.cashoutMult = mult;
    const winnings = Math.round(bet.amount * mult * 100) / 100;

    let newBalance;
    if (bet.wallet === 'donate') {
      const r = db.updateDonateBalance(bet.userId, Math.floor(winnings));
      newBalance = r ? r.donate_balance : 0;
    } else {
      const r = db.updateBalance(bet.userId, winnings);
      newBalance = r ? r.balance : 0;
    }

    // Уведомить игрока о кешауте
    this.ws.sendTo(bet.userId, {
      type: 'cashout_ok',
      mult,
      winnings,
      balance: newBalance,
      auto: bet.autoCashout ? true : undefined,
    });

    // Уведомить всех об кешауте (для чата и табло)
    this.ws.broadcast({
      type: 'player_cashout',
      user_id: bet.userId,
      username: bet.username,
      mult,
      winnings,
    });
  }

  /**
   * Обработать автокешауты: выведить ставки, достигшие своего лимита
   */
  _processAutoCashouts(currentMult) {
    if (!this.currentRound) return;
    for (const bet of this.currentRound.bets.values()) {
      // Проверить: ставка не выведена, есть лимит, множитель достигнут, краша ещё нет
      if (bet.cashoutMult === null && bet.autoCashout
          && currentMult >= bet.autoCashout
          && currentMult < this.currentRound.crashPoint) {
        this._doCashout(bet, Math.round(bet.autoCashout * 100) / 100);
      }
    }
  }

  /**
   * Записать результаты раунда в БД для каждого игрока
   */
  _processCrash() {
    if (!this.currentRound) return;
    for (const bet of this.currentRound.bets.values()) {
      if (bet.cashoutMult === null) {
        // Игрок не выведён — проиграл
        db.addGame(bet.userId, 'crash_mp', bet.amount, 'lose', 0, this.currentRound.crashPoint);
      } else {
        // Игрок выведён — выигрыш
        const winnings = Math.round(bet.amount * bet.cashoutMult * 100) / 100;
        db.addGame(bet.userId, 'crash_mp', bet.amount, 'win', winnings, bet.cashoutMult);
      }
    }
  }

  /**
   * Сохранить статистику раунда в таблицу crash_rounds
   */
  _saveRound() {
    if (!this.currentRound) return;
    let totalBets = 0;
    let totalWon = 0;
    for (const bet of this.currentRound.bets.values()) {
      totalBets += bet.amount;
      if (bet.cashoutMult) totalWon += bet.amount * bet.cashoutMult;
    }
    try {
      db.saveCrashRound(
        this.currentRound.roundId,
        this.currentRound.crashPoint,
        this.currentRound.roundHash,
        this.currentRound.serverSeed,
        this.currentRound.bets.size,
        totalBets,
        Math.round(totalWon * 100) / 100
      );
    } catch (err) {
      console.error('[CrashGame] Save round error:', err.message);
    }
  }

  /**
   * Обработчик сообщений чата
   */
  _handleChat(userId, data) {
    const text = String(data.text || '').slice(0, 200).trim();
    if (!text) return;
    const user = db.getUser(userId);
    const username = (user && (user.first_name || user.username)) || 'Player';
    this.ws.broadcast({
      type: 'chat',
      user_id: userId,
      username,
      text,
    });
  }

  /**
   * Получить список всех ставок в текущем раунде
   */
  _getBetsSummary() {
    if (!this.currentRound) return [];
    const result = [];
    for (const b of this.currentRound.bets.values()) {
      result.push({
        user_id: b.userId,
        username: b.username,
        amount: b.amount,
        cashout: b.cashoutMult,
      });
    }
    return result;
  }

  /**
   * Получить результаты раунда (для отправки при краше)
   */
  _getResultsSummary() {
    if (!this.currentRound) return [];
    const result = [];
    for (const b of this.currentRound.bets.values()) {
      const r = { username: b.username, amount: b.amount, won: b.cashoutMult !== null };
      if (b.cashoutMult) {
        r.mult = b.cashoutMult;
        r.winnings = Math.round(b.amount * b.cashoutMult * 100) / 100;
      }
      result.push(r);
    }
    return result;
  }

  /**
   * Вспомогательный таймер для async/await
   */
  _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

module.exports = CrashGame;
