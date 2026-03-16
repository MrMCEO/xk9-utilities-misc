'use strict';

const crypto = require('crypto');

const SESSION_TTL = 30 * 60 * 1000; // 30 минут

// Map<sessionId, sessionData>
const sessions = new Map();
// Map<`${userId}:${gameType}`, sessionId> — ограничение: 1 сессия на юзера на тип игры
const userGameIndex = new Map();

let _cleanupTimer = null;

function _startCleanup() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > SESSION_TTL) {
        sessions.delete(id);
        userGameIndex.delete(`${s.userId}:${s.gameType}`);
      }
    }
  }, 60 * 1000);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

/** Создать или заменить сессию для пользователя (старая помечается как проигрыш). */
function createSession(userId, gameType, data) {
  _startCleanup();
  const key = `${userId}:${gameType}`;
  const existingId = userGameIndex.get(key);
  if (existingId) {
    sessions.delete(existingId);
  }
  // Используем crypto для непредсказуемого sessionId
  const sessionId = crypto.randomBytes(16).toString('hex');
  sessions.set(sessionId, { ...data, userId, gameType, createdAt: Date.now() });
  userGameIndex.set(key, sessionId);
  return sessionId;
}

/** Получить сессию по ID */
function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/** Удалить сессию */
function deleteSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    userGameIndex.delete(`${s.userId}:${s.gameType}`);
    sessions.delete(sessionId);
  }
}

/** Найти активную сессию юзера по типу игры */
function getUserSession(userId, gameType) {
  const key = `${userId}:${gameType}`;
  const id = userGameIndex.get(key);
  if (!id) return null;
  return sessions.get(id) ? { sessionId: id, ...sessions.get(id) } : null;
}

/** Обновить данные сессии */
function updateSession(sessionId, data) {
  const existing = sessions.get(sessionId);
  if (!existing) return false;
  sessions.set(sessionId, { ...existing, ...data });
  return true;
}

module.exports = { createSession, getSession, deleteSession, getUserSession, updateSession };
