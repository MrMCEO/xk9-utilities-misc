'use strict';

const { getOrCreateUser } = require('../db/users');
const { ADMIN_IDS } = require('../config');

/**
 * Middleware регистрации пользователя.
 * При каждом сообщении создаёт или обновляет запись в БД.
 */
async function registrationMiddleware(ctx, next) {
  if (ctx.from) {
    ctx.dbUser = getOrCreateUser(
      ctx.from.id,
      ctx.from.username || null,
      ctx.from.first_name || null,
      ctx.from.last_name || null
    );
  }
  return next();
}

/**
 * Middleware проверки прав администратора.
 * Устанавливает ctx.isAdmin = true/false.
 */
async function adminCheckMiddleware(ctx, next) {
  ctx.isAdmin = ctx.from ? ADMIN_IDS.includes(ctx.from.id) : false;
  return next();
}

module.exports = { registrationMiddleware, adminCheckMiddleware };
