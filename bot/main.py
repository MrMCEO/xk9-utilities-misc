import logging
import json
import random
import html
import asyncio
import base64
import hmac
import hashlib
import time
import urllib.parse
from aiohttp import web as aio_web
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandObject, StateFilter
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import (
    Message,
    CallbackQuery,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
    WebAppInfo,
    MenuButtonWebApp,
    LabeledPrice,
    PreCheckoutQuery,
)
from aiogram.client.default import DefaultBotProperties
from aiogram.types import ReplyKeyboardMarkup, KeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder, ReplyKeyboardBuilder
from config import BOT_TOKEN, ADMIN_IDS, DEFAULT_BALANCE, WEB_APP_URL, DB_PATH, COINS_PER_STAR, BOT_API_URL, BOT_API_PORT
from database import (
    init_db,
    get_or_create_user,
    get_user,
    get_user_balance,
    update_balance,
    update_balance_checked,
    set_balance,
    add_game,
    get_user_games,
    get_user_stats,
    get_all_users,
    get_recent_games,
    add_donation,
    get_user_donations,
    get_donate_balance,
    update_donate_balance,
    update_donate_balance_checked,
    get_global_stats,
    get_leaderboard,
    ban_user,
    is_user_banned,
    get_admin_stats,
    create_promo,
    use_promo,
    get_promos,
    set_maintenance,
    get_maintenance,
    get_user_by_username,
    get_bets_history,
    get_activity_24h,
)

# Настройка логирования
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Инициализация бота и диспетчера
bot = Bot(token=BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
dp = Dispatcher()


# === FSM состояния ===

class DonateStates(StatesGroup):
    waiting_for_custom_amount = State()


# FSM состояния для многошаговых админ-операций:
# - управление балансом: ID пользователя → новая сумма баланса
# - рассылка: текст сообщения
# - создание промо: код → бонус → макс. использования
class AdminStates(StatesGroup):
    waiting_for_user_id = State()        # ввод ID/username для изменения баланса
    waiting_for_amount = State()         # ввод суммы баланса
    waiting_for_broadcast_text = State() # ввод текста рассылки
    waiting_for_promo_code = State()     # ввод кода промо
    waiting_for_promo_bonus = State()    # ввод бонуса промо
    waiting_for_promo_max_uses = State() # ввод макс. использований промо

# Инициализация БД при старте
init_db()


# === Вспомогательные функции ===

def fmt_name(user: dict) -> str:
    """
    Экранировать имя пользователя для безопасного использования в HTML-сообщениях.

    Использует html.escape() для защиты от XSS-атак: если имя содержит <, >, &, ", '
    символы, они будут заменены на HTML-сущности (&lt;, &gt;, и т.д.).
    Применяется при выводе названий пользователей в админ-панели и статистике.
    """
    return html.escape(user.get("first_name") or user.get("username") or "Unknown")


async def send_donate_invoice(target: Message, user_id: int, amount_stars: int) -> None:
    """
    Отправить инвойс Telegram Stars для пополнения баланса.

    Параметры:
    - target (Message): объект сообщения, куда отправить инвойс
    - user_id (int): Telegram ID пользователя (для вставки в payload)
    - amount_stars (int): количество звёзд для покупки (будет конвертировано в монеты)

    Логика:
    1. Конвертируем звёзды в монеты: coins = amount_stars * COINS_PER_STAR
    2. Создаём инвойс с payload="donate_<stars>_<user_id>" (для валидации при платеже)
    3. Telegram Bot API обрабатывает инвойс и показывает форму оплаты пользователю
    4. При успехе отправляется successful_payment обработчику handle_successful_payment

    Используется в cb_donate_amount и handle_custom_amount.
    """
    coins = amount_stars * COINS_PER_STAR
    await target.answer_invoice(
        title="Пополнение BFG Casino",
        description=f"Зачислит {coins:,} монет на ваш игровой баланс",
        payload=f"donate_{amount_stars}_{user_id}",
        provider_token="",
        currency="XTR",
        prices=[LabeledPrice(label=f"{coins:,} монет", amount=amount_stars)],
        start_parameter="donate",
    )


# === HTTP API для Web App ===

INIT_DATA_MAX_AGE = 300  # секунд (5 минут) — защита от replay-атак

def verify_init_data(init_data: str) -> dict | None:
    """Верифицирует Telegram initData через HMAC-SHA256. Возвращает dict с user или None.

    Алгоритм:
    1. Распарсивает initData (query-string: hash, auth_date, user, ...)
    2. Вычисляет HMAC-SHA256 на основе всех параметров кроме hash:
       - Ключ 1: HMAC(BOT_TOKEN, 'WebAppData') -> secret_key
       - Ключ 2: HMAC(secret_key, sorted(params))
    3. Сравнивает полученный хеш с переданным (constant-time)
    4. Проверяет auth_date не старше INIT_DATA_MAX_AGE (защита от replay-атак)
    5. Возвращает распарсиванный user JSON или None если любая проверка не пройдена
    """
    try:
        if not init_data:
            return None
        params = dict(p.split('=', 1) for p in init_data.split('&') if '=' in p)
        hash_value = params.pop('hash', '')
        if not hash_value:
            return None
        data_check_string = '\n'.join(f'{k}={v}' for k, v in sorted(params.items()))
        secret_key = hmac.new(b'WebAppData', BOT_TOKEN.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(hash_value, expected):
            return None
        # Проверка auth_date — защита от replay-атак (initData старше 5 минут отклоняется)
        auth_date = int(params.get('auth_date', '0'))
        if abs(time.time() - auth_date) > INIT_DATA_MAX_AGE:
            logger.warning(f"initData expired: auth_date={auth_date}, now={int(time.time())}")
            return None
        user_json = urllib.parse.unquote(params.get('user', '{}'))
        return json.loads(user_json)
    except Exception:
        return None


async def process_game_result(telegram_id: int, data: dict) -> dict:
    """Обрабатывает результат игры из Web App. Возвращает {'ok': bool, 'balance': int, 'error': str}.

    Шаги обработки:
    1. Проверить статусы (забанен ли, режим обслуживания)
    2. Парсить game_type (rocket/minesweeper), stake, multiplier, won
    3. Валидировать все параметры на диапазоны (MIN_STAKE <= stake <= MAX_STAKE, и т.д.)
    4. Определить кошелёк (main или donate)
    5. Снять ставку со счёта (с проверкой sufficient_funds)
    6. Если выиграл: начислить winnings = stake * multiplier
    7. Записать результат в историю игр (add_game)
    8. Вернуть финальный баланс
    """
    if is_user_banned(telegram_id):
        return {'ok': False, 'error': 'banned'}
    if get_maintenance() and telegram_id not in ADMIN_IDS:
        return {'ok': False, 'error': 'maintenance'}

    game_type = data.get('game', 'rocket')
    if game_type not in VALID_GAME_TYPES:
        game_type = 'rocket'

    try:
        stake = float(data.get('stake', 0))
        multiplier = float(data.get('multiplier', 1.0))
    except (TypeError, ValueError):
        return {'ok': False, 'error': 'invalid_params'}

    won = bool(data.get('won', False))

    if stake <= 0 or stake > MAX_STAKE:
        return {'ok': False, 'error': 'invalid_stake'}
    if multiplier <= 0 or multiplier > MAX_MULTIPLIER:
        return {'ok': False, 'error': 'invalid_multiplier'}

    wallet = data.get('wallet', 'main')
    use_donate = wallet == 'donate'

    if use_donate:
        success, balance_after = update_donate_balance_checked(telegram_id, int(stake))
    else:
        success, balance_after = update_balance_checked(telegram_id, -stake)

    if not success:
        return {'ok': False, 'error': 'insufficient_funds', 'balance': balance_after}

    winnings = round(stake * multiplier, 2) if won else 0.0
    if winnings > 0:
        if use_donate:
            update_donate_balance(telegram_id, int(winnings))
            balance_after = int(balance_after + winnings)
        else:
            update_balance(telegram_id, winnings)
            balance_after = int(balance_after + winnings)

    add_game(
        telegram_id=telegram_id,
        game_type=game_type,
        stake=stake,
        result='win' if won else 'lose',
        winnings=winnings,
        multiplier=multiplier
    )

    return {'ok': True, 'balance': int(balance_after)}


def _get_cors_origin() -> str:
    """Вычисляет допустимый CORS origin из WEB_APP_URL. Если не задан — fallback на *."""
    if WEB_APP_URL and WEB_APP_URL != "https://your-domain.com/app/index.html":
        from urllib.parse import urlparse
        parsed = urlparse(WEB_APP_URL)
        return f"{parsed.scheme}://{parsed.netloc}"
    return '*'

_CORS_HEADERS = {
    'Access-Control-Allow-Origin': _get_cors_origin(),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
}


async def handle_game_api(request: aio_web.Request) -> aio_web.Response:
    """POST /api/game — HTTP endpoint для передачи результата игры из Web App.

    Запрос должен содержать:
    - initData (Telegram WebApp init data, подписанный ключом бота)
    - game, stake, multiplier, won, wallet

    Обработка:
    1. Если OPTIONS — вернуть CORS-заголовки (preflight)
    2. Парсить JSON body
    3. Верифицировать initData (HMAC-SHA256), прерваться если некорректно
    4. Вызвать process_game_result с распарсиванным user_id и игровыми данными
    5. Вернуть результат (200 если успех, 400 если игровая ошибка, 500 если краш сервера)
    6. Все ответы — JSON с CORS-заголовками

    Ответ: {'ok': bool, 'balance': int, 'error': str}
    """
    if request.method == 'OPTIONS':
        return aio_web.Response(headers=_CORS_HEADERS)
    try:
        body = await request.json()
        user_info = verify_init_data(body.get('initData', ''))
        if not user_info:
            return aio_web.json_response({'ok': False, 'error': 'unauthorized'}, status=401, headers=_CORS_HEADERS)

        result = await process_game_result(user_info['id'], body)
        status = 200 if result['ok'] else 400
        return aio_web.json_response(result, status=status, headers=_CORS_HEADERS)
    except Exception as e:
        logger.error(f"Game API error: {e}")
        return aio_web.json_response({'ok': False, 'error': 'internal'}, status=500, headers=_CORS_HEADERS)


async def start_api_server() -> None:
    """Запустить aiohttp HTTP сервер для приёма результатов игр из Web App.

    Запускается только если BOT_API_URL и BOT_API_PORT определены в .env.
    Иначе выход (функция не нужна на VPS без туннеля/доменного имени).

    Создает рут:
    - POST /api/game (с CORS preflight на OPTIONS)
    """
    if not BOT_API_URL:
        return
    app = aio_web.Application()
    app.router.add_route('POST', '/api/game', handle_game_api)
    app.router.add_route('OPTIONS', '/api/game', handle_game_api)
    runner = aio_web.AppRunner(app)
    await runner.setup()
    site = aio_web.TCPSite(runner, '0.0.0.0', BOT_API_PORT)
    await site.start()
    logger.info(f"🌐 Game API запущен на порту {BOT_API_PORT}")


# === Клавиатуры ===

def _build_admin_data() -> str:
    """
    Собрать данные для админ-панели фронтенда и закодировать в base64.

    Возвращает JSON-словарь (в base64):
    - users: количество пользователей
    - bets_today: ставок сегодня
    - revenue_today: доход казино за день
    - active_promos: количество активных промо-кодов
    - activity_24h: массив ставок по часам [24h ago, ..., now]
    - promo_codes: список всех кодов (code, bonus, max_uses, used_count)
    - recent_bets: 10 последних ставок с игроком, игрой, ставкой и множителем
    - maintenance: включен ли режим обслуживания

    Используется в get_main_keyboard для передачи данных в Web App (параметр admindata).
    """
    stats = get_admin_stats()
    promos = get_promos()
    recent = get_bets_history(limit=20)
    maint = get_maintenance()

    admin_data = {
        "users": stats["total_users"],
        "bets_today": stats["bets_today"],
        "revenue_today": stats["revenue_today"],
        "active_promos": sum(1 for p in promos if p["used_count"] < p["max_uses"]),
        "activity_24h": get_activity_24h(),
        "promo_codes": [
            {"code": p["code"], "bonus": p["bonus"], "max_uses": p["max_uses"], "used_count": p["used_count"]}
            for p in promos
        ],
        "recent_bets": [
            {
                "player": r.get("first_name") or r.get("username") or "Unknown",
                "game": r["game_type"],
                "stake": r["stake"],
                "won": r["result"] == "win",
                "multiplier": r.get("multiplier", 1.0),
            }
            for r in recent[:10]
        ],
        "maintenance": maint,
    }
    return base64.b64encode(json.dumps(admin_data, ensure_ascii=False).encode()).decode()


def get_main_keyboard(balance: float = 0, donate_balance: int = 0, is_admin: bool = False) -> ReplyKeyboardMarkup:
    """Основная клавиатура с кнопкой Web App"""
    builder = ReplyKeyboardBuilder()
    url = f"{WEB_APP_URL}?b={balance}&db={donate_balance}"
    if BOT_API_URL:
        url += f"&api={BOT_API_URL}"
    if is_admin:
        url += "&admin=1"
        # admindata не передаём — URL слишком длинный для кнопки (лимит 512 символов)
    builder.button(text="🎮 Запустить приложение", web_app=WebAppInfo(url=url))
    builder.button(text="🎰 Казино")
    builder.button(text="📊 Моя статистика")
    builder.button(text="💰 Баланс")
    builder.button(text="📜 История игр")
    builder.button(text="💳 Пополнить")
    builder.button(text="❓ Помощь")
    builder.adjust(1, 2, 2, 2)
    return builder.as_markup(resize_keyboard=True)


def get_admin_keyboard() -> InlineKeyboardMarkup:
    """Админ панель"""
    builder = InlineKeyboardBuilder()
    builder.button(text="📊 Статистика", callback_data="admin_stats")
    builder.button(text="👥 Пользователи", callback_data="admin_users")
    builder.button(text="💰 Управление балансом", callback_data="admin_balance")
    builder.button(text="📢 Рассылка", callback_data="admin_broadcast")
    builder.button(text="🎁 Промо-коды", callback_data="admin_promos")
    builder.button(text="🔧 Режим обслуживания", callback_data="admin_maintenance")
    builder.button(text="🏆 Топ игроков", callback_data="admin_top")
    builder.adjust(2, 2, 2, 1)
    return builder.as_markup()


# === Команды ===

@dp.message(Command("start"))
async def cmd_start(message: Message, command: CommandObject):
    """
    Команда /start - приветствие и авторизация.

    Логика:
    - Создаём пользователя в БД (если его ещё нет)
    - Поддерживаем deep link /start donate — показываем меню пополнения
    - Иначе показываем основное меню с кнопкой Web App
    """
    user = get_or_create_user(
        telegram_id=message.from_user.id,
        username=message.from_user.username,
        first_name=message.from_user.first_name,
        last_name=message.from_user.last_name
    )

    # Обработка deep link /start donate
    if command.args == "donate":
        await message.answer(
            "⭐ <b>Пополнение баланса</b>\n\n"
            f"1 звезда = {COINS_PER_STAR:,} монет\n\n"
            "Выберите сумму пополнения:",
            reply_markup=get_donate_keyboard(),
            parse_mode='HTML'
        )
        return

    donate_bal = get_donate_balance(message.from_user.id)
    is_admin = message.from_user.id in ADMIN_IDS

    # Устанавливаем персональную кнопку меню (нижняя кнопка Telegram) с уникальным URL,
    # содержащим текущий баланс пользователя (query-параметры b и db)
    menu_url = f"{WEB_APP_URL}?b={user['balance']}&db={donate_bal}"
    if BOT_API_URL:
        menu_url += f"&api={BOT_API_URL}"
    if is_admin:
        menu_url += "&admin=1"
        # admindata не передаём — URL слишком длинный для menu button (лимит 512 символов)
    try:
        await bot.set_chat_menu_button(
            chat_id=message.from_user.id,
            menu_button=MenuButtonWebApp(
                text="🎮 Играть",
                web_app=WebAppInfo(url=menu_url)
            )
        )
    except Exception:
        pass
    await message.answer(
        f"🎰 <b>Добро пожаловать в BFG Casino!</b>\n\n"
        f"👤 {html.escape(message.from_user.first_name or '')}, ваш баланс: <b>${user['balance']:,.2f}</b>\n\n"
        f"🚀 Запускайте игру и испытайте удачу!\n"
        f"Нажмите кнопку ниже 👇",
        reply_markup=get_main_keyboard(user['balance'], donate_bal, is_admin=is_admin),
    )


@dp.message(Command("play"))
@dp.message(Command("game"))
async def cmd_play(message: Message):
    """Команда /play - открыть игру"""
    u = get_user(message.from_user.id) or {}
    play_url = f"{WEB_APP_URL}?b={u.get('balance', 0)}&db={u.get('donate_balance', 0)}"
    if BOT_API_URL:
        play_url += f"&api={BOT_API_URL}"
    if message.from_user.id in ADMIN_IDS:
        play_url += "&admin=1"
        # admindata не передаём — URL слишком длинный для inline кнопки (лимит 512 символов)
    await message.answer(
        "🎮 <b>BFG Casino — Web App</b>\n\n"
        "🚀 Ракета · 💣 Сапер\n"
        "Выбирай игру и испытай удачу!",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🎮 Открыть приложение", web_app=WebAppInfo(url=play_url))]
        ])
    )


@dp.message(Command("help"))
@dp.message(F.text == "❓ Помощь")
async def cmd_help(message: Message):
    """Команда /help - справка"""
    help_text = (
        "📖 <b>Справка по BFG Casino</b>\n\n"
        "🎮 <b>Игры в приложении:</b>\n"
        "🚀 <b>Ракета</b> — забирай выигрыш до краша, множитель растёт\n"
        "💣 <b>Сапер</b> — открывай ячейки, избегай мин, множитель растёт\n"
        "🎰 <b>Казино</b> — быстрая игра прямо в боте\n\n"
        "💰 <b>Команды:</b>\n"
        "/start - Запустить бота\n"
        "/play - Открыть игровое приложение\n"
        "/casino - Игра в казино (<ставка>)\n"
        "/balance - Проверить баланс\n"
        "/history - История игр\n"
        "/donate - Пополнить баланс\n"
        "/promo - Активировать промо-код\n"
        "/help - Эта справка\n\n"
        "🔧 <b>Админ:</b>\n"
        "/admin - Панель администратора\n"
        "/stats - Статистика казино\n"
        "/setbalance - Изменить баланс"
    )
    await message.answer(help_text)


@dp.message(F.text == "💰 Баланс")
@dp.message(Command("balance"))
async def cmd_balance(message: Message):
    """Показать баланс"""
    uid = message.from_user.id
    balance = get_user_balance(uid)
    donate_balance = get_donate_balance(uid)
    await message.answer(
        f"💰 <b>Ваш баланс:</b>\n\n"
        f"💰 Основной баланс: <b>{balance:,.0f} монет</b>\n"
        f"⭐ Донатный баланс: <b>{donate_balance:,} монет</b>",
        parse_mode='HTML'
    )


@dp.message(F.text == "📊 Моя статистика")
async def cmd_stats(message: Message):
    """Показать статистику пользователя"""
    stats = get_user_stats(message.from_user.id)

    if stats['total_games'] == 0:
        await message.answer("📊 У вас пока нет игр. Испытайте удачу! 🎮")
        return

    stats_text = (
        f"📊 <b>Ваша статистика:</b>\n\n"
        f"🎮 Игр сыграно: <b>{stats['total_games']}</b>\n"
        f"✅ Побед: <b>{stats['wins']}</b>\n"
        f"❌ Поражений: <b>{stats['losses']}</b>\n"
        f"📈 Win Rate: <b>{stats['win_rate']:.1f}%</b>\n\n" 
        f"💵 Всего поставлено: <b>${stats['total_staked']:,.2f}</b>\n"
        f"💰 Всего выиграно: <b>${stats['total_winnings']:,.2f}</b>\n"
        f"{'🟢' if stats['profit'] >= 0 else '🔴'} Профит: <b>${stats['profit']:,.2f}</b>"
    )

    await message.answer(stats_text)


@dp.message(F.text == "📜 История игр")
async def cmd_history(message: Message):
    """Показать историю игр"""
    games = get_user_games(message.from_user.id, limit=15)

    if not games:
        await message.answer("📜 У вас пока нет игр в истории.")
        return

    history_text = "📜 <b>Последние игры:</b>\n\n"
    for i, game in enumerate(games, 1):
        emoji = "✅" if game['result'] == 'win' else "❌"
        history_text += (
            f"{i}. {emoji} <b>{game['game_type']}</b> | "
            f"Ставка: ${game['stake']:.2f} | "
            f"Выигрыш: ${game['winnings']:.2f}\n"
        )

    await message.answer(history_text)


# === Обработка данных от Web App ===

MAX_MULTIPLIER = 1000.0  # Максимально допустимый множитель от Web App (защита от экстремальных значений через DevTools)
MAX_STAKE = 10_000_000  # Максимально допустимая ставка (защита от переполнения баланса при списании)
VALID_GAME_TYPES = {'rocket', 'minesweeper', 'ladder'}  # Допустимые типы игр из Web App (валидация в handle_webapp_data)


@dp.message(F.web_app_data)
async def handle_webapp_data(message: Message):
    """
    Обработка результатов игр из Web App (Ракета, Сапер).

    Архитектура (безопасность от манипуляций клиентом):
    1. Парсим JSON от клиента: stake, multiplier, wallet, won
    2. Валидируем:
       - stake > 0 (положительная ставка)
       - 0 <= multiplier <= MAX_MULTIPLIER (1000) — защита от экстремально больших множителей
       - won — булево значение (результат игры)
    3. Атомарно проверяем баланс и списываем ставку одной DB-операцией:
       - update_balance_checked() для основного баланса
       - update_donate_balance_checked() для донатного баланса
       - Если баланса не хватит — операция откатится, ставка не будет снята
    4. Пересчитываем выигрыш на СЕРВЕРЕ (не доверяем клиенту):
       - winnings = stake * multiplier, если won=true; иначе 0
       - Клиент может подделать выигрыш через DevTools, но мы заново вычисляем
    5. Начисляем выигрыш НА ТОТ ЖЕ кошелёк, с которого была снята ставка:
       - wallet='main' → update_balance(telegram_id, winnings)
       - wallet='donate' → update_donate_balance(telegram_id, int(winnings))
    6. Логируем результат в таблицу games для статистики и аудита

    Кошельки (wallet parameter):
    - 'main': основной баланс (в монетах, из игры)
    - 'donate': донатный баланс (из Telegram Stars)

    Примечание: Используются целочисленные преобразования для donate_balance, так как он хранит
    целые монеты, в отличие от основного баланса (float).
    """
    try:
        telegram_id = message.from_user.id

        # Проверка бана
        if is_user_banned(telegram_id):
            await message.answer("🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.")
            return

        # Проверка режима обслуживания (админы могут играть)
        if get_maintenance() and telegram_id not in ADMIN_IDS:
            await message.answer("🔧 Казино на техническом обслуживании. Попробуйте позже.")
            return

        data = json.loads(message.web_app_data.data)

        # === Обработка админ-действий из Web App (только для ADMIN_IDS) ===
        # Админ может выполнять операции через скрытую панель в приложении
        action = data.get('action', '')
        if action.startswith('admin_'):
            if telegram_id not in ADMIN_IDS:
                logger.warning(f"Попытка админ-действия от не-админа: user={telegram_id}, action={action}")
                return

            # admin_maintenance_toggle: включить/выключить режим обслуживания
            if action == 'admin_maintenance_toggle':
                current = get_maintenance()
                set_maintenance(not current)
                state = "включён" if not current else "выключен"
                await message.answer(f"🔧 Режим обслуживания {state}.")
                logger.info(f"Admin {telegram_id}: maintenance {'on' if not current else 'off'}")
                return

            # admin_balance: установить баланс пользователю по ID (user_id, amount)
            if action == 'admin_balance':
                target_id = data.get('user_id')
                amount = data.get('amount')
                if target_id and amount is not None:
                    try:
                        target_id = int(target_id)
                        amount = float(amount)
                        if amount < 0:
                            await message.answer("❌ Баланс не может быть отрицательным.")
                            return
                        new_bal = set_balance(target_id, amount)
                        await message.answer(f"✅ Баланс пользователя {target_id} установлен: ${new_bal:,.2f}")
                        logger.info(f"Admin {telegram_id}: set balance user={target_id} amount={amount}")
                    except (ValueError, TypeError):
                        await message.answer("❌ Некорректные данные.")
                return

            # admin_refresh: пересчитать статистику админ-панели
            if action == 'admin_refresh':
                await message.answer("🔄 Данные обновлены. Перезайдите в приложение для актуальной статистики.")
                return

            return

        if data.get('type') == 'game_result':
            game_type = data.get('game', 'rocket')
            if game_type not in VALID_GAME_TYPES:
                logger.warning(f"Неизвестный тип игры от Web App: user={telegram_id}, game={game_type}")
                game_type = 'rocket'
            won = bool(data.get('won', False))

            # Принимаем от клиента только stake и multiplier — остальное считаем сами
            # (игрок может подделать выигрыш через devtools, но мы заново вычисляем)
            try:
                stake = float(data.get('stake', 0))
                multiplier = float(data.get('multiplier', 1.0))
            except (TypeError, ValueError):
                logger.warning(f"Некорректные числовые данные от Web App: user={telegram_id}, data={data}")
                return

            # Валидация ставки (должна быть положительной и не превышать MAX_STAKE)
            if stake <= 0 or stake > MAX_STAKE:
                logger.warning(f"Недопустимая ставка от Web App: user={telegram_id}, stake={stake}")
                return

            # Валидация множителя (должен быть > 0, защита от нулевого выигрыша при won=True и экстремальных значений)
            if multiplier <= 0 or multiplier > MAX_MULTIPLIER:
                logger.warning(f"Подозрительный множитель от Web App: user={telegram_id}, multiplier={multiplier}")
                return

            # Определяем кошелёк (main баланс или донатный баланс из Telegram Stars)
            wallet = data.get('wallet', 'main')
            use_donate = wallet == 'donate'

            # Проверяем достаточность баланса и списываем ставку одной БД-операцией
            # Возвращает (success, new_balance) — гарантирует, что ставка списалась или не списалась
            if use_donate:
                stake_int = int(stake)
                success, balance_after = update_donate_balance_checked(telegram_id, stake_int)
            else:
                success, balance_after = update_balance_checked(telegram_id, -stake)

            if not success:
                logger.warning(
                    f"Недостаточно средств у user={telegram_id}: "
                    f"wallet={wallet}, stake={stake}, balance={balance_after}"
                )
                return

            # Пересчитываем выигрыш на стороне бота (не доверяем клиенту)
            # Выигрыш = stake * multiplier, но только если won=true
            winnings = round(stake * multiplier, 2) if won else 0.0
            profit = winnings - stake

            # Начисляем выигрыш на тот же кошелёк, с которого была списана ставка
            if winnings > 0:
                if use_donate:
                    update_donate_balance(telegram_id, int(winnings))
                else:
                    update_balance(telegram_id, winnings)

            # Логируем результат в историю для статистики и аудита
            add_game(
                telegram_id=telegram_id,
                game_type=game_type,
                stake=stake,
                result='win' if won else 'lose',
                winnings=winnings,
                multiplier=multiplier
            )

            logger.info(
                f"Игра: {game_type}, User: {telegram_id}, Wallet: {wallet}, "
                f"Ставка: {stake}, Множитель: {multiplier}, Выигрыш: {winnings}, Win: {won}"
            )

    except json.JSONDecodeError as e:
        logger.error(f"Ошибка парсинга данных от Web App: {e}")
    except Exception as e:
        logger.error(f"Ошибка обработки данных Web App: {e}")


# === Команда Казино ===

@dp.message(Command("casino"))
@dp.message(F.text == "🎰 Казино")
async def cmd_casino(message: Message):
    """
    Команда /casino - быстрая игра в казино прямо в боте (не Web App).

    Логика:
    1. Парсим ставку из аргумента команды
    2. Выбираем множитель по весам (x0 с вероятностью 25% = проигрыш)
    3. Атомарно проверяем и списываем ставку за один запрос в БД
    4. Вычисляем выигрыш = stake * multiplier
    5. Зачисляем выигрыш (если есть)
    6. Логируем результат для статистики
    """
    # Проверка бана
    if is_user_banned(message.from_user.id):
        await message.answer("🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.")
        return

    # Проверка режима обслуживания
    if get_maintenance() and message.from_user.id not in ADMIN_IDS:
        await message.answer("🔧 Казино на техническом обслуживании. Попробуйте позже.")
        return

    try:
        args = message.text.split()

        # Кнопка "🎰 Казино" без аргумента — показываем справку
        if len(args) < 2 and message.text == "🎰 Казино":
            await message.answer(
                "❌ <b>Казино</b>\n\n"
                "Использование: <code>/casino <ставка></code>\n"
                "Пример: <code>/casino 100</code>\n\n"
                "🎰 Множители:\n"
                "❌ x0, x0.25, x0.5, x0.75\n"
                "✅ x1, x1.25, x1.5, x2, x5, x10, x15, x100"
            )
            return

        # Команда без аргумента
        if len(args) < 2:
            await message.answer("❌ Укажите ставку: /casino <сумма>")
            return

        stake = float(args[1])

        if stake <= 0:
            await message.answer("❌ Ставка должна быть больше 0")
            return

        if stake > MAX_STAKE:
            await message.answer(f"❌ Максимальная ставка: {MAX_STAKE:,}")
            return

        # Множители с весами (вероятностями)
        # Вероятность x0 = 25% (house edge)
        multipliers = [
            (0, 0.25),          # 25% проигрыш
            (0.25, 0.15),       # 15% небольшой проигрыш
            (0.5, 0.15),        # 15% проигрыш
            (0.75, 0.10),       # 10% малый проигрыш
            (1, 0.10),          # 10% хотя бы вернуть ставку
            (1.25, 0.08),       # 8% малый выигрыш
            (1.5, 0.07),        # 7%
            (2, 0.05),          # 5% двойной
            (5, 0.03),          # 3% 5x
            (10, 0.015),        # 1.5% 10x
            (15, 0.005),        # 0.5% 15x (редко)
            (100, 0.0005)       # 0.05% 100x (очень редко)
        ]

        # Выбираем множитель по случайному числу с учётом весов
        total_weight = sum(w for _, w in multipliers)
        rand = random.uniform(0, total_weight)

        cumulative = 0
        multiplier = 0
        for mult, weight in multipliers:
            cumulative += weight
            if rand <= cumulative:
                multiplier = mult
                break

        winnings = stake * multiplier
        profit = winnings - stake

        # Атомарно списываем ставку с проверкой баланса (один запрос)
        success, balance = update_balance_checked(message.from_user.id, -stake)
        if not success:
            await message.answer(f"❌ Недостаточно средств. Ваш баланс: ${balance:,.2f}")
            return

        # Начисляем выигрыш (если есть) отдельным запросом
        if winnings > 0:
            update_balance(message.from_user.id, winnings)

        # Логируем результат для статистики и аудита
        add_game(
            telegram_id=message.from_user.id,
            game_type='casino',
            stake=stake,
            result='win' if profit > 0 else 'lose',
            winnings=winnings,
            multiplier=multiplier
        )

        # Выбираем эмодзи в зависимости от результата
        if multiplier >= 2:
            emoji = "🎉"
        elif multiplier >= 1:
            emoji = "😐"
        else:
            emoji = "💀"

        result_text = (
            f"🎰 <b>Казино</b>\n\n"
            f"{emoji} Множитель: <b>x{multiplier}</b>\n\n"
            f"Ставка: ${stake:,.2f}\n"
            f"Выигрыш: ${winnings:,.2f}\n"
            f"{'✅' if profit >= 0 else '❌'} Профит: <b>${profit:,.2f}</b>"
        )

        await message.answer(result_text)

    except ValueError:
        await message.answer("❌ Неверный формат ставки. Используйте число.")
    except Exception as e:
        logger.error(f"Ошибка в казино: {e}")
        await message.answer("❌ Произошла ошибка. Попробуйте позже.")


# === Админ команды ===

@dp.message(Command("admin"))
async def cmd_admin(message: Message):
    """
    Команда /admin — открыть главное меню администратора.

    Проверка доступа: только ADMIN_IDS могут открыть меню.
    Отображает текущий статус (режим обслуживания).
    Показывает инлайн-клавиатуру с опциями: статистика, пользователи, баланс,
    рассылка, промо-коды, обслуживание, топ игроков.
    """
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("❌ У вас нет прав администратора.")
        return

    maint = get_maintenance()
    maint_status = "🟢 Работает" if not maint else "🔴 Обслуживание"

    await message.answer(
        f"🔧 <b>Панель администратора</b>\n\n"
        f"Статус: {maint_status}",
        reply_markup=get_admin_keyboard()
    )


# --- Статистика ---

@dp.callback_query(F.data == "admin_stats")
async def cb_admin_stats(callback_query: CallbackQuery):
    """Показать агрегированную статистику"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    s = get_admin_stats()

    games_text = ""
    for game_type, cnt in s["bets_by_game"].items():
        games_text += f"  {game_type}: <b>{cnt:,}</b>\n"
    if not games_text:
        games_text = "  нет данных\n"

    stats_text = (
        f"📊 <b>Статистика BFG Casino</b>\n\n"
        f"👥 Пользователей: <b>{s['total_users']:,}</b>\n"
        f"🆕 Новых сегодня: <b>{s['new_users_today']}</b>\n\n"
        f"🎮 Всего ставок: <b>{s['total_bets']:,}</b>\n"
        f"🎮 Ставок сегодня: <b>{s['bets_today']:,}</b>\n\n"
        f"💸 Всего поставлено: <b>{s['total_wagered']:,.0f}</b>\n"
        f"💰 Всего выиграно: <b>{s['total_won']:,.0f}</b>\n"
        f"{'🟢' if s['revenue'] >= 0 else '🔴'} Доход казино: <b>{s['revenue']:,.0f}</b>\n"
        f"{'🟢' if s['revenue_today'] >= 0 else '🔴'} Доход сегодня: <b>{s['revenue_today']:,.0f}</b>\n\n"
        f"🎯 <b>Ставки по играм:</b>\n{games_text}"
    )

    builder = InlineKeyboardBuilder()
    builder.button(text="🔙 Назад", callback_data="admin_back")
    await callback_query.message.edit_text(stats_text, reply_markup=builder.as_markup())
    await callback_query.answer()


# --- Пользователи ---

@dp.callback_query(F.data == "admin_users")
async def cb_admin_users(callback_query: CallbackQuery):
    """Показать пользователей с пагинацией (первая страница)"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return
    await _show_users_page(callback_query, offset=0)
    await callback_query.answer()


@dp.callback_query(F.data.startswith("admin_users_page_"))
async def cb_admin_users_page(callback_query: CallbackQuery):
    """Пагинация пользователей"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return
    offset = int(callback_query.data.split("_")[-1])
    await _show_users_page(callback_query, offset=offset)
    await callback_query.answer()


async def _show_users_page(callback_query: CallbackQuery, offset: int):
    """Вспомогательная функция: показать страницу пользователей."""
    page_size = 10
    users = get_all_users(limit=page_size, offset=offset)

    if not users and offset == 0:
        await callback_query.message.edit_text("👥 Пока нет пользователей.")
        return

    users_text = f"👥 <b>Пользователи</b> (с {offset + 1}):\n\n"
    for user in users:
        banned = " 🚫" if user.get("is_banned") else ""
        balance = user.get('balance') or 0
        username = html.escape(user.get('first_name') or 'N/A')
        users_text += (
            f"🆔 <code>{user['telegram_id']}</code> | "
            f"{username} | "
            f"${balance:,.0f}{banned}\n"
        )

    builder = InlineKeyboardBuilder()
    if offset > 0:
        builder.button(text="⬅️ Назад", callback_data=f"admin_users_page_{max(0, offset - page_size)}")
    if len(users) == page_size:
        builder.button(text="➡️ Далее", callback_data=f"admin_users_page_{offset + page_size}")
    builder.button(text="🔙 Меню", callback_data="admin_back")
    builder.adjust(2, 1)

    await callback_query.message.edit_text(users_text, reply_markup=builder.as_markup())


# --- Управление балансом (через FSM) ---

@dp.callback_query(F.data == "admin_balance")
async def cb_admin_balance(callback_query: CallbackQuery, state: FSMContext):
    """Запросить ID/username пользователя для изменения баланса"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    await state.set_state(AdminStates.waiting_for_user_id)
    await callback_query.message.edit_text(
        "💰 <b>Управление балансом</b>\n\n"
        "Введите Telegram ID или @username пользователя:"
    )
    await callback_query.answer()


@dp.message(StateFilter(AdminStates.waiting_for_user_id))
async def handle_admin_user_id(message: Message, state: FSMContext):
    """Обработать ввод ID/username для изменения баланса.

    StateFilter защищает от обработки сообщений пользователей, которые не в FSM-состоянии.
    Без StateFilter сообщение могло бы обработаться несколькими хендлерами одновременно.
    """
    if message.from_user.id not in ADMIN_IDS:
        await state.clear()
        return

    text = message.text.strip() if message.text else ""
    user = None

    if text.startswith("@"):
        user = get_user_by_username(text)
    elif text.isdigit():
        user = get_user(int(text))

    if not user:
        await message.answer("❌ Пользователь не найден. Попробуйте ещё раз:")
        return

    await state.update_data(target_user_id=user["telegram_id"])
    await state.set_state(AdminStates.waiting_for_amount)
    await message.answer(
        f"Пользователь: <b>{html.escape(user.get('first_name') or 'Unknown')}</b>\n"
        f"ID: <code>{user['telegram_id']}</code>\n"
        f"Баланс: <b>{user['balance']:,.0f}</b>\n\n"
        f"Введите новый баланс:"
    )


@dp.message(StateFilter(AdminStates.waiting_for_amount))
async def handle_admin_amount(message: Message, state: FSMContext):
    """Обработать ввод суммы для установки баланса.

    StateFilter защищает обработчик от активации при других состояниях FSM.
    """
    logger.info(f"handle_admin_amount triggered: user={message.from_user.id}, text={message.text!r}")
    if message.from_user.id not in ADMIN_IDS:
        await state.clear()
        return

    try:
        amount = float(message.text.strip())
    except (ValueError, TypeError, AttributeError):
        await message.answer("❌ Введите число:")
        return

    if amount < 0:
        await message.answer("❌ Баланс не может быть отрицательным:")
        return

    data = await state.get_data()
    target_id = data["target_user_id"]
    new_balance = set_balance(target_id, amount)
    await state.clear()

    await message.answer(
        f"✅ Баланс пользователя <code>{target_id}</code> установлен на <b>{new_balance:,.0f}</b>",
        reply_markup=get_admin_keyboard()
    )


# --- setbalance (для обратной совместимости) ---

@dp.message(Command("setbalance"))
async def cmd_setbalance(message: Message):
    """Установить баланс пользователю (админ)"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("❌ У вас нет прав администратора.")
        return

    try:
        args = message.text.split()
        if len(args) != 3:
            await message.answer("❌ Использование: /setbalance <user_id> <amount>")
            return

        user_id = int(args[1])
        amount = float(args[2])

        if amount < 0:
            await message.answer("❌ Баланс не может быть отрицательным.")
            return

        new_balance = set_balance(user_id, amount)
        await message.answer(f"✅ Баланс пользователя {user_id} установлен на ${new_balance:,.2f}")

    except (ValueError, IndexError):
        await message.answer("❌ Ошибка. Используйте: /setbalance <user_id> <amount>")


# --- Рассылка ---

@dp.callback_query(F.data == "admin_broadcast")
async def cb_admin_broadcast(callback_query: CallbackQuery, state: FSMContext):
    """Запросить текст рассылки"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    await state.set_state(AdminStates.waiting_for_broadcast_text)
    await callback_query.message.edit_text(
        "📢 <b>Рассылка</b>\n\n"
        "Введите текст сообщения для всех пользователей (HTML-разметка поддерживается):"
    )
    await callback_query.answer()


@dp.message(StateFilter(AdminStates.waiting_for_broadcast_text))
async def handle_broadcast_text(message: Message, state: FSMContext):
    """Подтверждение и отправка рассылки.

    StateFilter гарантирует, что хендлер срабатывает только когда пользователь находится
    в ожидании ввода текста рассылки (управление FSM-переходами).
    """
    if message.from_user.id not in ADMIN_IDS:
        await state.clear()
        return

    text = message.text or message.caption or ""
    if not text.strip():
        await message.answer("❌ Текст не может быть пустым:")
        return

    await state.clear()

    users = get_all_users(limit=100000)
    sent = 0
    failed = 0

    await message.answer(f"📢 Начинаю рассылку для {len(users)} пользователей...")

    for user in users:
        if user.get("is_banned"):
            continue
        try:
            await bot.send_message(user["telegram_id"], text, parse_mode="HTML")
            sent += 1
        except Exception:
            failed += 1
        await asyncio.sleep(0.05)  # throttling: ~20 msg/sec, защита от rate limit Telegram

    await message.answer(
        f"📢 <b>Рассылка завершена</b>\n\n"
        f"✅ Отправлено: {sent}\n"
        f"❌ Не доставлено: {failed}",
        reply_markup=get_admin_keyboard()
    )


# --- Промо-коды ---

@dp.callback_query(F.data == "admin_promos")
async def cb_admin_promos(callback_query: CallbackQuery):
    """Список промо-кодов"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    promos = get_promos()

    text = "🎁 <b>Промо-коды</b>\n\n"
    if promos:
        for p in promos:
            text += (
                f"<code>{p['code']}</code> | "
                f"+{p['bonus']:,} монет | "
                f"{p['used_count']}/{p['max_uses']} исп.\n"
            )
    else:
        text += "Промо-кодов пока нет.\n"

    builder = InlineKeyboardBuilder()
    builder.button(text="➕ Создать промо", callback_data="admin_create_promo")
    builder.button(text="🔙 Назад", callback_data="admin_back")
    builder.adjust(1)

    await callback_query.message.edit_text(text, reply_markup=builder.as_markup())
    await callback_query.answer()


@dp.callback_query(F.data == "admin_create_promo")
async def cb_admin_create_promo(callback_query: CallbackQuery, state: FSMContext):
    """Начать создание промо-кода"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    await state.set_state(AdminStates.waiting_for_promo_code)
    await callback_query.message.edit_text(
        "🎁 <b>Создание промо-кода</b>\n\n"
        "Введите код (латинские буквы и цифры):"
    )
    await callback_query.answer()


@dp.message(StateFilter(AdminStates.waiting_for_promo_code))
async def handle_promo_code_input(message: Message, state: FSMContext):
    """Обработать ввод кода промо.

    StateFilter ограничивает обработку только сообщениями, когда пользователь в FSM-состоянии
    ввода кода промо (отклоняет остальные команды и сообщения).
    """
    if message.from_user.id not in ADMIN_IDS:
        await state.clear()
        return

    code = (message.text or "").strip().upper()
    if not code or not code.isalnum():
        await message.answer("❌ Код должен содержать только латинские буквы и цифры:")
        return

    await state.update_data(promo_code=code)
    await state.set_state(AdminStates.waiting_for_promo_bonus)
    await message.answer(f"Код: <code>{code}</code>\n\nВведите бонус (количество монет):")


@dp.message(StateFilter(AdminStates.waiting_for_promo_bonus))
async def handle_promo_bonus_input(message: Message, state: FSMContext):
    """Обработать ввод бонуса промо.

    StateFilter гарантирует, что сообщение обрабатывается только в правильном FSM-состоянии.
    """
    if message.from_user.id not in ADMIN_IDS:
        await state.clear()
        return

    try:
        bonus = int(message.text.strip())
    except (ValueError, TypeError, AttributeError):
        await message.answer("❌ Введите целое число:")
        return

    if bonus <= 0:
        await message.answer("❌ Бонус должен быть больше 0:")
        return

    await state.update_data(promo_bonus=bonus)
    await state.set_state(AdminStates.waiting_for_promo_max_uses)
    await message.answer(f"Бонус: <b>{bonus:,} монет</b>\n\nВведите максимальное количество использований:")


@dp.message(StateFilter(AdminStates.waiting_for_promo_max_uses))
async def handle_promo_max_uses_input(message: Message, state: FSMContext):
    """Обработать ввод макс. использований и создать промо.

    StateFilter защищает обработчик от обработки сообщений вне правильного FSM-состояния.
    """
    if message.from_user.id not in ADMIN_IDS:
        await state.clear()
        return

    try:
        max_uses = int(message.text.strip())
    except (ValueError, TypeError, AttributeError):
        await message.answer("❌ Введите целое число:")
        return

    if max_uses <= 0:
        await message.answer("❌ Количество должно быть больше 0:")
        return

    data = await state.get_data()
    await state.clear()

    code = data["promo_code"]
    bonus = data["promo_bonus"]

    if create_promo(code, bonus, max_uses):
        await message.answer(
            f"✅ Промо-код создан!\n\n"
            f"Код: <code>{code}</code>\n"
            f"Бонус: <b>{bonus:,} монет</b>\n"
            f"Макс. использований: <b>{max_uses}</b>",
            reply_markup=get_admin_keyboard()
        )
    else:
        await message.answer(
            f"❌ Промо-код <code>{code}</code> уже существует.",
            reply_markup=get_admin_keyboard()
        )


# --- /promo для всех пользователей ---

@dp.message(Command("promo"))
async def cmd_promo(message: Message):
    """
    Команда /promo CODE — использовать промо-код пользователем.

    Использование: /promo BONUS100

    Логика:
    - Проверяет, не забанен ли пользователь
    - Парсит код из аргументов
    - Вызывает use_promo для активации (с проверкой лимитов и дублей)
    - Показывает результат (успех или причину отказа)

    Доступна для всех пользователей.
    """
    if is_user_banned(message.from_user.id):
        await message.answer("🚫 Ваш аккаунт заблокирован.")
        return

    args = message.text.split()
    if len(args) < 2:
        await message.answer("❌ Использование: /promo <код>\nПример: /promo BONUS100")
        return

    code = args[1].strip()
    success, msg = use_promo(message.from_user.id, code)

    if success:
        await message.answer(f"🎁 <b>Промо-код активирован!</b>\n\n{msg}")
    else:
        await message.answer(f"❌ {msg}")


# --- Режим обслуживания ---

@dp.callback_query(F.data == "admin_maintenance")
async def cb_admin_maintenance(callback_query: CallbackQuery):
    """Переключить режим обслуживания"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    current = get_maintenance()
    set_maintenance(not current)
    new_state = not current

    status = "🔴 ВКЛЮЧЕН" if new_state else "🟢 ВЫКЛЮЧЕН"
    await callback_query.message.edit_text(
        f"🔧 <b>Режим обслуживания</b>\n\n"
        f"Статус: {status}\n\n"
        f"{'Пользователи не смогут играть (кроме админов).' if new_state else 'Казино работает в обычном режиме.'}",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🔙 Назад", callback_data="admin_back")]
        ])
    )
    await callback_query.answer()


# --- Бан / Разбан ---

@dp.callback_query(F.data.startswith("admin_ban_"))
async def cb_admin_ban(callback_query: CallbackQuery):
    """Забанить пользователя"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    try:
        user_id = int(callback_query.data.replace("admin_ban_", ""))
    except ValueError:
        await callback_query.answer("❌ Некорректный ID", show_alert=True)
        return
    ban_user(user_id, True)
    await callback_query.answer(f"🚫 Пользователь {user_id} забанен", show_alert=True)


@dp.callback_query(F.data.startswith("admin_unban_"))
async def cb_admin_unban(callback_query: CallbackQuery):
    """Разбанить пользователя"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    try:
        user_id = int(callback_query.data.replace("admin_unban_", ""))
    except ValueError:
        await callback_query.answer("❌ Некорректный ID", show_alert=True)
        return
    ban_user(user_id, False)
    await callback_query.answer(f"✅ Пользователь {user_id} разбанен", show_alert=True)


# --- Топ игроков ---

@dp.callback_query(F.data == "admin_top")
async def cb_admin_top(callback_query: CallbackQuery):
    """Топ игроков из админ-панели"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    lb = get_leaderboard()

    balance_lines = ""
    for i, p in enumerate(lb["top_balance"], 1):
        balance_lines += f"  {i}. {fmt_name(p)} — <b>${p['balance']:,.0f}</b>\n"
    if not balance_lines:
        balance_lines = "  нет данных\n"

    games_lines = ""
    for i, p in enumerate(lb["top_games"], 1):
        games_lines += f"  {i}. {fmt_name(p)} — <b>{p['game_count']} игр</b>\n"
    if not games_lines:
        games_lines = "  нет данных\n"

    text = (
        f"🏆 <b>Топ игроков</b>\n\n"
        f"💰 <b>По балансу:</b>\n{balance_lines}\n"
        f"🎮 <b>По играм:</b>\n{games_lines}"
    )

    builder = InlineKeyboardBuilder()
    builder.button(text="🔙 Назад", callback_data="admin_back")
    await callback_query.message.edit_text(text, reply_markup=builder.as_markup())
    await callback_query.answer()


# --- Кнопка "Назад" в админ-панели ---

@dp.callback_query(F.data == "admin_back")
async def cb_admin_back(callback_query: CallbackQuery):
    """Вернуться в главное меню админ-панели"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    maint = get_maintenance()
    maint_status = "🟢 Работает" if not maint else "🔴 Обслуживание"

    await callback_query.message.edit_text(
        f"🔧 <b>Панель администратора</b>\n\n"
        f"Статус: {maint_status}",
        reply_markup=get_admin_keyboard()
    )
    await callback_query.answer()


@dp.message(Command("stats"))
async def cmd_stats(message: Message):
    """Расширенная статистика для администраторов"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("❌ У вас нет прав администратора.")
        return

    s = get_global_stats()

    top = ""
    for i, p in enumerate(s["top_players"], 1):
        top += f"  {i}. {fmt_name(p)} — {p['game_count']} игр\n"
    if not top:
        top = "  нет данных\n"

    text = (
        f"📊 <b>Статистика BFG Casino</b>\n\n"
        f"👥 Пользователей: <b>{s['total_users']}</b>\n"
        f"🎮 Всего игр: <b>{s['total_games']}</b>\n\n"
        f"🏆 <b>Топ-3 игрока:</b>\n{top}\n"
        f"💸 Донатов: <b>{s['total_donations']}</b> "
        f"на <b>{s['total_stars']:,} ⭐</b>"
    )
    await message.answer(text)


@dp.message(Command("leaderboard"))
async def cmd_leaderboard(message: Message):
    """Топ-5 игроков по балансу и по количеству игр"""
    lb = get_leaderboard()

    balance_lines = ""
    for i, p in enumerate(lb["top_balance"], 1):
        balance_lines += f"  {i}. {fmt_name(p)} — <b>${p['balance']:,.0f}</b>\n"
    if not balance_lines:
        balance_lines = "  нет данных\n"

    games_lines = ""
    for i, p in enumerate(lb["top_games"], 1):
        games_lines += f"  {i}. {fmt_name(p)} — <b>{p['game_count']} игр</b>\n"
    if not games_lines:
        games_lines = "  нет данных\n"

    text = (
        f"🏆 <b>Топ игроков</b>\n\n"
        f"💰 <b>По балансу:</b>\n{balance_lines}\n"
        f"🎮 <b>По играм:</b>\n{games_lines}"
    )
    await message.answer(text)


# === Донаты / пополнение баланса ===

# Варианты пополнения: (сумма в звёздах, подпись)
DONATE_OPTIONS = [
    (50,   "50 ⭐ → 500 монет"),
    (100,  "100 ⭐ → 1 000 монет"),
    (250,  "250 ⭐ → 2 500 монет"),
    (500,  "500 ⭐ → 5 000 монет"),
    (1000, "1 000 ⭐ → 10 000 монет"),
]


def get_donate_keyboard() -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    for amount_stars, label in DONATE_OPTIONS:
        builder.button(text=label, callback_data=f"donate_{amount_stars}")
    builder.button(text="✏️ Своя сумма", callback_data="donate_custom")
    builder.adjust(1)
    return builder.as_markup()


@dp.message(Command("donate"))
@dp.message(F.text == "💳 Пополнить")
async def cmd_donate(message: Message, state: FSMContext):
    """
    Показать меню пополнения баланса через Telegram Stars (XTR).

    Логика:
    1. Очищаем FSM-состояние (на случай прерванного ввода)
    2. Показываем клавиатуру с готовыми вариантами (50⭐, 100⭐, 250⭐, 500⭐, 1000⭐)
    3. Или кнопку "Своя сумма" для ввода произвольной суммы (минимум 1, максимум 2500)
    4. Пользователь выбирает сумму → создаётся инвойс (Telegram Bot API)
    5. Telegram показывает встроенную форму оплаты

    После успешного платежа:
    - Telegram отправляет successful_payment обработчику handle_successful_payment
    - Там записывается пополнение и зачисляются монеты на donate_balance
    """
    await state.clear()
    await message.answer(
        "⭐ <b>Пополнение баланса</b>\n\n"
        f"1 звезда = {COINS_PER_STAR:,} монет\n\n"
        "Выберите сумму пополнения:",
        reply_markup=get_donate_keyboard(),
        parse_mode='HTML'
    )


@dp.callback_query(F.data == "donate_custom")
async def cb_donate_custom(callback_query: CallbackQuery, state: FSMContext):
    """
    Переход к вводу произвольной суммы звёзд.

    Логика:
    - Устанавливаем FSM-состояние waiting_for_custom_amount
    - Бот ждёт сообщения с числом
    """
    await state.set_state(DonateStates.waiting_for_custom_amount)
    await callback_query.message.answer(
        "✏️ <b>Произвольная сумма</b>\n\n"
        "Введите количество звёзд (минимум 1, максимум 2500):",
        parse_mode='HTML'
    )
    await callback_query.answer()


@dp.message(DonateStates.waiting_for_custom_amount)
async def handle_custom_amount(message: Message, state: FSMContext):
    """
    Обработать введённую пользователем произвольную сумму звёзд.

    Логика:
    - Валидируем, что это целое число (1-2500)
    - Выходим из FSM-состояния
    - Создаём инвойс с введённой суммой
    """
    text = message.text.strip() if message.text else ""

    if not text.isdigit():
        await message.answer("❌ Введите целое число. Попробуйте ещё раз:")
        return

    amount_stars = int(text)

    if amount_stars < 1 or amount_stars > 2500:
        await message.answer("❌ Сумма должна быть от 1 до 2500 звёзд. Попробуйте ещё раз:")
        return

    await state.clear()

    await send_donate_invoice(message, message.from_user.id, amount_stars)


@dp.callback_query(F.data.startswith("donate_"))
async def cb_donate_amount(callback_query: CallbackQuery):
    """
    Создать инвойс на выбранную сумму в Telegram Stars.

    Логика:
    - Парсим сумму из callback_data (donate_<stars>)
    - Вычисляем количество монет для зачисления
    - Создаём инвойс (Telegram Bot API)
    - Пользователь подтверждает платёж в встроенной форме Telegram
    """
    try:
        amount_stars = int(callback_query.data.split("_")[1])
    except (IndexError, ValueError):
        await callback_query.answer("Ошибка", show_alert=True)
        return

    if amount_stars <= 0 or amount_stars > 2500:
        await callback_query.answer("Неверная сумма", show_alert=True)
        return

    await send_donate_invoice(callback_query.message, callback_query.from_user.id, amount_stars)
    await callback_query.answer()


@dp.pre_checkout_query()
async def handle_pre_checkout(pre_checkout_query: PreCheckoutQuery):
    """
    Подтвердить платёж (вызывается Telegram перед списанием звёзд).

    Логика:
    - Проверяем payload на формат "donate_<stars>_<user_id>"
    - Это защита от фальшивых платежей через API
    - Если формат неверный — отклоняем платёж
    """
    # Проверяем payload — должен начинаться с "donate_"
    if not pre_checkout_query.invoice_payload.startswith("donate_"):
        await pre_checkout_query.answer(ok=False, error_message="Неверный платёж")
        return

    # Принимаем платёж (Telegram может отправить несколько pre_checkout, но финальная обработка в successful_payment)
    await pre_checkout_query.answer(ok=True)


@dp.message(F.successful_payment)
async def handle_successful_payment(message: Message):
    """
    Обработать успешный платёж Telegram Stars (XTR) и зачислить монеты на донатный баланс.

    Архитектура (защита от двойного начисления):
    1. Извлекаем количество звёзд из payload платежа ("donate_<stars>_<user_id>")
    2. Конвертируем звёзды в игровые монеты: coins = amount_stars * COINS_PER_STAR
    3. Вызываем add_donation() — одна БД-транзакция:
       - INSERT в таблицу donations (с UNIQUE constraint на telegram_payment_charge_id)
       - UPDATE donate_balance пользователя на +coins
       - RETURNING новый баланс
    4. Если платёж дубль (Telegram отправил webhook дважды):
       - UNIQUE constraint на telegram_payment_charge_id сработает
       - ROLLBACK откатит обе операции (INSERT + UPDATE)
       - Исключение Exception будет перехвачено в блоке except
    5. Отправляем пользователю подтверждение с новым балансом

    Защита от дублей:
    - telegram_payment_charge_id — уникальный ID платежа от Telegram (может быть одинаковым при webhook дублировании)
    - UNIQUE constraint на этом поле предотвращает двойное начисление
    - Благодаря транзакции, если constraint срабатывает, не будет полусостояний (монеты + не записалось в donations)

    Примечание: На практике Telegram редко отправляет webhook дважды, но это бывает при сетевых сбоях.
    """
    payment = message.successful_payment
    telegram_id = message.from_user.id

    try:
        # Извлекаем количество звёзд из payload ("donate_<stars>_<user_id>")
        parts = payment.invoice_payload.split("_")
        amount_stars = int(parts[1])
    except (IndexError, ValueError):
        logger.error(f"Неверный payload платежа: {payment.invoice_payload}")
        await message.answer("❌ Ошибка обработки платежа. Обратитесь к администратору.")
        return

    if amount_stars <= 0:
        logger.error(f"Нулевое или отрицательное кол-во звёзд в payload: {payment.invoice_payload}")
        return

    # Конвертируем звёзды в игровые монеты (коэффициент из конфига)
    coins = amount_stars * COINS_PER_STAR

    try:
        # add_donation — одна транзакция с INSERT в donations и UPDATE donate_balance
        new_balance = add_donation(
            telegram_id=telegram_id,
            telegram_payment_charge_id=payment.telegram_payment_charge_id,
            provider_payment_charge_id=payment.provider_payment_charge_id,
            amount_rub=amount_stars,  # переиспользуем для хранения звёзд (не рубли)
            coins_credited=coins,
        )
        logger.info(
            f"Пополнение Stars: user={telegram_id}, {amount_stars} ⭐, {coins} монет, "
            f"charge_id={payment.telegram_payment_charge_id}"
        )
        await message.answer(
            f"✅ <b>Баланс пополнен!</b>\n\n"
            f"Оплачено: <b>{amount_stars} ⭐</b>\n"
            f"Зачислено: <b>{coins:,} монет</b>\n"
            f"⭐ Донатный баланс: <b>{new_balance:,} монет</b>",
            parse_mode='HTML'
        )
    except Exception as e:
        # UNIQUE constraint на telegram_payment_charge_id защищает от двойного зачисления
        # Если Telegram отправил webhook дважды, UNIQUE вызовет исключение, откатится вся транзакция
        logger.error(f"Ошибка зачисления доната user={telegram_id}: {e}")
        await message.answer("❌ Ошибка зачисления. Обратитесь к администратору.")


# === Запуск бота ===

async def on_startup():
    """При запуске бота"""
    logger.info("✅ Бот запущен!")
    logger.info(f"💾 База данных: {DB_PATH}")
    await start_api_server()
    
    await bot.set_chat_menu_button(
        menu_button=MenuButtonWebApp(
            text="🎮 Играть",
            web_app=WebAppInfo(url=WEB_APP_URL)
        )
    )


async def on_shutdown():
    """При остановке бота"""
    logger.info("👋 Бот остановлен!")


if __name__ == "__main__":
    dp.startup.register(on_startup)
    dp.shutdown.register(on_shutdown)
    try:
        dp.run_polling(bot)
    except KeyboardInterrupt:
        logger.info("Бот остановлен пользователем")
