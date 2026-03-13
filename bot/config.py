import os
from dotenv import load_dotenv

load_dotenv()

# Токен бота от @BotFather
BOT_TOKEN = os.getenv("BOT_TOKEN", "")

# ID администраторов (через запятую)
ADMIN_IDS = list(map(int, os.getenv("ADMIN_IDS", "0").split(",")))

# Стартовый баланс для новых пользователей
DEFAULT_BALANCE = 1000000

# URL Web App
WEB_APP_URL = os.getenv("WEB_APP_URL", "https://your-domain.com/app/index.html")

# Путь к базе данных SQLite
DB_PATH = os.getenv("DB_PATH", "casino.db")

# Курс конвертации: 1 звезда Telegram = N игровых монет
COINS_PER_STAR = int(os.getenv("COINS_PER_STAR", "10"))

# Публичный URL этого бота (для HTTP API, который принимает результаты игр из Web App)
# Пример: http://123.45.67.89:8080 или https://yourdomain.com
BOT_API_URL = os.getenv("BOT_API_URL", "")
BOT_API_PORT = int(os.getenv("BOT_API_PORT", "8080"))
