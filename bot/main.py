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

def get_main_keyboard() -> ReplyKeyboardMarkup:
    """Основная клавиатура с кнопкой Web App"""
    builder = ReplyKeyboardBuilder()
    builder.button(text="🎮 Запустить приложение", web_app=WebAppInfo(url=WEB_APP_URL))
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
    """Команда /start - приветствие и авторизация. Поддерживает deep link ?start=donate"""
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

    await message.answer(
        f"🎰 <b>Добро пожаловать в BFG Casino!</b>\n\n"
        f"👤 {message.from_user.first_name}, ваш баланс: <b>${user['balance']:,.2f}</b>\n\n"
        f"🚀 Запускайте игру и испытайте удачу!\n"
        f"Нажмите кнопку ниже 👇",
        reply_markup=get_main_keyboard(),
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
            [InlineKeyboardButton(text="🎮 Открыть приложение", web_app=WebAppInfo(url=WEB_APP_URL))]
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
async def cmd_balance(message: Message):
    """Показать баланс"""
    balance = get_user_balance(message.from_user.id)
    await message.answer(f"💰 <b>Ваш баланс:</b> ${balance:,.2f}")


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

@dp.message(F.web_app_data)
async def handle_webapp_data(message: Message):
    """Обработка данных от Web App (результаты игр)"""
    try:
        data = json.loads(message.web_app_data.data)
        
        if data.get('type') == 'game_result':
            telegram_id = message.from_user.id
            game_type = data.get('game', 'rocket')
            stake = float(data.get('stake', 0))
            won = data.get('won', False)
            totalWinnings = float(data.get('winnings', 0))
            profit = data.get('profit', 0)
            multiplier = data.get('multiplier', 1.0)
            
            add_game(
                telegram_id=telegram_id,
                game_type=game_type,
                stake=stake,
                result='win' if won else 'lose',
                winnings=totalWinnings,
                multiplier=multiplier
            )
            
            if won:
                update_balance(telegram_id, profit)
            else:
                update_balance(telegram_id, -stake)
            
            logger.info(
                f"Игра: {game_type}, User: {telegram_id}, "
                f"Ставка: {stake}, Выигрыш: {totalWinnings}, Win: {won}"
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
    Команда /casino - игра в казино
    Использование: /casino <ставка>
    """
    try:
        args = message.text.split()
        
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
        
        if len(args) < 2:
            await message.answer("❌ Укажите ставку: /casino <сумма>")
            return

        stake = float(args[1])

        if stake <= 0:
            await message.answer("❌ Ставка должна быть больше 0")
            return

        # Множители с весами
        multipliers = [
            (0, 0.25),
            (0.25, 0.15),
            (0.5, 0.15),
            (0.75, 0.10),
            (1, 0.10),
            (1.25, 0.08),
            (1.5, 0.07),
            (2, 0.05),
            (5, 0.03),
            (10, 0.015),
            (15, 0.005),
            (100, 0.0005)
        ]

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

        # Атомарное списание ставки с проверкой баланса (один запрос в БД)
        success, balance = update_balance_checked(message.from_user.id, -stake)
        if not success:
            await message.answer(f"❌ Недостаточно средств. Ваш баланс: ${balance:,.2f}")
            return

        # Начисляем выигрыш если есть (один запрос вместо двух)
        if winnings > 0:
            update_balance(message.from_user.id, winnings)

        add_game(
            telegram_id=message.from_user.id,
            game_type='casino',
            stake=stake,
            result='win' if profit > 0 else 'lose',
            winnings=winnings,
            multiplier=multiplier
        )

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
    """Показать меню пополнения баланса через Telegram Stars"""
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
    """Запросить произвольную сумму звёзд"""
    await state.set_state(DonateStates.waiting_for_custom_amount)
    await callback_query.message.answer(
        "✏️ <b>Произвольная сумма</b>\n\n"
        "Введите количество звёзд (минимум 1, максимум 2500):",
        parse_mode='HTML'
    )
    await callback_query.answer()


@dp.message(DonateStates.waiting_for_custom_amount)
async def handle_custom_amount(message: Message, state: FSMContext):
    """Обработать введённую пользователем произвольную сумму звёзд"""
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
    """Создать инвойс на выбранную сумму в Telegram Stars"""
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
    """Подтвердить платёж (вызывается Telegram перед списанием)"""
    # Проверяем payload — должен начинаться с "donate_"
    if not pre_checkout_query.invoice_payload.startswith("donate_"):
        await pre_checkout_query.answer(ok=False, error_message="Неверный платёж")
        return

    await pre_checkout_query.answer(ok=True)


@dp.message(F.successful_payment)
async def handle_successful_payment(message: Message):
    """Обработать успешный платёж Stars — зачислить монеты на баланс"""
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

    coins = amount_stars * COINS_PER_STAR

    try:
        new_balance = add_donation(
            telegram_id=telegram_id,
            telegram_payment_charge_id=payment.telegram_payment_charge_id,
            provider_payment_charge_id=payment.provider_payment_charge_id,
            amount_rub=amount_stars,  # поле переиспользуем для хранения звёзд
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
            f"Текущий баланс: <b>${new_balance:,.2f}</b>",
            parse_mode='HTML'
        )
    except Exception as e:
        # UNIQUE constraint на charge_id защищает от двойного зачисления
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
