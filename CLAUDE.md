# BFGKazinoApp — правила разработки

## Git workflow

1. **Каждое изменение = коммит** с подробным описанием на русском:
   - что именно изменено
   - зачем / какую проблему решает
   - пример: `feat(minesweeper): изменить поле с 5x5 на 6x6, убрать безопасный первый клик`

2. **Масштабные изменения — в отдельной ветке:**
   - Новая игра → `feature/game-<name>`
   - Редизайн → `feature/redesign-<описание>`
   - Рефакторинг → `refactor/<описание>`
   - Ветка мержится в `main` только после проверки
   - Пример: `git checkout -b feature/new-casino-game`

3. **Мелкие правки** (текст, цвет, баг-фикс) — напрямую в `main`

## Структура проекта

```
BFGKazinoApp/
├── app/
│   ├── index.html        # v1 — только Ракета (legacy)
│   └── v2/
│       └── index.html    # v2 — Ракета + Сапер (актуальная версия)
├── bot/
│   ├── main.py           # Telegram-бот (aiogram 3)
│   ├── database.py       # SQLite-слой
│   ├── config.py         # Настройки из .env
│   ├── .env              # Секреты (не коммитить!)
│   └── .env.example      # Шаблон переменных
└── requirements.txt
```

## Переменные окружения (bot/.env)

```
BOT_TOKEN=...
ADMIN_IDS=...
WEB_APP_URL=https://your-domain.com/app/v2/index.html
DB_PATH=casino.db
```

## Технологии

- **Бот:** Python 3.12, aiogram 3, SQLite
- **Web App:** HTML/CSS/JS (vanilla), Telegram Web App JS SDK
- **Деплой:** любой статик-хостинг для app/, VPS для бота
