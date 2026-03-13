import sqlite3
from typing import Optional, List, Dict, Any, Tuple
from config import DB_PATH


def get_connection() -> sqlite3.Connection:
    """Получить соединение с БД (WAL-режим для лучшей производительности)"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-8000")  # 8MB кэш
    conn.execute("PRAGMA foreign_keys = ON")  # ON DELETE CASCADE и другие FK-ограничения
    return conn


def init_db() -> None:
    """Инициализация базы данных"""
    with get_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                telegram_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                last_name TEXT,
                balance REAL DEFAULT 1000000,
                donate_balance INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Добавить колонку donate_balance в существующие таблицы (идемпотентно)
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN donate_balance INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # Колонка уже существует

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER NOT NULL,
                game_type TEXT NOT NULL,
                stake REAL NOT NULL,
                result TEXT NOT NULL,
                winnings REAL DEFAULT 0,
                multiplier REAL DEFAULT 1.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE
            )
        """)

        # Индекс для быстрого поиска по пользователю и дате
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_games_telegram_id
            ON games(telegram_id, created_at DESC)
        """)

        # Индекс для фильтрации по типу игры
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_games_type
            ON games(game_type)
        """)

        # Таблица донатов (пополнений через Telegram Payments)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS donations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telegram_id INTEGER NOT NULL,
                telegram_payment_charge_id TEXT NOT NULL UNIQUE,
                provider_payment_charge_id TEXT,
                amount_rub INTEGER NOT NULL,
                coins_credited INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE
            )
        """)

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_donations_telegram_id
            ON donations(telegram_id, created_at DESC)
        """)

        # Добавить колонку is_banned в существующие таблицы (идемпотентно)
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0")
        except sqlite3.OperationalError:
            pass  # Колонка уже существует

        # Таблица промо-кодов
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS promo_codes (
                code TEXT PRIMARY KEY,
                bonus INTEGER NOT NULL,
                max_uses INTEGER NOT NULL,
                used_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Таблица использования промо-кодов (один код — один раз на пользователя)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS promo_uses (
                promo_code TEXT NOT NULL,
                telegram_id INTEGER NOT NULL,
                used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (promo_code, telegram_id),
                FOREIGN KEY (promo_code) REFERENCES promo_codes (code) ON DELETE CASCADE,
                FOREIGN KEY (telegram_id) REFERENCES users (telegram_id) ON DELETE CASCADE
            )
        """)

        # Таблица настроек (ключ-значение)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)


def close_db() -> None:
    """Закрытие БД (для SQLite не требуется, оставлено для совместимости)"""
    pass


# === Пользователи ===

def get_or_create_user(
    telegram_id: int,
    username: str = None,
    first_name: str = None,
    last_name: str = None
) -> Optional[Dict[str, Any]]:
    """Получить или создать пользователя (INSERT OR IGNORE + UPDATE, 2 запроса вместо 3)"""
    from config import DEFAULT_BALANCE

    with get_connection() as conn:
        cursor = conn.cursor()

        # Пытаемся создать — если уже есть, игнорируем
        cursor.execute(
            """INSERT OR IGNORE INTO users (telegram_id, username, first_name, last_name, balance)
               VALUES (?, ?, ?, ?, ?)""",
            (telegram_id, username, first_name, last_name, DEFAULT_BALANCE)
        )

        # Обновляем данные профиля (всегда актуальные)
        cursor.execute(
            """UPDATE users
               SET username = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?""",
            (username, first_name, last_name, telegram_id)
        )

        cursor.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
        user = cursor.fetchone()

    return dict(user) if user else None


def get_user(telegram_id: int) -> Optional[Dict[str, Any]]:
    """Получить пользователя по ID"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
        user = cursor.fetchone()
        return dict(user) if user else None


def get_user_balance(telegram_id: int) -> float:
    """Получить баланс пользователя"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT balance FROM users WHERE telegram_id = ?", (telegram_id,))
        result = cursor.fetchone()
        return result["balance"] if result else 0.0


def update_balance(telegram_id: int, amount: float) -> float:
    """
    Обновить баланс пользователя (один запрос через RETURNING).
    amount > 0 — пополнение, amount < 0 — списание.
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?
               RETURNING balance""",
            (amount, telegram_id)
        )
        result = cursor.fetchone()
    return result[0] if result else 0.0


def update_balance_checked(telegram_id: int, amount: float) -> tuple[bool, float]:
    """
    Атомарное изменение основного баланса с проверкой достаточности средств (для казино и Web App).

    Параметры:
    - telegram_id: ID пользователя
    - amount: изменение баланса (amount < 0 — списание, amount > 0 — пополнение)

    Возвращает: (success, new_balance)
    - success=True: операция выполнена, new_balance — новый баланс
    - success=False: недостаточно средств, баланс не изменился, new_balance — текущий баланс

    Это двухфазный коммит: UPDATE с WHERE условием гарантирует, что списание произойдёт только если
    баланс достаточен. Используется для защиты от овердрафта в cmd_casino и handle_webapp_data.
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ? AND balance + ? >= 0
               RETURNING balance""",
            (amount, telegram_id, amount)
        )
        result = cursor.fetchone()
        if result:
            return True, result[0]

        # Средств не хватило — возвращаем текущий баланс
        cursor.execute("SELECT balance FROM users WHERE telegram_id = ?", (telegram_id,))
        row = cursor.fetchone()
    return False, (row["balance"] if row else 0.0)


def set_balance(telegram_id: int, amount: float) -> float:
    """Установить баланс пользователя (один запрос через RETURNING)"""
    if amount < 0:
        raise ValueError(f"set_balance: отрицательный баланс недопустим (amount={amount})")
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?
               RETURNING balance""",
            (amount, telegram_id)
        )
        result = cursor.fetchone()
    return result[0] if result else 0.0


def get_all_users(limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
    """Получить всех пользователей с пагинацией"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset)
        )
        users = cursor.fetchall()
        return [dict(user) for user in users]


# === Донатный баланс ===

def get_donate_balance(telegram_id: int) -> int:
    """Получить донатный баланс пользователя (монеты за Telegram Stars)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT donate_balance FROM users WHERE telegram_id = ?", (telegram_id,))
        result = cursor.fetchone()
        return result["donate_balance"] if result else 0



def update_donate_balance(telegram_id: int, delta: int) -> int:
    """
    Изменить донатный баланс (delta > 0 — пополнение, delta < 0 — списание).
    Не проверяет достаточность средств. Возвращает новый баланс.
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE users SET donate_balance = donate_balance + ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?
               RETURNING donate_balance""",
            (delta, telegram_id)
        )
        result = cursor.fetchone()
    return result[0] if result else 0


def update_donate_balance_checked(telegram_id: int, amount: int) -> tuple[bool, int]:
    """
    Атомарное списание с донатного баланса с проверкой достаточности средств (для Web App).

    Параметры:
    - telegram_id: ID пользователя
    - amount: сумма для списания (положительное число, целое)

    Возвращает: (success, new_balance)
    - success=True: баланс хватил, деньги списаны, new_balance — новый донатный баланс
    - success=False: баланс не хватил, списания не было, new_balance — текущий баланс

    Используется в handle_webapp_data при wallet='donate'.
    """
    if amount <= 0:
        return False, get_donate_balance(telegram_id)

    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE users SET donate_balance = donate_balance - ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ? AND donate_balance >= ?
               RETURNING donate_balance""",
            (amount, telegram_id, amount)
        )
        result = cursor.fetchone()
        if result:
            return True, result[0]

        cursor.execute("SELECT donate_balance FROM users WHERE telegram_id = ?", (telegram_id,))
        row = cursor.fetchone()
    return False, (row["donate_balance"] if row else 0)


# === Игры ===

def add_game(
    telegram_id: int,
    game_type: str,
    stake: float,
    result: str,
    winnings: float = 0,
    multiplier: float = 1.0
) -> int:
    """
    Добавить запись об игре.
    result: 'win' или 'lose'
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO games (telegram_id, game_type, stake, result, winnings, multiplier)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (telegram_id, game_type, stake, result, winnings, multiplier)
        )
        game_id = cursor.lastrowid
    return game_id


def get_user_games(telegram_id: int, limit: int = 15) -> List[Dict[str, Any]]:
    """Получить последние игры пользователя (для статистики)"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT * FROM games
               WHERE telegram_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (telegram_id, limit)
        )
        games = cursor.fetchall()
    return [dict(game) for game in games]


def get_user_stats(telegram_id: int) -> Dict[str, Any]:
    """Получить статистику пользователя по играм"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                COUNT(*) as total_games,
                SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) as losses,
                SUM(stake) as total_staked,
                SUM(winnings) as total_winnings
            FROM games
            WHERE telegram_id = ?
        """, (telegram_id,))
        stats = cursor.fetchone()

    if stats and stats["total_games"] > 0:
        stats = dict(stats)
        stats["win_rate"] = (stats["wins"] / stats["total_games"]) * 100
        stats["profit"] = stats["total_winnings"] - stats["total_staked"]
    else:
        stats = {
            "total_games": 0,
            "wins": 0,
            "losses": 0,
            "total_staked": 0,
            "total_winnings": 0,
            "win_rate": 0,
            "profit": 0
        }

    return stats


def get_recent_games(limit: int = 10) -> List[Dict[str, Any]]:
    """
    Получить последние игры всех пользователей с информацией о игроке.
    Используется для администраторской статистики.
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT g.*, u.first_name, u.username
               FROM games g
               JOIN users u ON g.telegram_id = u.telegram_id
               ORDER BY g.created_at DESC
               LIMIT ?""",
            (limit,)
        )
        games = cursor.fetchall()
    return [dict(game) for game in games]


# === Донаты / пополнения ===

def add_donation(
    telegram_id: int,
    telegram_payment_charge_id: str,
    provider_payment_charge_id: str,
    amount_rub: int,
    coins_credited: int,
) -> int:
    """
    Записать успешное пополнение через Telegram Stars и зачислить монеты на donate_balance (одна транзакция).

    Логика:
    1. INSERT в таблицу donations (с UNIQUE constraint на telegram_payment_charge_id — защита от дублей)
    2. UPDATE donate_balance пользователя на сумму coins_credited
    3. RETURNING новый баланс

    При любой ошибке (включая UNIQUE constraint violation) — откатывает обе операции (ROLLBACK),
    чтобы монеты не потерялись и не было несогласованности в БД.

    Параметры:
    - telegram_id: ID пользователя
    - telegram_payment_charge_id: уникальный ID платежа от Telegram (защита от дублей)
    - provider_payment_charge_id: ID платежа у провайдера
    - amount_rub: количество звёзд (переиспользуем как 'сумма в звёздах')
    - coins_credited: количество игровых монет для зачисления

    Возвращает: новый донатный баланс пользователя

    Вызывается из handle_successful_payment (main.py) при успешном платеже через Telegram Stars.
    """
    conn = get_connection()
    cursor = conn.cursor()

    try:
        cursor.execute(
            """INSERT INTO donations
                   (telegram_id, telegram_payment_charge_id, provider_payment_charge_id, amount_rub, coins_credited)
               VALUES (?, ?, ?, ?, ?)""",
            (telegram_id, telegram_payment_charge_id, provider_payment_charge_id, amount_rub, coins_credited)
        )

        cursor.execute(
            """UPDATE users SET donate_balance = donate_balance + ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?
               RETURNING donate_balance""",
            (coins_credited, telegram_id)
        )
        new_donate_balance = cursor.fetchone()
        conn.commit()
        return new_donate_balance[0] if new_donate_balance else 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_user_donations(telegram_id: int, limit: int = 10) -> List[Dict[str, Any]]:
    """Получить историю пополнений пользователя"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """SELECT * FROM donations
               WHERE telegram_id = ?
               ORDER BY created_at DESC
               LIMIT ?""",
            (telegram_id, limit)
        )
        rows = cursor.fetchall()
    return [dict(row) for row in rows]


# === Очистка старых данных ===

def cleanup_old_games(days: int = 30) -> int:
    """Удалить игры старше указанного количества дней"""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """DELETE FROM games
               WHERE created_at < datetime('now', ? || ' days')""",
            (f'-{days}',)
        )
        deleted = cursor.rowcount
    return deleted


def get_global_stats() -> Dict[str, Any]:
    """Глобальная статистика для администраторов"""
    with get_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) FROM users")
        total_users = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM games")
        total_games = cursor.fetchone()[0]

        cursor.execute("""
            SELECT u.first_name, u.username, COUNT(g.id) as game_count
            FROM games g
            JOIN users u ON g.telegram_id = u.telegram_id
            GROUP BY g.telegram_id
            ORDER BY game_count DESC
            LIMIT 3
        """)
        top_players = [dict(row) for row in cursor.fetchall()]

        cursor.execute("SELECT COUNT(*), COALESCE(SUM(amount_rub), 0) FROM donations")
        row = cursor.fetchone()
        total_donations = row[0]
        total_stars = row[1]

    return {
        "total_users": total_users,
        "total_games": total_games,
        "top_players": top_players,
        "total_donations": total_donations,
        "total_stars": total_stars,
    }


def get_leaderboard() -> Dict[str, Any]:
    """
    Получить топ-5 игроков по двум категориям.

    Возвращает словарь с двумя списками:
    - top_balance: топ-5 по текущему балансу (отсортированы по балансу убыванию)
    - top_games: топ-5 по количеству сыгранных игр

    Каждый элемент списка содержит:
    - first_name: имя пользователя
    - username: ник в Telegram (может быть None)
    - balance: текущий баланс (только для top_balance)
    - game_count: количество игр (только для top_games)

    Используется для отображения рейтинга на главной странице Web App или в боте.
    """
    with get_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("""
            SELECT first_name, username, balance
            FROM users
            WHERE balance IS NOT NULL
            ORDER BY balance DESC
            LIMIT 5
        """)
        top_balance = [dict(row) for row in cursor.fetchall()]

        cursor.execute("""
            SELECT u.first_name, u.username, COUNT(g.id) as game_count
            FROM games g
            JOIN users u ON g.telegram_id = u.telegram_id
            GROUP BY g.telegram_id
            ORDER BY game_count DESC
            LIMIT 5
        """)
        top_games = [dict(row) for row in cursor.fetchall()]

    return {"top_balance": top_balance, "top_games": top_games}


# === Бан / разбан ===

def ban_user(telegram_id: int, is_banned: bool) -> bool:
    """Забанить или разбанить пользователя. Возвращает True если пользователь найден."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """UPDATE users SET is_banned = ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?""",
            (1 if is_banned else 0, telegram_id)
        )
        return cursor.rowcount > 0


def is_user_banned(telegram_id: int) -> bool:
    """Проверить, забанен ли пользователь."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT is_banned FROM users WHERE telegram_id = ?", (telegram_id,))
        row = cursor.fetchone()
        return bool(row["is_banned"]) if row else False


# === Админ-статистика ===

def get_admin_stats() -> Dict[str, Any]:
    """Агрегированная статистика для админ-панели."""
    with get_connection() as conn:
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) FROM users")
        total_users = cursor.fetchone()[0]

        cursor.execute("SELECT COUNT(*) FROM games")
        total_bets = cursor.fetchone()[0]

        cursor.execute("SELECT COALESCE(SUM(stake), 0) FROM games")
        total_wagered = cursor.fetchone()[0]

        cursor.execute("SELECT COALESCE(SUM(winnings), 0) FROM games")
        total_won = cursor.fetchone()[0]

        revenue = total_wagered - total_won

        # Статистика за сегодня
        cursor.execute(
            "SELECT COUNT(*) FROM users WHERE date(created_at) = date('now')"
        )
        new_users_today = cursor.fetchone()[0]

        cursor.execute(
            "SELECT COUNT(*) FROM games WHERE date(created_at) = date('now')"
        )
        bets_today = cursor.fetchone()[0]

        cursor.execute(
            "SELECT COALESCE(SUM(stake), 0) - COALESCE(SUM(winnings), 0) FROM games WHERE date(created_at) = date('now')"
        )
        revenue_today = cursor.fetchone()[0]

        # Ставки по типам игр
        cursor.execute("""
            SELECT game_type, COUNT(*) as cnt
            FROM games
            GROUP BY game_type
        """)
        bets_by_game = {row["game_type"]: row["cnt"] for row in cursor.fetchall()}

    return {
        "total_users": total_users,
        "total_bets": total_bets,
        "total_wagered": total_wagered,
        "total_won": total_won,
        "revenue": revenue,
        "new_users_today": new_users_today,
        "bets_today": bets_today,
        "revenue_today": revenue_today,
        "bets_by_game": bets_by_game,
    }


# === Промо-коды ===

def create_promo(code: str, bonus: int, max_uses: int) -> bool:
    """Создать промо-код. Возвращает True если создан, False если уже существует."""
    try:
        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO promo_codes (code, bonus, max_uses) VALUES (?, ?, ?)",
                (code.upper(), bonus, max_uses)
            )
        return True
    except sqlite3.IntegrityError:
        return False


def use_promo(telegram_id: int, code: str) -> Tuple[bool, str]:
    """
    Использовать промо-код.
    Возвращает (success, message).
    """
    code = code.upper()
    conn = get_connection()
    cursor = conn.cursor()

    try:
        # Проверяем существование промо-кода
        cursor.execute("SELECT * FROM promo_codes WHERE code = ?", (code,))
        promo = cursor.fetchone()
        if not promo:
            return False, "Промо-код не найден"

        # Проверяем лимит использований
        if promo["used_count"] >= promo["max_uses"]:
            return False, "Промо-код исчерпан"

        # Проверяем, использовал ли юзер раньше
        cursor.execute(
            "SELECT 1 FROM promo_uses WHERE promo_code = ? AND telegram_id = ?",
            (code, telegram_id)
        )
        if cursor.fetchone():
            return False, "Вы уже использовали этот промо-код"

        # Активируем промо-код
        cursor.execute(
            "INSERT INTO promo_uses (promo_code, telegram_id) VALUES (?, ?)",
            (code, telegram_id)
        )
        cursor.execute(
            "UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?",
            (code,)
        )
        cursor.execute(
            """UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?""",
            (promo["bonus"], telegram_id)
        )
        conn.commit()
        return True, f"Начислено {promo['bonus']:,} монет!"

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def get_promos() -> List[Dict[str, Any]]:
    """Получить список всех промо-кодов."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM promo_codes ORDER BY created_at DESC")
        return [dict(row) for row in cursor.fetchall()]


# === Настройки (режим обслуживания) ===

def set_maintenance(enabled: bool) -> None:
    """Установить или снять режим обслуживания."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('maintenance', ?)",
            ('1' if enabled else '0',)
        )


def get_maintenance() -> bool:
    """Получить флаг режима обслуживания."""
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = 'maintenance'")
        row = cursor.fetchone()
        return row["value"] == '1' if row else False


# === Поиск пользователя ===

def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    """Поиск пользователя по @username (без учёта регистра)."""
    username = username.lstrip('@')
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM users WHERE LOWER(username) = LOWER(?)",
            (username,)
        )
        user = cursor.fetchone()
        return dict(user) if user else None


# === История ставок (для админ-панели) ===

def get_bets_history(limit: int = 50, game_type: str = None) -> List[Dict[str, Any]]:
    """История ставок с JOIN на пользователей. Можно фильтровать по типу игры."""
    with get_connection() as conn:
        cursor = conn.cursor()
        if game_type:
            cursor.execute(
                """SELECT g.*, u.first_name, u.username
                   FROM games g
                   JOIN users u ON g.telegram_id = u.telegram_id
                   WHERE g.game_type = ?
                   ORDER BY g.created_at DESC
                   LIMIT ?""",
                (game_type, limit)
            )
        else:
            cursor.execute(
                """SELECT g.*, u.first_name, u.username
                   FROM games g
                   JOIN users u ON g.telegram_id = u.telegram_id
                   ORDER BY g.created_at DESC
                   LIMIT ?""",
                (limit,)
            )
        return [dict(row) for row in cursor.fetchall()]
