const crypto = require('crypto');

/**
 * Менеджер WebSocket-соединений с аутентификацией через Telegram initData
 */
class WsManager {
  /**
   * @param {string} botToken - Токен Telegram-бота для верификации initData
   */
  constructor(botToken) {
    this.botToken = botToken;
    this.connections = new Map(); // userId -> Set<ws> (несколько соединений на пользователя)
    this._all = new Set();       // Все WebSocket-соединения
    this._wsUser = new WeakMap(); // ws -> userId (обратное отображение)

    this.onConnect = null;
    this.onDisconnect = null;
    this.onMessage = null;
  }

  /**
   * Обработчик нового WebSocket-соединения с rate-limiting и верификацией initData
   */
  handleConnection(ws) {
    let userId = null;
    let authed = false;

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Rate-limit: счётчик сообщений в секунду
    ws.msgCount = 0;
    ws.msgResetTime = Date.now();

    const authTimeout = setTimeout(() => {
      if (!authed) ws.close(4001, 'Auth timeout');
    }, 10000);

    ws.on('message', (raw) => {
      // Rate-limit: максимум 20 сообщений в секунду
      const now = Date.now();
      if (now - ws.msgResetTime > 1000) {
        ws.msgCount = 0;
        ws.msgResetTime = now;
      }
      ws.msgCount++;
      if (ws.msgCount > 20) {
        ws.close(4029, 'Rate limited');
        return;
      }
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!authed) {
        if (data.type === 'auth') {
          // Верифицировать подпись initData через HMAC-SHA256
          const userInfo = this._verify(data.initData);
          if (!userInfo) {
            ws.close(4001, 'Unauthorized');
            return;
          }
          clearTimeout(authTimeout);
          authed = true;
          userId = userInfo.id;
          this._wsUser.set(ws, userId);
          this._register(userId, ws);
          if (this.onConnect) this.onConnect(userId, ws);
        }
        return;
      }

      // Принимать дальнейшие сообщения только после аутентификации
      if (this.onMessage) this.onMessage(userId, data, ws);
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (userId) {
        this._unregister(userId, ws);
        if (this.onDisconnect) this.onDisconnect(userId, ws);
      }
    });

    ws.on('error', () => {});
  }

  /**
   * Верифицировать initData от Telegram Web App
   * Проверяет HMAC подпись и свежесть auth_date (защита от replay-атак)
   */
  _verify(initData) {
    if (!initData) return null;
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (!hash) return null;
      params.delete('hash');

      // Отсортировать параметры и создать dataCheckString для HMAC
      const sorted = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');

      // Создать HMAC-SHA256 с ключом = HMAC(BOT_TOKEN, "WebAppData")
      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(this.botToken).digest();
      const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

      if (hmac !== hash) return null;

      // Защита от replay-атаки: auth_date не старше 24 часов
      const authDate = parseInt(params.get('auth_date'), 10);
      if (!authDate || (Date.now() / 1000 - authDate) > 86400) return null;

      return JSON.parse(params.get('user'));
    } catch {
      return null;
    }
  }

  /**
   * Зарегистрировать соединение в таблице (максимум 3 соединения на пользователя)
   */
  _register(userId, ws) {
    if (!this.connections.has(userId)) this.connections.set(userId, new Set());
    const set = this.connections.get(userId);
    // Защита: максимум 3 соединения на userId — закрыть самое старое
    if (set.size >= 3) {
      const oldest = set.values().next().value;
      oldest.close(4002, 'Too many connections');
      this._unregister(userId, oldest);
    }
    set.add(ws);
    this._all.add(ws);
  }

  /**
   * Отменить регистрацию соединения
   */
  _unregister(userId, ws) {
    this._all.delete(ws);
    const set = this.connections.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) this.connections.delete(userId);
    }
  }

  /**
   * Отправить сообщение ВСЕМ подключённым клиентам
   * Автоматически очищает мёртвые соединения
   */
  broadcast(msg) {
    const payload = JSON.stringify(msg);
    const dead = [];
    for (const ws of this._all) {
      try {
        if (ws.readyState === 1) ws.send(payload);
        else dead.push(ws);
      } catch {
        dead.push(ws);
      }
    }
    // Удалить мёртвые соединения
    for (const ws of dead) {
      const uid = this._wsUser.get(ws);
      if (uid) this._unregister(uid, ws);
    }
  }

  /**
   * Отправить сообщение конкретному пользователю (на все его соединения)
   */
  sendTo(userId, msg) {
    const conns = this.connections.get(userId);
    if (!conns) return;
    const payload = JSON.stringify(msg);
    for (const ws of conns) {
      try {
        if (ws.readyState === 1) ws.send(payload);
      } catch {}
    }
  }

  /**
   * Получить количество онлайн-пользователей
   */
  get onlineCount() {
    return this.connections.size;
  }

  /**
   * Запустить heartbeat: проверять живы ли соединения через ping/pong
   */
  startHeartbeat(interval = 30000) {
    this._heartbeat = setInterval(() => {
      for (const ws of this._all) {
        if (!ws.isAlive) {
          // Соединение не ответило на ping — закрыть
          const uid = this._wsUser.get(ws);
          if (uid) {
            this._unregister(uid, ws);
            if (this.onDisconnect) this.onDisconnect(uid, ws);
          }
          this._all.delete(ws);
          ws.terminate();
          continue;
        }
        // Отправить ping и ожидать pong
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }, interval);
  }

  /**
   * Остановить heartbeat
   */
  stopHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }
}

module.exports = WsManager;
