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
