/**
 * Тесты для мультиплеерного краш-сервера BFG Casino.
 *
 * Покрывает: provably-fair.js, db.js (in-memory SQLite), crash-game.js (_calcMult).
 * Запуск: node server/test.js
 */

const assert = require('assert');

// ─── Счётчики ───────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 1. provably-fair.js
// ═══════════════════════════════════════════════════════════════
console.log('\n─── provably-fair.js ───');

const { generateSeed, computeCrashPoint, getRoundHash, verifyRound } = require('./provably-fair');

test('generateSeed() возвращает строку длиной 64', () => {
  const seed = generateSeed();
  assert.strictEqual(typeof seed, 'string');
  assert.strictEqual(seed.length, 64);
});

test('generateSeed() возвращает hex-строку', () => {
  const seed = generateSeed();
  assert.ok(/^[0-9a-f]{64}$/.test(seed), `Seed не hex: ${seed}`);
});

test('generateSeed() генерирует уникальные значения', () => {
  const seeds = new Set(Array.from({ length: 20 }, () => generateSeed()));
  assert.strictEqual(seeds.size, 20, 'Не все 20 seed уникальны');
});

test('computeCrashPoint() возвращает число >= 1.0', () => {
  const seed = generateSeed();
  for (let i = 1; i <= 100; i++) {
    const cp = computeCrashPoint(seed, i);
    assert.ok(cp >= 1.0, `Round ${i}: crashPoint=${cp} < 1.0`);
  }
});

test('computeCrashPoint() возвращает число <= 1000', () => {
  const seed = generateSeed();
  for (let i = 1; i <= 500; i++) {
    const cp = computeCrashPoint(seed, i);
    assert.ok(cp <= 1000, `Round ${i}: crashPoint=${cp} > 1000`);
  }
});

test('computeCrashPoint() — мгновенный краш при val % 25 === 0', () => {
  // Перебираем пары seed/roundId пока не найдём мгновенный краш,
  // и проверяем, что результат === 1.0
  const crypto = require('crypto');
  let foundInstant = false;
  for (let r = 1; r <= 10000 && !foundInstant; r++) {
    const seed = 'a'.repeat(64); // фиксированный seed
    const h = crypto.createHmac('sha256', seed).update(String(r)).digest('hex');
    const val = parseInt(h.slice(0, 13), 16);
    if (val % 25 === 0) {
      const cp = computeCrashPoint(seed, r);
      assert.strictEqual(cp, 1.0, `Мгновенный краш ожидался 1.0, получили ${cp}`);
      foundInstant = true;
    }
  }
  assert.ok(foundInstant, 'Не нашли ни одного val % 25 === 0 за 10000 итераций');
});

test('computeCrashPoint() — детерминизм (одинаковые seed+roundId)', () => {
  const seed = generateSeed();
  const cp1 = computeCrashPoint(seed, 42);
  const cp2 = computeCrashPoint(seed, 42);
  assert.strictEqual(cp1, cp2);
});

test('computeCrashPoint() — разные seed/roundId дают разные crash points', () => {
  const seed1 = generateSeed();
  const seed2 = generateSeed();
  // Очень маловероятно, что совпадут
  const cp1 = computeCrashPoint(seed1, 1);
  const cp2 = computeCrashPoint(seed2, 1);
  const cp3 = computeCrashPoint(seed1, 2);
  // Хотя бы 2 из 3 должны различаться
  const unique = new Set([cp1, cp2, cp3]);
  assert.ok(unique.size >= 2, `Все crash points одинаковы: ${cp1}`);
});

test('getRoundHash() возвращает hex hash', () => {
  const seed = generateSeed();
  const hash = getRoundHash(seed, 1);
  assert.ok(/^[0-9a-f]{64}$/.test(hash), `Hash не hex64: ${hash}`);
});

test('verifyRound() — hash совпадает', () => {
  const seed = generateSeed();
  const roundId = 7;
  const hash = getRoundHash(seed, roundId);
  assert.strictEqual(verifyRound(seed, roundId, hash), true);
});

test('verifyRound() — неверный hash не совпадает', () => {
  const seed = generateSeed();
  assert.strictEqual(verifyRound(seed, 1, 'badhash'), false);
});

test('computeCrashPoint() — мгновенные краши (1.00) из 10000 раундов', () => {
  // val % 25 === 0 даёт ~4%, плюс формула (e/(e-val))*0.97 может дать значения
  // которые округляются до 1.00. Итого реальный процент ~7-8%.
  const seed = generateSeed();
  let instantCount = 0;
  const total = 10000;
  for (let i = 1; i <= total; i++) {
    if (computeCrashPoint(seed, i) === 1.0) instantCount++;
  }
  const pct = (instantCount / total) * 100;
  // Ожидаем ~7% ± 3% (учитывая оба источника instant crash)
  assert.ok(pct >= 4 && pct <= 10, `Мгновенных крашей ${pct.toFixed(1)}%, ожидалось ~7%`);
});

// ═══════════════════════════════════════════════════════════════
// 2. db.js (in-memory SQLite)
// ═══════════════════════════════════════════════════════════════
console.log('\n─── db.js ───');

// Устанавливаем in-memory путь ДО require('./db')
process.env.DB_PATH = ':memory:';

// Нужно сбросить кэш модуля, чтобы db.js заново проинициализировался
delete require.cache[require.resolve('./db')];
const db = require('./db');

// Создадим все нужные таблицы, которые обычно создаёт Python-бот
const Database = require('better-sqlite3');

// Получим доступ к внутреннему db-инстансу, вызвав initDb
// initDb создаёт crash_rounds. Нужно ещё users, games, settings.
{
  // initDb() внутри вызовет getDb(), который создаст in-memory db.
  // Но нам нужно добавить таблицы users, games, settings до тестов.
  db.initDb(); // crash_rounds создастся

  // Хак: вызовем getUser чтобы getDb() создал соединение, затем добавим таблицы
  // через тот же самый db-инстанс. Для этого обратимся к внутреннему getDb().
  // Но getDb не экспортируется. Попробуем через initDb() — exec на том же conn.
  // Проще: пропатчим через better-sqlite3 напрямую на :memory: — но это другой инстанс.
  // Решение: вызовем функции db которые используют getDb(), и словим ошибку, или
  // используем хак — require db.js экспортирует getDb косвенно через initDb.

  // Самый простой путь: считаем db модуль и пропатчим его, добавив exec через saveCrashRound.
  // На самом деле, getDb() уже вызван через initDb(). Давайте напрямую создадим таблицы
  // через тот же файл, monkey-patch:
}

// Для создания дополнительных таблиц получим db-инстанс через хак:
// Вызовем любую функцию и поймём что таблица users не существует.
// Вместо этого, модифицируем db.js — нет, лучше создадим таблицы вручную.

// Получим db connection через экспортированные функции. initDb уже вызвана.
// better-sqlite3 Database(':memory:') — будет ДРУГОЙ инстанс.
// Нужно добраться до того же инстанса. Используем хитрость:
// Запишем crash_round, значит connection работает. Теперь выполним raw SQL через saveCrashRound? Нет.

// Наиболее чистое решение: перепишем getDb чтобы он был доступен, но db.js его не экспортирует.
// Пойдём другим путём: добавим таблицы через _private или через require internals.

// Хак: лезем в кэш модуля и достаём приватную переменную db
const dbModule = require.cache[require.resolve('./db')];
// db — приватная переменная внутри модуля, недоступна. Но getDb() возвращает её.
// У нас нет доступа к getDb(). Однако initDb() уже создала соединение.
// Обходной путь: создадим таблицы через SQL в saveCrashRound... нет.

// Финальное решение: откроем ОТДЕЛЬНЫЙ инстанс better-sqlite3 на :memory: — НЕ СРАБОТАЕТ,
// т.к. :memory: у каждого нового Database(':memory:') — отдельная БД.

// Правильный подход: используем ФАЙЛОВУЮ временную БД.
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmpDbPath = path.join(os.tmpdir(), `bfg_test_${Date.now()}.db`);

// Переинициализируем db.js с файловой БД
process.env.DB_PATH = tmpDbPath;
delete require.cache[require.resolve('./db')];
const db2 = require('./db');

// Создадим все таблицы через отдельное подключение к тому же файлу
const setupConn = new Database(tmpDbPath);
setupConn.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    balance REAL DEFAULT 1000,
    donate_balance REAL DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER,
    game_type TEXT,
    stake REAL,
    result TEXT,
    winnings REAL,
    multiplier REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
setupConn.close();

// Теперь initDb создаст crash_rounds
db2.initDb();

test('initDb() создаёт таблицу crash_rounds без ошибок', () => {
  // Повторный вызов тоже не должен падать (IF NOT EXISTS)
  db2.initDb();
  assert.ok(true);
});

test('saveCrashRound() сохраняет раунд и он читается', () => {
  db2.saveCrashRound(1, 2.5, 'abc123', 'seed123', 3, 100, 50);
  // Прочитаем напрямую
  const conn = new Database(tmpDbPath);
  const row = conn.prepare('SELECT * FROM crash_rounds WHERE round_id = 1').get();
  conn.close();
  assert.ok(row, 'Раунд не найден в БД');
  assert.strictEqual(row.crash_point, 2.5);
  assert.strictEqual(row.round_hash, 'abc123');
  assert.strictEqual(row.server_seed, 'seed123');
  assert.strictEqual(row.players_count, 3);
  assert.strictEqual(row.total_bets, 100);
  assert.strictEqual(row.total_won, 50);
});

test('getUser() на несуществующем ID возвращает undefined', () => {
  const user = db2.getUser(999999);
  assert.strictEqual(user, undefined);
});

test('isBanned() на несуществующем ID возвращает false', () => {
  const banned = db2.isBanned(999999);
  assert.strictEqual(banned, false);
});

test('getMaintenance() по умолчанию возвращает false', () => {
  assert.strictEqual(db2.getMaintenance(), false);
});

test('getMaintenance() возвращает true когда включено', () => {
  const conn = new Database(tmpDbPath);
  conn.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('maintenance', '1')").run();
  conn.close();
  assert.strictEqual(db2.getMaintenance(), true);
  // Вернём обратно
  const conn2 = new Database(tmpDbPath);
  conn2.prepare("DELETE FROM settings WHERE key = 'maintenance'").run();
  conn2.close();
});

test('updateBalanceChecked() — баланс не уходит в минус', () => {
  // Создадим пользователя с балансом 100
  const conn = new Database(tmpDbPath);
  conn.prepare("INSERT INTO users (telegram_id, username, balance) VALUES (1001, 'tester', 100)").run();
  conn.close();

  // Попытка снять 200 — должна вернуть success: false
  const result = db2.updateBalanceChecked(1001, -200);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.balance, 100);

  // Попытка снять 50 — должна пройти
  const result2 = db2.updateBalanceChecked(1001, -50);
  assert.strictEqual(result2.success, true);
  assert.strictEqual(result2.balance, 50);
});

test('updateBalanceChecked() — можно довести до нуля', () => {
  const conn = new Database(tmpDbPath);
  conn.prepare("INSERT INTO users (telegram_id, username, balance) VALUES (1002, 'zero', 100)").run();
  conn.close();

  const result = db2.updateBalanceChecked(1002, -100);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.balance, 0);
});

test('addGame() — запись создаётся', () => {
  db2.addGame(1001, 'crash_mp', 50, 'win', 100, 2.0);
  const conn = new Database(tmpDbPath);
  const row = conn.prepare('SELECT * FROM games WHERE telegram_id = 1001').get();
  conn.close();
  assert.ok(row, 'Запись игры не найдена');
  assert.strictEqual(row.game_type, 'crash_mp');
  assert.strictEqual(row.stake, 50);
  assert.strictEqual(row.result, 'win');
  assert.strictEqual(row.winnings, 100);
  assert.strictEqual(row.multiplier, 2.0);
});

test('getUser() возвращает данные существующего пользователя', () => {
  const user = db2.getUser(1001);
  assert.ok(user, 'Пользователь не найден');
  assert.strictEqual(user.telegram_id, 1001);
  assert.strictEqual(user.username, 'tester');
});

test('isBanned() возвращает true для забаненного пользователя', () => {
  const conn = new Database(tmpDbPath);
  conn.prepare("INSERT INTO users (telegram_id, username, is_banned) VALUES (1003, 'banned', 1)").run();
  conn.close();
  assert.strictEqual(db2.isBanned(1003), true);
});

// ═══════════════════════════════════════════════════════════════
// 3. crash-game.js (unit-level — _calcMult)
// ═══════════════════════════════════════════════════════════════
console.log('\n─── crash-game.js (_calcMult) ───');

// CrashGame требует wsManager в конструкторе — создадим мок
const mockWs = {
  onConnect: null,
  onDisconnect: null,
  onMessage: null,
  onlineCount: 0,
  broadcast: () => {},
  sendTo: () => {},
};

// Нужно снова переимпортить crash-game с правильным db
// crash-game.js require('./db') — он получит db из кэша (наш tmpDbPath)
delete require.cache[require.resolve('./crash-game')];
const CrashGame = require('./crash-game');

const game = new CrashGame(mockWs, []);

test('_calcMult(0) === 1', () => {
  assert.strictEqual(game._calcMult(0), 1);
});

test('_calcMult(10) > 1 (формула 1 + t*0.1 + t^2*0.012)', () => {
  const m = game._calcMult(10);
  // 1 + 10*0.1 + 100*0.012 = 1 + 1 + 1.2 = 3.2
  assert.ok(m > 1, `_calcMult(10) = ${m}, expected > 1`);
  assert.ok(Math.abs(m - 3.2) < 0.001, `_calcMult(10) = ${m}, expected ~3.2`);
});

test('_calcMult(1) — проверка формулы', () => {
  const m = game._calcMult(1);
  // 1 + 0.1 + 0.012 = 1.112
  assert.ok(Math.abs(m - 1.112) < 0.001, `_calcMult(1) = ${m}, expected ~1.112`);
});

test('_calcMult монотонно растёт', () => {
  let prev = game._calcMult(0);
  for (let t = 0.5; t <= 50; t += 0.5) {
    const cur = game._calcMult(t);
    assert.ok(cur > prev, `_calcMult(${t})=${cur} <= _calcMult(${t - 0.5})=${prev}`);
    prev = cur;
  }
});

test('Crash point distribution: мгновенные краши из 1000 раундов', () => {
  const seed = generateSeed();
  let instant = 0;
  const total = 1000;
  for (let i = 1; i <= total; i++) {
    if (computeCrashPoint(seed, i) === 1.0) instant++;
  }
  const pct = (instant / total) * 100;
  // Реальный процент ~7% (val%25 + формула округляющаяся до 1.00), допуск ±4%
  assert.ok(pct >= 3 && pct <= 12,
    `Мгновенных крашей ${pct.toFixed(1)}% из ${total}, ожидалось ~7%`);
});

// ═══════════════════════════════════════════════════════════════
// Итоги
// ═══════════════════════════════════════════════════════════════

// Закрываем БД и удаляем временный файл
db2.close();
try { fs.unlinkSync(tmpDbPath); } catch (_) {}
try { fs.unlinkSync(tmpDbPath + '-wal'); } catch (_) {}
try { fs.unlinkSync(tmpDbPath + '-shm'); } catch (_) {}

console.log(`\n══════════════════════════════════`);
console.log(`  Результаты: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════`);

if (failures.length > 0) {
  console.log('\nПровалившиеся тесты:');
  for (const f of failures) {
    console.log(`\n  ✗ ${f.name}`);
    console.log(`    ${f.err.stack || f.err.message}`);
  }
  process.exit(1);
}

process.exit(0);
