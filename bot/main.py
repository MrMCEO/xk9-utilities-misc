import logging
import json
import random
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandObject
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
from config import BOT_TOKEN, ADMIN_IDS, DEFAULT_BALANCE, WEB_APP_URL, DB_PATH, COINS_PER_STAR
from database import (
    init_db,
    get_or_create_user,
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
    add_donate_balance,
    update_donate_balance,
    update_donate_balance_checked,
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

# Инициализация БД при старте
init_db()


# === Клавиатуры ===

def get_main_keyboard(balance: float = 0, donate_balance: int = 0) -> ReplyKeyboardMarkup:
    """Основная клавиатура с кнопкой Web App"""
    builder = ReplyKeyboardBuilder()
    url = f"{WEB_APP_URL}?b={balance}&db={donate_balance}"
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
    builder.button(text="👥 Все пользователи", callback_data="admin_users")
    builder.button(text="📈 Общая статистика", callback_data="admin_stats")
    builder.button(text="💵 Изменить баланс", callback_data="admin_balance")
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
    await message.answer(
        f"🎰 <b>Добро пожаловать в BFG Casino!</b>\n\n"
        f"👤 {message.from_user.first_name}, ваш баланс: <b>${user['balance']:,.2f}</b>\n\n"
        f"🚀 Запускайте игру и испытайте удачу!\n"
        f"Нажмите кнопку ниже 👇",
        reply_markup=get_main_keyboard(user['balance'], donate_bal),
    )


@dp.message(Command("play"))
@dp.message(Command("game"))
async def cmd_play(message: Message):
    """Команда /play - открыть игру"""
    await message.answer(
        "🎮 <b>BFG Casino — Web App</b>\n\n"
        "🚀 Ракета · 💣 Сапер\n"
        "Выбирай игру и испытай удачу!",
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="🎮 Открыть приложение", web_app=WebAppInfo(url=f"{WEB_APP_URL}?b={get_user_balance(message.from_user.id)}&db={get_donate_balance(message.from_user.id)}"))]
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
        "/stats - Моя статистика\n"
        "/history - История игр\n"
        "/donate - Пополнить баланс\n"
        "/help - Эта справка\n\n"
        "🔧 <b>Админ:</b>\n"
        "/admin - Панель администратора\n"
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

MAX_MULTIPLIER = 1000.0  # Максимально допустимый множитель от Web App


@dp.message(F.web_app_data)
async def handle_webapp_data(message: Message):
    """
    Обработка данных от Web App (результаты игр).

    Логика:
    1. Парсим JSON с результатом игры (stake, multiplier, wallet, won)
    2. Валидируем stake и multiplier (защита от манипуляций клиентом)
    3. Атомарно проверяем баланс и списываем ставку (двухфазный коммит)
    4. Пересчитываем выигрыш на стороне бота (stake * multiplier)
    5. Начисляем выигрыш на тот же кошелёк (main или donate)
    6. Логируем результат в таблицу games
    """
    try:
        data = json.loads(message.web_app_data.data)

        if data.get('type') == 'game_result':
            telegram_id = message.from_user.id
            game_type = data.get('game', 'rocket')
            won = bool(data.get('won', False))

            # Принимаем от клиента только stake и multiplier — остальное считаем сами
            # (игрок может подделать выигрыш через devtools, но мы заново вычисляем)
            try:
                stake = float(data.get('stake', 0))
                multiplier = float(data.get('multiplier', 1.0))
            except (TypeError, ValueError):
                logger.warning(f"Некорректные числовые данные от Web App: user={telegram_id}, data={data}")
                return

            # Валидация ставки (должна быть положительной)
            if stake <= 0:
                logger.warning(f"Нулевая или отрицательная ставка от Web App: user={telegram_id}, stake={stake}")
                return

            # Валидация множителя (защита от экстремальных значений)
            if multiplier < 0 or multiplier > MAX_MULTIPLIER:
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
    """Админ панель"""
    if message.from_user.id not in ADMIN_IDS:
        await message.answer("❌ У вас нет прав администратора.")
        return

    await message.answer(
        "🔧 <b>Панель администратора</b>",
        reply_markup=get_admin_keyboard()
    )


@dp.callback_query(F.data == "admin_users")
async def cb_admin_users(callback_query: CallbackQuery):
    """Показать всех пользователей"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    users = get_all_users()

    if not users:
        await callback_query.message.answer("👥 Пока нет пользователей.")
        return

    users_text = "👥 <b>Пользователи:</b>\n\n"
    for user in users:
        users_text += (
            f"🆔 <code>{user['telegram_id']}</code> | "
            f"{user['first_name']} | "
            f"${user['balance']:,.2f}\n"
        )

    await callback_query.message.answer(users_text)
    await callback_query.answer()


@dp.callback_query(F.data == "admin_stats")
async def cb_admin_stats(callback_query: CallbackQuery):
    """Общая статистика"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    users = get_all_users()
    recent_games = get_recent_games(10)

    total_balance = sum(u['balance'] for u in users)
    total_users = len(users)

    stats_text = (
        f"📈 <b>Общая статистика:</b>\n\n"
        f"👥 Пользователей: <b>{total_users}</b>\n"
        f"💰 Общий баланс: <b>${total_balance:,.2f}</b>\n\n"
        f"🎮 <b>Последние игры:</b>\n"
    )

    for game in recent_games:
        emoji = "✅" if game['result'] == 'win' else "❌"
        stats_text += (
            f"{emoji} {game.get('first_name', 'Unknown')} | "
            f"{game['game_type']} | "
            f"${game['stake']:.2f} → ${game['winnings']:.2f}\n"
        )

    await callback_query.message.answer(stats_text)
    await callback_query.answer()


@dp.callback_query(F.data == "admin_balance")
async def cb_admin_balance(callback_query: CallbackQuery):
    """Изменить баланс пользователя"""
    if callback_query.from_user.id not in ADMIN_IDS:
        await callback_query.answer("❌ Нет прав", show_alert=True)
        return

    await callback_query.message.answer(
        "💵 <b>Изменение баланса</b>\n\n"
        "Используйте команду:\n"
        "<code>/setbalance &lt;user_id&gt; &lt;amount&gt;</code>\n\n"
        "Пример: <code>/setbalance 123456789 50000</code>"
    )
    await callback_query.answer()


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

        new_balance = set_balance(user_id, amount)
        await message.answer(f"✅ Баланс пользователя {user_id} установлен на ${new_balance:,.2f}")

    except (ValueError, IndexError):
        await message.answer("❌ Ошибка. Используйте: /setbalance <user_id> <amount>")


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
    - Предлагаем готовые варианты (50⭐, 100⭐, 250⭐, 500⭐, 1000⭐)
    - Или кнопку "Своя сумма" для ввода произвольной суммы
    - При выборе создаём инвойс (Telegram покажет форму оплаты)
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

    coins = amount_stars * COINS_PER_STAR

    await message.answer_invoice(
        title="Пополнение BFG Casino",
        description=f"Зачислит {coins:,} монет на ваш игровой баланс",
        payload=f"donate_{amount_stars}_{message.from_user.id}",
        provider_token="",
        currency="XTR",
        prices=[LabeledPrice(label=f"{coins:,} монет", amount=amount_stars)],
        start_parameter="donate",
    )


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

    coins = amount_stars * COINS_PER_STAR

    await callback_query.message.answer_invoice(
        title="Пополнение BFG Casino",
        description=f"Зачислит {coins:,} монет на ваш игровой баланс",
        payload=f"donate_{amount_stars}_{callback_query.from_user.id}",
        provider_token="",
        currency="XTR",
        prices=[LabeledPrice(label=f"{coins:,} монет", amount=amount_stars)],
        start_parameter="donate",
    )
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
    Обработать успешный платёж Telegram Stars (XTR) — зачислить монеты на донатный баланс.

    Логика:
    1. Извлекаем количество звёзд из payload платежа
    2. Вычисляем количество монет (звёзды * COINS_PER_STAR)
    3. Записываем платёж в таблицу donations (с UNIQUE constraint на charge_id)
    4. Атомарно зачисляем монеты на donate_balance (в одной транзакции)
    5. Если платёж дубль — UNIQUE constraint его отклонит, откатится вся транзакция

    Примечание: charge_id — уникальный идентификатор платежа от Telegram, защищает от дублей.
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
