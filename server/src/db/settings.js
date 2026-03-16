'use strict';

const { getDb } = require('./connection');

/** Установить режим обслуживания */
function setMaintenance(enabled) {
  getDb().prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('maintenance', ?)`
  ).run(enabled ? '1' : '0');
}

/** Получить статус режима обслуживания */
function getMaintenance() {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key='maintenance'`).get();
  return row ? row.value === '1' : false;
}

/** Универсальная установка настройки */
function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

/** Получить настройку */
function getSetting(key, defaultValue = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : defaultValue;
}

module.exports = { setMaintenance, getMaintenance, setSetting, getSetting };
