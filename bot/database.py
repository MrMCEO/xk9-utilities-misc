import sqlite3
from typing import Optional, List, Dict, Any
from config import DB_PATH


def get_connection() -> sqlite3.Connection:
    """Получить соединение с БД"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """Инициализация базы данных"""
    conn = get_connection()
    cursor = conn.cursor()

    # Таблица пользователей
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            last_name TEXT,
            balance REAL DEFAULT 1000000,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Таблица игр
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

    # Индекс для быстрого поиска
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_games_telegram_id 
        ON games(telegram_id, created_at DESC)
    """)

    conn.commit()
    conn.close()


def close_db() -> None:
    """Закрытие БД (для SQLite не требуется)"""
    pass


# === Пользователи ===

def get_or_create_user(
    telegram_id: int,
    username: str = None,
    first_name: str = None,
    last_name: str = None
) -> Optional[Dict[str, Any]]:
    """Получить или создать пользователя"""
    from config import DEFAULT_BALANCE
    
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
    user = cursor.fetchone()

    if not user:
        cursor.execute(
            """INSERT INTO users (telegram_id, username, first_name, last_name, balance)
               VALUES (?, ?, ?, ?, ?)""",
            (telegram_id, username, first_name, last_name, DEFAULT_BALANCE)
        )
        conn.commit()
        cursor.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
        user = cursor.fetchone()
    else:
        # Обновляем данные
        cursor.execute(
            """UPDATE users
               SET username = ?, first_name = ?, last_name = ?, updated_at = CURRENT_TIMESTAMP
               WHERE telegram_id = ?""",
            (username, first_name, last_name, telegram_id)
        )
        conn.commit()

    conn.close()
    return dict(user) if user else None


def get_user(telegram_id: int) -> Optional[Dict[str, Any]]:
    """Получить пользователя по ID"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
    user = cursor.fetchone()

    conn.close()
    return dict(user) if user else None


def get_user_balance(telegram_id: int) -> float:
    """Получить баланс пользователя"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT balance FROM users WHERE telegram_id = ?", (telegram_id,))
    result = cursor.fetchone()

    conn.close()
    return result["balance"] if result else 0.0


def update_balance(telegram_id: int, amount: float) -> float:
    """
    Обновить баланс пользователя.
    amount > 0 - пополнение
    amount < 0 - списание
    """
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        "UPDATE users SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
        (amount, telegram_id)
    )
    conn.commit()

    cursor.execute("SELECT balance FROM users WHERE telegram_id = ?", (telegram_id,))
    result = cursor.fetchone()

    conn.close()
    return result["balance"] if result else 0.0


def set_balance(telegram_id: int, amount: float) -> float:
    """Установить баланс пользователя"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        "UPDATE users SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?",
        (amount, telegram_id)
    )
    conn.commit()

    cursor.execute("SELECT balance FROM users WHERE telegram_id = ?", (telegram_id,))
    result = cursor.fetchone()

    conn.close()
    return result["balance"] if result else 0.0


def get_all_users() -> List[Dict[str, Any]]:
    """Получить всех пользователей"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM users ORDER BY created_at DESC")
    users = cursor.fetchall()

    conn.close()
    return [dict(user) for user in users]


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
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        """INSERT INTO games (telegram_id, game_type, stake, result, winnings, multiplier) 
           VALUES (?, ?, ?, ?, ?, ?)""",
        (telegram_id, game_type, stake, result, winnings, multiplier)
    )
    
    game_id = cursor.lastrowid
    conn.commit()
    conn.close()
    
    return game_id


def get_user_games(telegram_id: int, limit: int = 15) -> List[Dict[str, Any]]:
    """Получить последние игры пользователя (для статистики)"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        """SELECT * FROM games 
           WHERE telegram_id = ? 
           ORDER BY created_at DESC 
           LIMIT ?""",
        (telegram_id, limit)
    )
    games = cursor.fetchall()

    conn.close()
    return [dict(game) for game in games]


def get_user_stats(telegram_id: int) -> Dict[str, Any]:
    """Получить статистику пользователя по играм"""
    conn = get_connection()
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
    conn.close()

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
    """Получить последние игры всех пользователей"""
    conn = get_connection()
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

    conn.close()
    return [dict(game) for game in games]


# === Очистка старых данных ===

def cleanup_old_games(days: int = 30) -> int:
    """Удалить игры старше указанного количества дней"""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute(
        """DELETE FROM games 
           WHERE created_at < datetime('now', ? || ' days')""",
        (f'-{days}',)
    )
    
    deleted = cursor.rowcount
    conn.commit()
    conn.close()
    
    return deleted
