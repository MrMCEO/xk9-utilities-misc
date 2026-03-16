'use strict';

require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || '0')
  .split(',')
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !isNaN(n) && n > 0);

const DEFAULT_BALANCE = 1000000;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-domain.com/app/v2/index.html';
const DB_PATH = process.env.DB_PATH || 'casino.db';
const COINS_PER_STAR = parseInt(process.env.COINS_PER_STAR || '10', 10);
const PORT = parseInt(process.env.PORT || '8080', 10);
const BOT_API_URL = process.env.BOT_API_URL || '';

module.exports = {
  BOT_TOKEN,
  ADMIN_IDS,
  DEFAULT_BALANCE,
  WEB_APP_URL,
  DB_PATH,
  COINS_PER_STAR,
  PORT,
  BOT_API_URL,
};
